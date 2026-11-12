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
import { makeStorage } from './storage.js';
import { restoreIfMissing, startBackups } from './backup.js';
import { makeSupabaseAuth } from './auth.js';
import { sniff, safeFileName, ACCEPT } from './files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');

// ---------- Configuration (environment variables) ----------
const env = process.env;
const PRODUCTION = env.NODE_ENV === 'production';
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || '0.0.0.0';
const DB_FILE = env.DB_FILE || join(ROOT, '.data', 'chat.db');
const DEMO_PASSWORD = 'cairnly-demo';
const INBOX_PASSWORD = env.INBOX_PASSWORD || DEMO_PASSWORD;
const SESSION_SECRET = env.SESSION_SECRET || randomBytes(32).toString('hex');
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, '');
const NOTIFY_WEBHOOK_URL = /^https:\/\//.test(env.NOTIFY_WEBHOOK_URL || '') ? env.NOTIFY_WEBHOOK_URL : '';
const TRUST_PROXY = Number.isFinite(Number(env.TRUST_PROXY)) && env.TRUST_PROXY !== '' ? Number(env.TRUST_PROXY) : 1;
const CLIENT_IP_HEADER = env.CLIENT_IP_HEADER || '';
const ALLOWED_ORIGINS = [PUBLIC_URL, ...(env.ALLOWED_ORIGINS || '').split(',')].map((s) => s.trim()).filter(Boolean);
const SESSION_DAYS = Math.min(Math.max(Number(env.SESSION_DAYS) || 14, 1), 90);

// Optional services (each stays off until its settings are present).
const supaAuth = makeSupabaseAuth(env);
const store = makeStorage(env);
const PASSWORD_LOGIN = env.ALLOW_PASSWORD_LOGIN === 'true' ? true : env.ALLOW_PASSWORD_LOGIN === 'false' ? false : !supaAuth.enabled;
const FILES_ENABLED = store.enabled && env.FILE_UPLOADS !== 'off';
const FILE_MAX_MB = Math.min(Math.max(Number(env.FILE_MAX_MB) || 10, 1), 25);
const UPLOADS_PER_DAY = Math.max(Number(env.UPLOADS_PER_DAY) || 300, 1);
const BACKUP_INTERVAL_SEC = Math.max(Number(env.BACKUP_INTERVAL_SEC) || 180, 30);
const BACKUP_KEEP_DAYS = Math.min(Math.max(Number(env.BACKUP_KEEP_DAYS) || 14, 1), 90);

if (PRODUCTION && PASSWORD_LOGIN && (!env.INBOX_PASSWORD || INBOX_PASSWORD === DEMO_PASSWORD || INBOX_PASSWORD.length < 12)) {
  console.error('\n  ✖  Refusing to start: set INBOX_PASSWORD to a private password of at least 12 characters (or turn on Google sign-in).\n');
  process.exit(1);
}
if (PRODUCTION && !PASSWORD_LOGIN && !supaAuth.enabled) {
  console.error('\n  ✖  Refusing to start: no way to sign in to the inbox. Set SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY or ALLOW_PASSWORD_LOGIN=true.\n');
  process.exit(1);
}
if (PASSWORD_LOGIN && !env.INBOX_PASSWORD) console.warn(`\n  ⚠  INBOX_PASSWORD is not set. Using the demo password "${DEMO_PASSWORD}". Set it before going live.\n`);
else if (PASSWORD_LOGIN && INBOX_PASSWORD.length < 12) console.warn('\n  ⚠  INBOX_PASSWORD is short. Use 12+ characters.\n');
if (supaAuth.ready && !supaAuth.teamConfigured) console.log('\n  ℹ  Google sign-in is ready. Add TEAM_EMAILS to switch it on (the team password stays on until then).\n');
if (PRODUCTION && !env.SESSION_SECRET) console.warn('\n  ⚠  SESSION_SECRET is not set: the team will be signed out on every restart.\n');
if (env.NOTIFY_WEBHOOK_URL && !NOTIFY_WEBHOOK_URL) console.warn('\n  ⚠  NOTIFY_WEBHOOK_URL must start with https:// — notifications are off.\n');

if (env.SUPABASE_URL && !store.enabled && !supaAuth.enabled) console.warn('\n  ⚠  SUPABASE_URL is set but no keys are: add SUPABASE_PUBLISHABLE_KEY (sign-in) and SUPABASE_SECRET_KEY (files + backups).\n');

// On free hosting the disk starts empty: bring the database back from Supabase Storage before opening it.
const restore = await restoreIfMissing({ store, dbFile: DB_FILE });
const db = openDb(DB_FILE);
store.attachDb(db);
const backups = startBackups({ store, db, intervalSec: BACKUP_INTERVAL_SEC, keepDays: BACKUP_KEEP_DAYS, safeToBackUp: restore.safeToBackUp });
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
  uploadPerIp:      { capacity: 10,  refillPerSec: 20 / 3600 },  // 10 at once, then 20 an hour
  fileUrlPerSocket: { capacity: 60,  refillPerSec: 1 },
};
const MAX_FILES_PER_CONVERSATION_PER_DAY = 30;
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
// Password sessions are bound to the password; Google sessions are bound to the email staying on TEAM_EMAILS.
function signAgent(name, email = null) {
  const data = email ? { n: name, e: email } : { n: name, pv: PASSWORD_VERSION };
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + SESSION_DAYS * 86400_000 })).toString('base64url');
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
    if (!(data.exp > Date.now()) || typeof data.n !== 'string') return null;
    if (data.e) { if (!supaAuth.enabled || !supaAuth.isTeam(data.e)) return null; }
    else if (!PASSWORD_LOGIN || data.pv !== PASSWORD_VERSION) return null;
    return { name: data.n, email: data.e || null, exp: data.exp };
  } catch { return null; }
}

function publicMessage(m) {
  return {
    id: m.id, conversationId: m.conversation_id, sender: m.sender, agentName: m.agent_name, body: m.body, createdAt: m.created_at, readAt: m.read_at,
    attachment: m.att_id ? { id: m.att_id, name: m.att_name, mime: m.att_mime, kind: m.att_kind, size: m.att_size } : null,
  };
}
const features = () => ({ files: FILES_ENABLED, fileMaxMb: FILE_MAX_MB, accept: ACCEPT });
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
const isInboxPath = (p) => p === '/inbox' || p === '/inbox.html';
app.use(securityHeaders({
  publicDir: PUBLIC_DIR,
  production: PRODUCTION,
  extra: (req) => {
    const x = { img: store.enabled ? [store.origin] : [] };
    if (isInboxPath(req.path) && supaAuth.csp) Object.assign(x, supaAuth.csp);
    return x;
  },
}));

app.post('/api/login', express.json({ limit: '4kb', strict: true }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = rateKey(clientIp(req.headers, req.socket.remoteAddress));
  if (!originOk(req.headers)) return res.status(403).json({ error: 'Blocked.' });
  if (!allow(`login:${ip}`, LIMITS.loginPerIp) || !allow('login:global', LIMITS.loginGlobal)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  }
  if (!PASSWORD_LOGIN) return res.status(403).json({ error: 'Password sign-in is turned off. Use Google sign-in.' });
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
// What the inbox login screen should offer. The Supabase URL and publishable key are public by design.
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ googleSignIn: supaAuth.publicConfig, passwordLogin: PASSWORD_LOGIN });
});

app.post('/api/login/google', express.json({ limit: '8kb', strict: true }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = rateKey(clientIp(req.headers, req.socket.remoteAddress));
  if (!originOk(req.headers)) return res.status(403).json({ error: 'Blocked.' });
  if (!supaAuth.enabled) return res.status(404).json({ error: 'Google sign-in is not set up.' });
  if (!allow(`login:${ip}`, LIMITS.loginPerIp) || !allow('login:global', LIMITS.loginGlobal)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  }
  const body = isPlainObject(req.body) ? req.body : {};
  let who;
  try { who = await supaAuth.verifyAccessToken(body.accessToken); } catch (e) {
    console.warn(`Rejected Google sign-in from ${ip}: ${e.code || e.message}`);
    if (e.code === 'UPSTREAM' || e.name === 'TimeoutError' || e.name === 'TypeError') return res.status(503).json({ error: 'Supabase did not answer. Try again in a moment.' });
    return res.status(401).json({ error: 'Google sign-in could not be verified. Try again.' });
  }
  if (!who.email || !who.emailVerified) return res.status(403).json({ error: 'Use a Google account with a verified email address.' });
  if (!who.viaGoogle) {
    console.warn(`Sign-in for ${who.email} (${ip}) refused: not a Google sign-in`);
    return res.status(403).json({ error: 'Please use "Continue with Google".' });
  }
  if (!supaAuth.isTeam(who.email)) {
    console.warn(`Google sign-in from ${who.email} (${ip}) refused: not on TEAM_EMAILS`);
    return res.status(403).json({ error: `${who.email} is not on the team list. Ask the owner to add it to TEAM_EMAILS.` });
  }
  const name = cleanText(body.name, 40) || cleanText(who.name.split(' ')[0], 40) || who.email.split('@')[0].slice(0, 40);
  res.json({ token: signAgent(name, who.email), name, email: who.email });
});

// File upload: the server checks who is uploading BEFORE reading the body, checks the real file type
// from its bytes, keeps every free-tier cap, then stores it privately in Supabase Storage.
const uploadDay = { day: '', count: 0 };
function uploadAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!FILES_ENABLED) return res.status(404).json({ error: 'File sharing is not turned on.' });
  if (!originOk(req.headers)) return res.status(403).json({ error: 'Blocked.' });
  const ip = rateKey(clientIp(req.headers, req.socket.remoteAddress));
  const len = Number(req.headers['content-length']);
  if (!Number.isFinite(len) || len <= 0) return res.status(411).json({ error: 'Empty file.' });
  if (len > FILE_MAX_MB * 1024 * 1024) return res.status(413).json({ error: `Files can be up to ${FILE_MAX_MB} MB.` });
  const convId = String(req.headers['x-conversation-id'] || '');
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'Bad request.' });
  const conv = db.getConversation(convId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) {
    const agent = verifyAgent(auth.slice(7));
    if (!agent) return res.status(401).json({ error: 'Sign in again.' });
    req.uploader = { role: 'agent', name: agent.name };
  } else {
    const token = String(req.headers['x-conversation-token'] || '');
    if (!token || token.length > 128 || !safeEqual(conv.token_hash, sha256(token))) return res.status(401).json({ error: 'Not allowed.' });
    req.uploader = { role: 'visitor' };
  }
  if (!allow(`upload:${req.uploader.role === 'agent' ? 'a:' + req.uploader.name : ip}`, LIMITS.uploadPerIp)) {
    return res.status(429).json({ error: 'You are sending files very quickly. Try again in a few minutes.' });
  }
  if (db.attachmentCountSince(convId, Date.now() - 86400_000) >= MAX_FILES_PER_CONVERSATION_PER_DAY) {
    return res.status(429).json({ error: 'This conversation has reached today\'s file limit. Please email larger batches.' });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (uploadDay.day !== today) { uploadDay.day = today; uploadDay.count = 0; }
  if (uploadDay.count >= UPLOADS_PER_DAY) return res.status(429).json({ error: 'File sharing is paused for today. Please email the file instead.' });
  if (db.attachmentBytes() + backups.bytesStored() + len > store.limits.storageBytes) {
    return res.status(507).json({ error: 'File storage is full. Please email the file instead.' });
  }
  req.conv = conv;
  next();
}

app.post('/api/files', uploadAuth, express.raw({ type: () => true, limit: `${FILE_MAX_MB}mb` }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Empty file.' });
  let rawName = '';
  try { rawName = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { rawName = ''; }
  const type = sniff(buf, rawName);
  if (!type) return res.status(415).json({ error: 'That file type is not supported. Send images, PDFs, Word, Excel, PowerPoint, text or short videos.' });
  const name = safeFileName(rawName, type.ext);
  const id = randomUUID();
  const key = `files/${req.conv.id}/${id}`;
  try {
    await store.put(key, buf, { contentType: type.mime.split(';')[0] }); // bucket allow-list matches bare types
  } catch (e) {
    console.error('Upload to storage failed:', e.message);
    return res.status(502).json({ error: 'Could not store the file. Please try again or email it.' });
  }
  uploadDay.count += 1;
  let row;
  try {
    row = db.addAttachmentMessage({
      conversationId: req.conv.id, sender: req.uploader.role, agentName: req.uploader.name,
      attachment: { id, key, name, mime: type.mime, kind: type.kind, size: buf.length },
    });
  } catch (e) {
    store.del(key).catch(() => {});
    console.error('Saving attachment failed:', e);
    return res.status(500).json({ error: 'Could not save the file.' });
  }
  const msg = publicMessage(row);
  res.json({ ok: true, message: msg });
  // The uploading tab already has the message from this response; don't send it to that tab twice.
  const sid = String(req.headers['x-socket-id'] || '');
  const s = sid.length < 64 ? io.sockets.sockets.get(sid) : null;
  const own = s && ((req.uploader.role === 'visitor' && s.data.conversationId === req.conv.id) || (req.uploader.role === 'agent' && s.data.role === 'agent')) ? s : null;
  if (req.uploader.role === 'visitor') afterVisitorMessage(req.conv.id, msg, own, { isNew: false, preview: `File: ${name}` });
  else afterAgentMessage(req.conv.id, msg, req.uploader.name, own);
});

// Called once a day by the free GitHub Action in .github/workflows/keepalive.yml (or any uptime pinger).
// Wakes the server and touches Supabase at most every 6 hours, so a quiet week can't get the free project paused.
let lastPing = 0;
app.get('/api/keepalive', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!store.enabled) return res.json({ ok: true, supabase: 'off' });
  if (Date.now() - lastPing < 6 * 3600_000) return res.json({ ok: true, supabase: 'recent' });
  lastPing = Date.now();
  try { await store.ping(); res.json({ ok: true, supabase: 'pinged' }); } catch (e) {
    lastPing = 0; console.warn('Keep-alive ping failed:', e.message);
    res.status(502).json({ ok: false, supabase: 'unreachable' });
  }
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

// Fan a visitor message out: their other tabs, the team, the first-message notice, and the webhook.
function afterVisitorMessage(convId, msg, fromSocket, { isNew, preview }) {
  (fromSocket ? fromSocket.to(`c:${convId}`) : io.to(`c:${convId}`)).emit('message', msg);
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
  const quote = webhookSafe(String(preview).slice(0, 180).replace(/\s+/g, ' '));
  const link = PUBLIC_URL ? ` ${PUBLIC_URL}/inbox#${convId}` : '';
  if (isNew) notify(`💬 New chat from ${who}: "${quote}"${link}`);
  else if (!presence().online) notify(`💬 ${who}: "${quote}"${link}`);
}
function afterAgentMessage(convId, msg, name, fromSocket) {
  io.to(`c:${convId}`).emit('message', msg);
  io.to(`c:${convId}`).emit('typing', { from: 'agent', typing: false, name });
  (fromSocket ? fromSocket.to('agents') : io.to('agents')).emit('message', msg);
  emitConversation(convId);
}

// Short-lived private link to one attachment, only for people in that conversation.
async function fileUrl(socket, p, ack) {
  if (!FILES_ENABLED) return ack({ error: 'Files are off.' });
  if (!allow(`furl:${socket.id}`, LIMITS.fileUrlPerSocket)) return ack({ error: 'Slow down.' });
  const id = typeof p.id === 'string' && UUID_RE.test(p.id) ? p.id : null;
  const att = id && db.getAttachment(id);
  if (!att) return ack({ error: 'Not found' });
  if (socket.data.role !== 'agent' && att.conversation_id !== socket.data.conversationId) return ack({ error: 'Not found' });
  try {
    // Images and PDFs open in the browser; everything else downloads with its real name.
    const inline = att.kind === 'image' || att.mime === 'application/pdf';
    const { url, expiresAt } = await store.signedUrl(att.object_key, { expiresSec: 1800, size: att.size, downloadName: inline ? null : att.name });
    ack({ ok: true, url, expiresAt });
  } catch (e) {
    if (e.code !== 'STORAGE_CAP') console.warn('Signed link failed:', e.message);
    ack({ error: e.code === 'STORAGE_CAP' ? 'File viewing is paused until next month.' : 'Could not open the file.' });
  }
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
    features: features(),
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
    afterVisitorMessage(convId, msg, socket, { isNew, preview: body });
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

  on(socket, 'file:url', (p, ack) => fileUrl(socket, p, ack));

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

  socket.emit('ready', { name, conversations: db.listConversations().map(publicConversation), presence: presence(), features: features() });

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
    afterAgentMessage(id, msg, name, socket);
  });

  on(socket, 'file:url', (p, ack) => fileUrl(socket, p, ack));

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
async function shutdown(signal) {
  if (stopping) return; stopping = true;
  console.log(`${signal} received, shutting down…`);
  setTimeout(() => process.exit(0), 15000).unref();
  io.close();
  server.close();
  try {
    if (backups.enabled && await Promise.race([backups.final(), new Promise((r) => setTimeout(() => r('timeout'), 12000))]) === true) console.log('  ↑  Final backup saved to Supabase.');
  } catch (e) { console.warn('Final backup failed:', e.message); }
  try { db.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`\n  Contact page  → http://localhost:${PORT}/`);
  console.log(`  Team inbox    → http://localhost:${PORT}/inbox`);
  console.log(`  Sign-in       → ${[supaAuth.enabled && 'Google (Supabase)', PASSWORD_LOGIN && 'team password'].filter(Boolean).join(' + ')}`);
  console.log(`  Files         → ${FILES_ENABLED ? `on, up to ${FILE_MAX_MB} MB, ${store.describe()}` : 'off (set SUPABASE_URL + SUPABASE_SECRET_KEY to turn on)'}`);
  console.log(`  Backups       → ${backups.enabled ? `to Supabase every ${BACKUP_INTERVAL_SEC}s when something changed, ${BACKUP_KEEP_DAYS} daily copies kept` : store.enabled ? 'OFF this run (Supabase was unreachable at start)' : 'off (set SUPABASE_URL + SUPABASE_SECRET_KEY to turn on)'}\n`);
});
