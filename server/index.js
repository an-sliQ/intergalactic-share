// Contact page + realtime live chat + team inbox.
// One Node process: Express serves the pages, Socket.IO carries the chat, SQLite keeps the history.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------- Configuration (environment variables) ----------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || join(ROOT, '.data', 'chat.db');
const INBOX_PASSWORD = process.env.INBOX_PASSWORD || 'plumb-demo';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || ''; // Slack or Discord incoming webhook (optional)
const PUBLIC_URL = process.env.PUBLIC_URL || '';

if (!process.env.INBOX_PASSWORD) {
  console.warn('\n  ⚠  INBOX_PASSWORD is not set. Using the demo password "plumb-demo". Set it before going live.\n');
}

const db = openDb(DB_FILE);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ---------- Helpers ----------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
const clean = (s, max) => (typeof s === 'string' ? s.replace(/\u0000/g, '').trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function signAgent(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyAgent(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.n : null;
  } catch { return null; }
}

// Tiny in-memory rate limiter (token bucket per key).
const buckets = new Map();
function allow(key, { capacity = 8, refillPerSec = 0.5 } = {}) {
  const now = Date.now();
  const b = buckets.get(key) || { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1; buckets.set(key, b); return true;
}
setInterval(() => { const cutoff = Date.now() - 10 * 60 * 1000; for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k); }, 60_000).unref();

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
      body: JSON.stringify({ text, content: text }), // Slack reads "text", Discord reads "content"
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { console.warn('Notify webhook failed:', e.message); }
}

// ---------- HTTP routes ----------
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!allow(`login:${ip}`, { capacity: 6, refillPerSec: 0.05 })) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  const name = clean(req.body?.name, 40);
  const password = String(req.body?.password ?? '');
  if (!name) return res.status(400).json({ error: 'Enter the name visitors will see.' });
  if (!safeEqual(sha256(password), sha256(INBOX_PASSWORD))) return res.status(401).json({ error: 'That password is not right.' });
  res.json({ token: signAgent(name), name });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/inbox', (_req, res) => res.sendFile(join(ROOT, 'public', 'inbox.html')));
app.use(express.static(join(ROOT, 'public'), {
  extensions: ['html'],
  setHeaders(res, path) {
    if (/\.(woff2|svg|png|jpg|webp)$/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---------- Realtime ----------
const server = createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 20000,
  pingTimeout: 25000,
  cors: { origin: false },
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

io.use((socket, next) => {
  const a = socket.handshake.auth || {};
  if (a.role === 'agent') {
    const name = verifyAgent(a.token);
    if (!name) return next(new Error('unauthorized'));
    socket.data.role = 'agent'; socket.data.name = name;
    return next();
  }
  socket.data.role = 'visitor';
  // Resume an existing conversation only with its secret token.
  if (a.conversationId && a.token) {
    const conv = db.getConversation(String(a.conversationId));
    if (conv && safeEqual(conv.token_hash, sha256(String(a.token)))) socket.data.conversationId = conv.id;
  }
  next();
});

io.on('connection', (socket) => {
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
  const ip = socket.handshake.address;
  const ua = clean(socket.handshake.headers['user-agent'], 300);

  const id = socket.data.conversationId;
  if (id) joinVisitorRoom(socket, id);
  socket.emit('session', {
    conversationId: id || null,
    conversation: id ? (({ name, email, topic }) => ({ name, email, topic }))(db.getConversation(id)) : null,
    messages: id ? db.listMessages(id).map(publicMessage) : [],
    presence: presence(),
  });

  socket.on('context', (ctx = {}) => {
    socket.data.context = {
      page: clean(ctx.page, 300), referrer: clean(ctx.referrer, 300), timezone: clean(ctx.timezone, 60), userAgent: ua,
    };
    if (socket.data.conversationId) { db.updateContext(socket.data.conversationId, socket.data.context); emitConversation(socket.data.conversationId); }
  });

  socket.on('message', async (payload = {}, ack = () => {}) => {
    if (!allow(`vmsg:${ip}`, { capacity: 10, refillPerSec: 0.4 })) return ack({ error: 'You are sending messages very quickly. Give it a moment.' });
    const body = clean(payload.body, 4000);
    if (!body) return ack({ error: 'Empty message.' });

    let convId = socket.data.conversationId;
    let token = null;
    let isNew = false;
    if (!convId) {
      if (!allow(`vnew:${ip}`, { capacity: 4, refillPerSec: 0.01 })) return ack({ error: 'Too many new conversations from this network. Try again later.' });
      convId = randomUUID();
      token = randomBytes(24).toString('base64url');
      const ctx = socket.data.context || {};
      db.createConversation({ id: convId, tokenHash: sha256(token), page: ctx.page, referrer: ctx.referrer, userAgent: ua, timezone: ctx.timezone });
      if (payload.topic) db.updateProfile(convId, { topic: clean(payload.topic, 80) });
      joinVisitorRoom(socket, convId);
      isNew = true;
    }

    const msg = publicMessage(db.addMessage({ conversationId: convId, sender: 'visitor', body }));
    ack({ ok: true, message: msg, conversationId: convId, token });
    socket.to(`c:${convId}`).emit('message', msg); // other tabs of the same visitor
    io.to('agents').emit('message', msg);

    const firstMessage = db.visitorMessageCount(convId) === 1;
    if (firstMessage) {
      const p = presence();
      const text = p.online
        ? `Delivered. ${p.agents[0] ?? 'Someone on the team'} has been notified and will reply right here.`
        : 'Delivered. The team is away right now. Leave your email below and we will reply by email as soon as we are back, usually within a few hours.';
      const sys = publicMessage(db.addMessage({ conversationId: convId, sender: 'system', body: text }));
      setTimeout(() => io.to(`c:${convId}`).emit('message', sys), 450);
    }
    emitConversation(convId);

    const conv = db.getConversation(convId);
    const who = conv.name || conv.email || 'A visitor';
    const link = PUBLIC_URL ? ` ${PUBLIC_URL}/inbox#${convId}` : '';
    if (isNew) notify(`💬 New chat from ${who}: "${body.slice(0, 180)}"${link}`);
    else if (!presence().online) notify(`💬 ${who}: "${body.slice(0, 180)}"${link}`);
  });

  socket.on('profile', (p = {}, ack = () => {}) => {
    const convId = socket.data.conversationId;
    if (!convId) return ack({ error: 'Send a message first.' });
    const name = clean(p.name, 80) || null;
    const emailRaw = clean(p.email, 254);
    const email = emailRaw ? (EMAIL_RE.test(emailRaw) ? emailRaw : undefined) : null;
    if (email === undefined) return ack({ error: 'That email address does not look right.' });
    const topic = clean(p.topic, 80) || null;
    db.updateProfile(convId, { name, email, topic });
    ack({ ok: true });
    emitConversation(convId);
  });

  socket.on('typing', (isTyping) => {
    const convId = socket.data.conversationId;
    if (convId) io.to('agents').emit('typing', { conversationId: convId, from: 'visitor', typing: !!isTyping });
  });

  socket.on('read', () => {
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

  socket.on('conversation:open', (p = {}, ack = () => {}) => {
    const id = String(p.id || '');
    const conv = db.conversationSummary(id);
    if (!conv) return ack({ error: 'Not found' });
    const r = db.markRead(id, 'visitor');
    if (r.changed) io.to(`c:${id}`).emit('read', { by: 'agent', at: r.at });
    ack({ ok: true, conversation: publicConversation(db.conversationSummary(id)), messages: db.listMessages(id).map(publicMessage) });
    emitConversation(id);
  });

  socket.on('message', (p = {}, ack = () => {}) => {
    const id = String(p.conversationId || '');
    const body = clean(p.body, 4000);
    if (!body || !db.getConversation(id)) return ack({ error: 'Could not send.' });
    db.markRead(id, 'visitor');
    const msg = publicMessage(db.addMessage({ conversationId: id, sender: 'agent', agentName: name, body }));
    ack({ ok: true, message: msg });
    io.to(`c:${id}`).emit('message', msg);
    io.to(`c:${id}`).emit('typing', { from: 'agent', typing: false, name });
    socket.to('agents').emit('message', msg);
    emitConversation(id);
  });

  socket.on('typing', (p = {}) => {
    const id = String(p.conversationId || '');
    if (id) io.to(`c:${id}`).emit('typing', { from: 'agent', typing: !!p.typing, name });
  });

  socket.on('read', (p = {}) => {
    const id = String(p.conversationId || '');
    if (!id) return;
    const r = db.markRead(id, 'visitor');
    if (r.changed) { io.to(`c:${id}`).emit('read', { by: 'agent', at: r.at }); emitConversation(id); }
  });

  socket.on('conversation:status', (p = {}, ack = () => {}) => {
    const id = String(p.conversationId || '');
    const status = p.status === 'closed' ? 'closed' : 'open';
    if (!db.getConversation(id)) return ack({ error: 'Not found' });
    db.setStatus(id, status);
    ack({ ok: true });
    emitConversation(id);
  });

  socket.on('disconnect', () => { agentSockets.delete(socket.id); broadcastPresence(); });
}

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
