// Contact page + realtime live chat + team inbox.
// One Node process: Express serves the pages, Socket.IO carries the chat, SQLite keeps the history.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from './db.js';
import {
  makeClientIp, rateKey, makeLimiter, cleanText, EMAIL_RE, UUID_RE, isPlainObject,
  webhookSafe, securityHeaders, makeOriginCheck,
} from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');

// ---------- Configuration (environment variables) ----------
const env = process.env;
const PRODUCTION = env.NODE_ENV === 'production';
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || '0.0.0.0';
const DB_FILE = env.DB_FILE || join(ROOT, '.data', 'chat.db');
const DEMO_PASSWORD = 'plumb-demo';
const INBOX_PASSWORD = env.INBOX_PASSWORD || DEMO_PASSWORD;
const SESSION_SECRET = env.SESSION_SECRET || randomBytes(32).toString('hex');
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, '');
const NOTIFY_WEBHOOK_URL = /^https:\/\//.test(env.NOTIFY_WEBHOOK_URL || '') ? env.NOTIFY_WEBHOOK_URL : '';
const TRUST_PROXY = Number.isFinite(Number(env.TRUST_PROXY)) && env.TRUST_PROXY !== '' ? Number(env.TRUST_PROXY) : 1;
const CLIENT_IP_HEADER = env.CLIENT_IP_HEADER || '';
const ALLOWED_ORIGINS = [PUBLIC_URL, ...(env.ALLOWED_ORIGINS || '').split(',')].map((s) => s.trim()).filter(Boolean);
const SESSION_DAYS = Math.min(Math.max(Number(env.SESSION_DAYS) || 14, 1), 90);

if (PRODUCTION && (!env.INBOX_PASSWORD || INBOX_PASSWORD === DEMO_PASSWORD || INBOX_PASSWORD.length < 12)) {
  console.error('\n  ✖  Refusing to start: set INBOX_PASSWORD to a private password of at least 12 characters.\n');
  process.exit(1);
}
if (!env.INBOX_PASSWORD) console.warn(`\n  ⚠  INBOX_PASSWORD is not set. Using the demo password "${DEMO_PASSWORD}". Set it before going live.\n`);
else if (INBOX_PASSWORD.length < 12) console.warn('\n  ⚠  INBOX_PASSWORD is short. Use 12+ characters.\n');
if (PRODUCTION && !env.SESSION_SECRET) console.warn('\n  ⚠  SESSION_SECRET is not set: the team will be signed out on every restart.\n');
if (env.NOTIFY_WEBHOOK_URL && !NOTIFY_WEBHOOK_URL) console.warn('\n  ⚠  NOTIFY_WEBHOOK_URL must start with https:// — notifications are off.\n');

const db = openDb(DB_FILE);
const clientIp = makeClientIp({ header: CLIENT_IP_HEADER, hops: TRUST_PROXY });
const allow = makeLimiter();
const originOk = makeOriginCheck({ allowed: ALLOWED_ORIGINS, production: PRODUCTION });

// ---------- Limits ----------
const LIMITS = {
  loginPerIp:       { capacity: 5,   refillPerSec: 1 / 60 },   // 5 tries, then 1 per minute
  loginGlobal:      { capacity: 30,  refillPerSec: 1 / 10 },   // slows distributed guessing
  connectPerIp:     { capacity: 30,  refillPerSec: 0.5 },
  eventsPerSocket:  { capacity: 40,  refillPerSec: 8 },
  messagePerIp:     { capacity: 10,  refillPerSec: 0.4 },
  newConvPerIp:     { capacity: 4,   refillPerSec: 1 / 120 },
  newConvGlobal:    { capacity: 60,  refillPerSec: 1 / 20 },   // a burst of 60, then 3 a minute site-wide
  agentMessage:     { capacity: 30,  refillPerSec: 2 },
};
const MAX_SOCKETS_PER_IP = 25;
const MAX_MESSAGES_PER_CONVERSATION = 1500;
const MAX_BODY = 4000;

// ---------- Helpers ----------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
const noop = () => {};

// Sessions are bound to the current password: changing INBOX_PASSWORD signs everyone out.
const PASSWORD_VERSION = createHmac('sha256', SESSION_SECRET).update(`pv:${INBOX_PASSWORD}`).digest('base64url').slice(0, 16);
function signAgent(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, pv: PASSWORD_VERSION, exp: Date.now() + SESSION_DAYS * 86400_000 })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyAgent(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.pv !== PASSWORD_VERSION || !(data.exp > Date.now()) || typeof data.n !== 'string') return null;
    return { name: data.n, exp: data.exp };
  } catch { return null; }
}

function publicMessage(m) {
  return { id: m.id, conversationId: m.conversation_id, sender: m.sender, agentName: m.agent_name, body: m.body, createdAt: m.created_at, readAt: m.read_at };
}
function publicConversation(c) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, email: c.email, topic: c.topic, page: c.page, referrer: c.referrer,
    userAgent: c.user_agent, timezone: c.timezone, status: c.status, createdAt: c.created_at,
    lastMessageAt: c.last_message_at, lastBody: c.last_body, lastSender: c.last_sender, unread: c.unread ?? 0,
    online: visitorOnline(c.id),
  };
}

async function notify(text) {
  if (!NOTIFY_WEBHOOK_URL) return;
  try {
    await fetch(NOTIFY_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Slack reads "text", Discord reads "content". allowed_mentions stops visitors pinging @everyone on Discord.
      body: JSON.stringify({ text, content: text, allowed_mentions: { parse: [] } }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { console.warn('Notify webhook failed:', e.message); }
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false); // client IPs come from clientIp() only, never from a forgeable header
app.set('etag', 'strong');
app.use(securityHeaders({ publicDir: PUBLIC_DIR, production: PRODUCTION }));

app.post('/api/login', express.json({ limit: '4kb', strict: true }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = rateKey(clientIp(req.headers, req.socket.remoteAddress));
  if (!originOk(req.headers)) return res.status(403).json({ error: 'Blocked.' });
  if (!allow(`login:${ip}`, LIMITS.loginPerIp) || !allow('login:global', LIMITS.loginGlobal)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  }
  const body = isPlainObject(req.body) ? req.body : {};
  const name = cleanText(body.name, 40);
  const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  if (!name) return res.status(400).json({ error: 'Enter the name visitors will see.' });
  if (!safeEqual(sha256(password), sha256(INBOX_PASSWORD))) {
    console.warn(`Failed inbox sign-in from ${ip}`);
    await sleep(400 + Math.random() * 400); // makes guessing slower without hurting real users
    return res.status(401).json({ error: 'That password is not right.' });
  }
  res.json({ token: signAgent(name), name });
});
app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.get('/healthz', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true }); });

const privatePage = (res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
};
app.get(['/inbox', '/inbox.html'], (_req, res) => { privatePage(res); res.sendFile(join(PUBLIC_DIR, 'inbox.html')); });
app.use(['/js/inbox.js', '/css/inbox.css'], (_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex'); next(); });

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  dotfiles: 'ignore',
  index: 'index.html',
  redirect: false,
  setHeaders(res, path) {
    if (/\.(woff2|svg|png|jpg|webp)$/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Method not allowed' });
  res.status(404).type('text/plain').send('Not found');
});
// Never leak stack traces (malformed JSON, oversized bodies, etc.).
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: status === 413 ? 'Too large.' : 'Bad request.' });
});

const server = createServer(app);
server.headersTimeout = 15_000;   // slow-loris protection
server.requestTimeout = 30_000;
server.keepAliveTimeout = 10_000;
server.maxHeadersCount = 60;
server.maxConnections = 5000;

// ---------- Realtime ----------
const socketsPerIp = new Map();
const io = new Server(server, {
  maxHttpBufferSize: 32 * 1024,
  pingInterval: 20000,
  pingTimeout: 25000,
  connectTimeout: 10000,
  cors: { origin: false },
  allowEIO3: false,
  allowRequest(req, cb) {
    if (!originOk(req.headers)) return cb('origin not allowed', false);
    const ip = rateKey(clientIp(req.headers, req.socket.remoteAddress));
    if ((socketsPerIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) return cb('too many connections', false);
    if (!allow(`conn:${ip}`, LIMITS.connectPerIp)) return cb('slow down', false);
    cb(null, true);
  },
});

const agentSockets = new Map();   // socket.id -> agent name
const visitorSockets = new Map(); // conversationId -> Set(socket.id)

function presence() {
  const names = [...new Set(agentSockets.values())];
  return { online: names.length > 0, agents: names.slice(0, 5) };
}
function broadcastPresence() { io.to('visitors').emit('presence', presence()); io.to('agents').emit('agents', presence()); }
function visitorOnline(id) { return (visitorSockets.get(id)?.size ?? 0) > 0; }
function emitConversation(id) { io.to('agents').emit('conversation:update', publicConversation(db.conversationSummary(id))); }

// Every handler goes through here: payloads of the wrong type, missing acks, thrown errors and
// rejected promises are contained so a crafted event can never crash the server.
function on(socket, event, handler) {
  socket.on(event, (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : noop;
    const raw = args[0];
    const payload = isPlainObject(raw) ? raw : {};
    const reply = (v) => { try { ack(v); } catch { /* client went away */ } };
    try {
      const r = handler(payload, reply, raw);
      if (r && typeof r.catch === 'function') r.catch((e) => { console.error(`[${event}]`, e); reply({ error: 'Something went wrong.' }); });
    } catch (e) {
      console.error(`[${event}]`, e);
      reply({ error: 'Something went wrong.' });
    }
  });
}

io.use((socket, next) => {
  const req = socket.request;
  const ip = rateKey(clientIp(req.headers, req.socket.remoteAddress));
  socket.data.ip = ip;

  const a = isPlainObject(socket.handshake.auth) ? socket.handshake.auth : {};
  if (a.role === 'agent') {
    const agent = verifyAgent(a.token);
    if (!agent) return next(new Error('unauthorized'));
    socket.data.role = 'agent'; socket.data.name = agent.name; socket.data.exp = agent.exp;
    return next();
  }
  socket.data.role = 'visitor';
  // Resume an existing conversation only with its secret token.
  if (typeof a.conversationId === 'string' && UUID_RE.test(a.conversationId) && typeof a.token === 'string' && a.token.length <= 128) {
    const conv = db.getConversation(a.conversationId);
    if (conv && safeEqual(conv.token_hash, sha256(a.token))) socket.data.conversationId = conv.id;
  }
  next();
});

io.on('connection', (socket) => {
  const ip = socket.data.ip;
  socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1);
  socket.on('disconnect', () => {
    const n = (socketsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
  });

  // Per-connection flood control for every event type; persistent abusers are disconnected.
  let strikes = 0;
  socket.use((packet, next) => {
    if (socket.data.role === 'agent' && Date.now() > socket.data.exp) { socket.emit('session:expired'); return socket.disconnect(true); }
    if (allow(`ev:${socket.id}`, LIMITS.eventsPerSocket)) { strikes = 0; return next(); }
    if (++strikes > 50) socket.disconnect(true);
  });
  if (socket.data.role === 'agent') return handleAgent(socket);
  return handleVisitor(socket);
});

function joinVisitorRoom(socket, id) {
  socket.data.conversationId = id;
  socket.join(`c:${id}`);
  if (!visitorSockets.has(id)) visitorSockets.set(id, new Set());
  const set = visitorSockets.get(id);
  const wasOnline = set.size > 0;
  set.add(socket.id);
  if (!wasOnline) io.to('agents').emit('visitor:presence', { conversationId: id, online: true });
}

function handleVisitor(socket) {
  socket.join('visitors');
  const ip = socket.data.ip;
  const ua = cleanText(socket.handshake.headers['user-agent'], 300);

  const id = socket.data.conversationId;
  if (id) joinVisitorRoom(socket, id);
  const conv = id ? db.getConversation(id) : null;
  socket.emit('session', {
    conversationId: id || null,
    conversation: conv ? { name: conv.name, email: conv.email, topic: conv.topic } : null,
    messages: id ? db.listMessages(id).map(publicMessage) : [],
    presence: presence(),
  });

  let contextUpdates = 0;
  on(socket, 'context', (ctx) => {
    if (++contextUpdates > 20) return; // a page sends this once per connection
    socket.data.context = {
      page: cleanText(ctx.page, 300), referrer: cleanText(ctx.referrer, 300), timezone: cleanText(ctx.timezone, 60), userAgent: ua,
    };
    if (socket.data.conversationId) { db.updateContext(socket.data.conversationId, socket.data.context); emitConversation(socket.data.conversationId); }
  });

  on(socket, 'message', (payload, ack) => {
    if (!allow(`vmsg:${ip}`, LIMITS.messagePerIp)) return ack({ error: 'You are sending messages very quickly. Give it a moment.' });
    const body = cleanText(payload.body, MAX_BODY, { multiline: true });
    if (!body) return ack({ error: 'Empty message.' });

    let convId = socket.data.conversationId;
    let token = null;
    let isNew = false;
    if (!convId) {
      if (!allow(`vnew:${ip}`, LIMITS.newConvPerIp)) return ack({ error: 'Too many new conversations from this network. Try again later.' });
      if (!allow('vnew:global', LIMITS.newConvGlobal)) return ack({ error: 'We are getting a lot of messages right now. Please try again in a minute, or email us.' });
      convId = randomUUID();
      token = randomBytes(24).toString('base64url');
      const ctx = socket.data.context || {};
      db.createConversation({ id: convId, tokenHash: sha256(token), page: ctx.page, referrer: ctx.referrer, userAgent: ua, timezone: ctx.timezone });
      const topic = cleanText(payload.topic, 80);
      if (topic) db.updateProfile(convId, { topic });
      joinVisitorRoom(socket, convId);
      isNew = true;
    } else if (db.visitorMessageCount(convId) >= MAX_MESSAGES_PER_CONVERSATION) {
      return ack({ error: 'This conversation is full. Please email us to continue.' });
    }

    const msg = publicMessage(db.addMessage({ conversationId: convId, sender: 'visitor', body }));
    ack({ ok: true, message: msg, conversationId: convId, token });
    socket.to(`c:${convId}`).emit('message', msg); // other tabs of the same visitor
    io.to('agents').emit('message', msg);

    if (db.visitorMessageCount(convId) === 1) {
      const p = presence();
      const text = p.online
        ? `Delivered. ${p.agents[0] ?? 'Someone on the team'} has been notified and will reply right here.`
        : 'Delivered. The team is away right now. Leave your email below and we will reply by email as soon as we are back, usually within a few hours.';
      const sys = publicMessage(db.addMessage({ conversationId: convId, sender: 'system', body: text }));
      setTimeout(() => io.to(`c:${convId}`).emit('message', sys), 450);
    }
    emitConversation(convId);

    const c = db.getConversation(convId);
    const who = webhookSafe(c.name || c.email || 'A visitor');
    const quote = webhookSafe(body.slice(0, 180).replace(/\s+/g, ' '));
    const link = PUBLIC_URL ? ` ${PUBLIC_URL}/inbox#${convId}` : '';
    if (isNew) notify(`💬 New chat from ${who}: "${quote}"${link}`);
    else if (!presence().online) notify(`💬 ${who}: "${quote}"${link}`);
  });

  on(socket, 'profile', (p, ack) => {
    const convId = socket.data.conversationId;
    if (!convId) return ack({ error: 'Send a message first.' });
    if (!allow(`vprofile:${ip}`, { capacity: 10, refillPerSec: 0.1 })) return ack({ error: 'Please wait a moment.' });
    const name = cleanText(p.name, 80) || null;
    const emailRaw = cleanText(p.email, 254);
    if (emailRaw && !EMAIL_RE.test(emailRaw)) return ack({ error: 'That email address does not look right.' });
    const topic = cleanText(p.topic, 80) || null;
    db.updateProfile(convId, { name, email: emailRaw || null, topic });
    ack({ ok: true });
    emitConversation(convId);
  });

  on(socket, 'typing', (_p, _ack, raw) => {
    const convId = socket.data.conversationId;
    if (convId) io.to('agents').emit('typing', { conversationId: convId, from: 'visitor', typing: raw === true });
  });

  on(socket, 'read', () => {
    const convId = socket.data.conversationId;
    if (!convId) return;
    const r = db.markRead(convId, 'agent');
    if (r.changed) io.to('agents').emit('read', { conversationId: convId, by: 'visitor', at: r.at });
  });

  socket.on('disconnect', () => {
    const convId = socket.data.conversationId;
    if (!convId) return;
    const set = visitorSockets.get(convId);
    set?.delete(socket.id);
    if (set && set.size === 0) {
      visitorSockets.delete(convId);
      io.to('agents').emit('visitor:presence', { conversationId: convId, online: false });
      io.to('agents').emit('typing', { conversationId: convId, from: 'visitor', typing: false });
    }
  });
}

function handleAgent(socket) {
  const name = socket.data.name;
  agentSockets.set(socket.id, name);
  socket.join('agents');
  broadcastPresence();

  socket.emit('ready', { name, conversations: db.listConversations().map(publicConversation), presence: presence() });

  const convIdFrom = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

  on(socket, 'conversation:open', (p, ack) => {
    const id = convIdFrom(p.id);
    const conv = id && db.conversationSummary(id);
    if (!conv) return ack({ error: 'Not found' });
    const r = db.markRead(id, 'visitor');
    if (r.changed) io.to(`c:${id}`).emit('read', { by: 'agent', at: r.at });
    ack({ ok: true, conversation: publicConversation(db.conversationSummary(id)), messages: db.listMessages(id).map(publicMessage) });
    emitConversation(id);
  });

  on(socket, 'message', (p, ack) => {
    if (!allow(`amsg:${socket.id}`, LIMITS.agentMessage)) return ack({ error: 'Slow down a little.' });
    const id = convIdFrom(p.conversationId);
    const body = cleanText(p.body, MAX_BODY, { multiline: true });
    if (!id || !body || !db.getConversation(id)) return ack({ error: 'Could not send.' });
    db.markRead(id, 'visitor');
    const msg = publicMessage(db.addMessage({ conversationId: id, sender: 'agent', agentName: name, body }));
    ack({ ok: true, message: msg });
    io.to(`c:${id}`).emit('message', msg);
    io.to(`c:${id}`).emit('typing', { from: 'agent', typing: false, name });
    socket.to('agents').emit('message', msg);
    emitConversation(id);
  });

  on(socket, 'typing', (p) => {
    const id = convIdFrom(p.conversationId);
    if (id) io.to(`c:${id}`).emit('typing', { from: 'agent', typing: p.typing === true, name });
  });

  on(socket, 'read', (p) => {
    const id = convIdFrom(p.conversationId);
    if (!id) return;
    const r = db.markRead(id, 'visitor');
    if (r.changed) { io.to(`c:${id}`).emit('read', { by: 'agent', at: r.at }); emitConversation(id); }
  });

  on(socket, 'conversation:status', (p, ack) => {
    const id = convIdFrom(p.conversationId);
    const status = p.status === 'closed' ? 'closed' : 'open';
    if (!id || !db.getConversation(id)) return ack({ error: 'Not found' });
    db.setStatus(id, status);
    ack({ ok: true });
    emitConversation(id);
  });

  socket.on('disconnect', () => { agentSockets.delete(socket.id); broadcastPresence(); });
}

// Last line of defence: log instead of dying on a stray rejected promise.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

// Clean shutdown on deploys/restarts: stop accepting, tell clients to reconnect, close the database.
let stopping = false;
function shutdown(signal) {
  if (stopping) return; stopping = true;
  console.log(`${signal} received, shutting down…`);
  io.close();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`\n  Contact page  → http://localhost:${PORT}/`);
  console.log(`  Team inbox    → http://localhost:${PORT}/inbox\n`);
});
