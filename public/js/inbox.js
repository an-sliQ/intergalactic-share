// Team inbox: sign in, see conversations live, reply in real time.
import { prepareFile, uploadFile, makeUrlCache, attachmentNode, uploadingNode, wireFileInputs } from './attachments.js';
const AUTH_KEY = 'plumb.inbox.v1';
const QUICK_REPLIES = [
  'Thanks for reaching out! Could you share your current website, if you have one?',
  'Do you have a timeline or launch date in mind?',
  'Roughly what budget range are you working with?',
  'Happy to jump on a short call. What time works for you?',
  'I’ll put a written proposal together and email it to you within two working days.',
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
};
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (new Date(ts).toDateString() === new Date().toDateString()) return timeFmt.format(ts).toLowerCase();
  return dayFmt.format(ts);
}
const initials = (s) => (s || '?').trim().split(/[\s@._-]+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const displayName = (c) => c.name || c.email || `Visitor ${c.id.slice(0, 4).toUpperCase()}`;
function browserName(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' on ') || 'Unknown';
}
function localTime(tz) {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', weekday: 'short' }).format(new Date()) + ` (${tz})`; } catch { return tz || 'Unknown'; }
}
function richText(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|([\w.+-]+@[\w-]+\.[\w.-]+\w)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(el('a', { href: m[1] || `mailto:${m[2]}`, target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

const state = {
  auth: JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'),
  socket: null,
  convs: new Map(),
  activeId: null,
  messages: [],
  filter: 'open',
  query: '',
  typing: new Map(), // conversationId -> bool
  presence: { agents: [] },
  notify: localStorage.getItem('plumb.inbox.notify') === '1',
  features: { files: false, fileMaxMb: 10, accept: '' },
};

// ---------------------------------------------------------------- views
function show(view) { $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== view; }); }

// Which sign-in methods are on (Google via Supabase, the team password, or both).
let loginConfig = { googleSignIn: null, passwordLogin: true };
const loginReady = fetch('/api/config').then((r) => r.json()).then((c) => {
  loginConfig = c;
  $('[data-google]').hidden = !c.googleSignIn;
  $('[data-or]').hidden = !c.passwordLogin;
  $('[data-password]').hidden = !c.passwordLogin;
}).catch(() => {});

// ---- Google sign-in through Supabase (PKCE redirect: works on phones, no pop-ups, no SDK) ----
const PKCE_KEY = 'plumb.inbox.pkce';
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUrl = () => `${location.origin}/inbox`;

$('[data-google-btn]').addEventListener('click', async (e) => {
  const btn = e.currentTarget; const err = $('[data-login-error]');
  err.textContent = ''; btn.disabled = true;
  try {
    await loginReady;
    const cfg = loginConfig.googleSignIn;
    if (!cfg) throw new Error('Google sign-in is not set up yet.');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, name: $('[data-login]').name.value.trim(), at: Date.now() }));
    const q = new URLSearchParams({ provider: 'google', redirect_to: redirectUrl(), code_challenge: challenge, code_challenge_method: 's256', prompt: 'select_account' });
    location.assign(`${cfg.url}/auth/v1/authorize?${q}`);
  } catch (ex) { err.textContent = ex.message || 'Could not start Google sign-in.'; btn.disabled = false; }
});

// Back from Google: /inbox?code=… (or ?error=…). Swap the one-time code for a token, then sign in here.
async function finishGoogleSignIn() {
  const qs = new URLSearchParams(location.search);
  const hs = new URLSearchParams(location.hash.slice(1));
  const code = qs.get('code');
  const errDesc = qs.get('error_description') || hs.get('error_description') || qs.get('error') || hs.get('error');
  if (!code && !errDesc) return false;
  history.replaceState(null, '', '/inbox'); // never leave the code in the address bar or history
  const err = $('[data-login-error]');
  show('login');
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null'); } catch { return null; } })();
  sessionStorage.removeItem(PKCE_KEY);
  if (errDesc) { err.textContent = `Google sign-in was cancelled or failed: ${errDesc.replace(/\+/g, ' ')}`; return true; }
  if (!saved?.verifier || Date.now() - saved.at > 15 * 60_000) { err.textContent = 'That sign-in link expired. Click "Continue with Google" again.'; return true; }
  const btn = $('[data-google-btn]'); btn.disabled = true;
  err.textContent = 'Signing you in…';
  try {
    await loginReady;
    const cfg = loginConfig.googleSignIn;
    if (!cfg) throw new Error('Google sign-in is not set up.');
    const tr = await fetch(`${cfg.url}/auth/v1/token?grant_type=pkce`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.key },
      body: JSON.stringify({ auth_code: code, code_verifier: saved.verifier }),
    });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.access_token) throw new Error(tok.error_description || tok.msg || 'Google sign-in could not be completed. Try again.');
    const res = await fetch('/api/login/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: tok.access_token, name: saved.name || '' }) });
    const data = await res.json().catch(() => ({}));
    // We only needed Supabase to prove who you are; end that session (best effort).
    fetch(`${cfg.url}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${tok.access_token}` } }).catch(() => {});
    if (!res.ok) throw new Error(data.error || 'Could not sign in.');
    err.textContent = '';
    state.auth = data; localStorage.setItem(AUTH_KEY, JSON.stringify(data));
    start();
  } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  return true;
}

$('[data-login]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget; const err = $('[data-login-error]');
  err.textContent = '';
  if (!loginConfig.passwordLogin) return;
  if (!f.name.value.trim()) { err.textContent = 'Enter your name.'; f.name.focus(); return; }
  if (!f.password.value) { err.textContent = 'Enter the team password.'; f.password.focus(); return; }
  const btn = f.querySelector('[type=submit]'); btn.disabled = true;
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim(), password: f.password.value }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not sign in.');
    state.auth = data; localStorage.setItem(AUTH_KEY, JSON.stringify(data));
    start();
  } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
});

$('[data-signout]').addEventListener('click', () => {
  localStorage.removeItem(AUTH_KEY); state.socket?.disconnect(); state.auth = null; location.hash = ''; show('login');
});

const notifyBtn = $('[data-notify]');
function renderNotifyBtn() {
  const on = state.notify && 'Notification' in window && Notification.permission === 'granted';
  notifyBtn.textContent = on ? 'Alerts on' : 'Turn on alerts';
  notifyBtn.setAttribute('aria-pressed', String(on));
}
notifyBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
  if (state.notify && Notification.permission === 'granted') { state.notify = false; }
  else { const p = await Notification.requestPermission(); state.notify = p === 'granted'; }
  localStorage.setItem('plumb.inbox.notify', state.notify ? '1' : '0');
  renderNotifyBtn();
});

// ---------------------------------------------------------------- list
function previewText(c) {
  const body = c.lastBody || '';
  if (body.startsWith('File: ')) return `${c.lastSender === 'agent' ? 'Team sent' : 'Sent'} a file: ${body.slice(6)}`;
  return `${c.lastSender === 'agent' ? 'Team: ' : ''}${body}`;
}
function renderList() {
  const list = $('[data-list]');
  const q = state.query.toLowerCase();
  const all = [...state.convs.values()].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  const items = all.filter((c) => (state.filter === 'all' || c.status === state.filter) && (!q || [c.name, c.email, c.lastBody, c.topic].some((v) => v && v.toLowerCase().includes(q))));
  const openUnread = all.filter((c) => c.status === 'open' && c.unread > 0).length;
  $('[data-count="open"]').textContent = openUnread ? String(openUnread) : '';
  $('[data-list-empty]').hidden = all.length > 0;

  list.replaceChildren(...items.map((c) => {
    const typing = state.typing.get(c.id);
    return el('li', {
      class: `ib-item${c.unread ? ' is-unread' : ''}`, 'aria-current': c.id === state.activeId ? 'true' : null, tabindex: '0', 'data-id': c.id,
      onclick: () => openConversation(c.id), onkeydown: (e) => { if (e.key === 'Enter') openConversation(c.id); },
    },
    el('span', { class: `ib-avatar${c.online ? ' is-online' : ''}`, text: initials(c.name || c.email) || '•' }),
    el('span', { class: 'ib-item-name' }, displayName(c), c.topic ? el('span', { class: 'ib-tag', text: c.topic }) : null),
    el('span', { class: 'ib-item-time', text: relTime(c.lastMessageAt) }),
    el('span', { class: `ib-item-preview${typing ? ' is-typing' : ''}`, text: typing ? 'typing…' : previewText(c) }),
    c.unread ? el('span', { class: 'ib-badge', text: String(c.unread) }) : null);
  }));
  const total = all.reduce((n, c) => n + (c.unread || 0), 0);
  document.title = total ? `(${total}) Inbox | Plumb` : 'Inbox | Plumb';
}
$$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  $$('[data-filter]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  renderList();
}));
$('[data-search]').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
setInterval(renderList, 30_000);

// ---------------------------------------------------------------- thread
const msgBox = $('[data-messages]');
const input = $('#ib-input');
const sendBtn = $('[data-compose] .lc-send');

function openConversation(id) {
  state.activeId = id;
  location.hash = id;
  if (!openConversation.didInit && matchMedia('(min-width:1201px)').matches) $('[data-details]').hidden = false;
  openConversation.didInit = true;
  $('[data-cols]').classList.add('show-thread');
  state.socket.emit('conversation:open', { id }, (res) => {
    if (res?.error) return;
    state.convs.set(id, res.conversation);
    state.messages = res.messages;
    renderThread(); renderList(); renderDetails();
    input.focus({ preventScroll: true });
  });
}
$('[data-back]').addEventListener('click', () => { $('[data-cols]').classList.remove('show-thread'); state.activeId = null; location.hash = ''; renderList(); });

function renderThreadHead() {
  const c = state.convs.get(state.activeId); if (!c) return;
  const av = $('[data-t-avatar]');
  av.textContent = initials(c.name || c.email) || '•';
  av.classList.toggle('is-online', !!c.online);
  $('[data-t-name]').textContent = displayName(c);
  const sub = $('[data-t-sub]');
  const typing = state.typing.get(c.id);
  sub.classList.toggle('is-typing', !!typing);
  sub.textContent = typing ? 'typing…' : [c.online ? 'On the page now' : 'Left the page', c.email, c.topic].filter(Boolean).join(' · ');
  $('[data-t-status]').textContent = c.status === 'closed' ? 'Reopen' : 'Close';
}

function messageRow(m, prev) {
  if (m.sender === 'system') return el('div', { class: 'lc-system', text: `Auto-message to visitor: ${m.body}` });
  const grouped = prev && prev.sender === m.sender && prev.agentName === m.agentName && (m.createdAt - prev.createdAt) < 3 * 60 * 1000;
  const row = el('div', { class: `lc-row from-${m.sender}${grouped ? ' is-grouped' : ''}`, 'data-id': m.id });
  if (!grouped) row.append(el('div', { class: 'lc-meta' }, el('b', { text: m.sender === 'agent' ? (m.agentName === state.auth.name ? 'You' : m.agentName) : displayName(state.convs.get(m.conversationId) || { id: m.conversationId }) }), ` · ${timeFmt.format(m.createdAt).toLowerCase()}`));
  if (m.uploading) {
    m.uploadNode ||= uploadingNode(m.fileName);
    row.append(el('div', { class: 'lc-bubble lc-bubble-att' }, m.uploadNode));
  } else if (m.attachment) {
    row.append(el('div', { class: `lc-bubble lc-bubble-att${m.attachment.kind === 'image' ? ' is-image' : ''}` }, attachmentNode(m.attachment, getFileUrl)));
  } else row.append(el('div', { class: 'lc-bubble' }, richText(m.body)));
  if (m.failed) row.classList.add('is-failed');
  return row;
}

// ---------------------------------------------------------------- files
const getFileUrl = makeUrlCache((id) => new Promise((resolve) => {
  if (!state.socket?.connected) return resolve({ error: 'Offline' });
  state.socket.timeout(8000).emit('file:url', { id }, (err, res) => resolve(err ? { error: 'Timed out' } : res));
}));
const attachBtn = $('[data-attach]');
const fileInput = $('[data-file]');
function applyFeatures(f) {
  if (!f) return;
  state.features = f;
  attachBtn.hidden = !f.files;
  fileInput.setAttribute('accept', f.accept || '');
  $('[data-compose]').classList.toggle('has-attach', !!f.files);
}
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const f = [...fileInput.files]; fileInput.value = ''; sendFiles(f); });

async function sendFiles(files) {
  if (!state.features.files || !state.activeId || !files.length) return;
  const cid = state.activeId;
  for (const raw of files.slice(0, 5)) {
    let file;
    try { file = await prepareFile(raw, state.features.fileMaxMb); } catch (e) { alert(e.message); continue; }
    const m = { id: `up-${Math.random().toString(36).slice(2)}`, conversationId: cid, sender: 'agent', agentName: state.auth.name, body: '', createdAt: Date.now(), uploading: true, fileName: file.name || 'file' };
    if (state.activeId === cid) { state.messages.push(m); appendToThread(m); }
    try {
      const msg = await uploadFile({
        file,
        headers: { Authorization: `Bearer ${state.auth.token}`, 'X-Conversation-Id': cid, 'X-Socket-Id': state.socket?.id },
        onProgress: (p) => m.uploadNode?.setProgress(p),
      });
      swapMessage(m, msg);
    } catch (e) {
      Object.assign(m, { uploading: false, failed: true, body: `Could not send ${m.fileName}: ${e.message}` });
      swapMessage(m, m);
    }
  }
  if (files.length > 5) alert('You can send up to 5 files at a time.');
}
function swapMessage(oldM, newM) {
  const i = state.messages.indexOf(oldM);
  const row = msgBox.querySelector(`.lc-row[data-id="${oldM.id}"]`);
  if (i < 0) return;
  if (newM !== oldM && state.messages.some((x) => x.id === newM.id)) { state.messages.splice(i, 1); row?.remove(); return; }
  state.messages[i] = newM;
  const prev = state.messages[i - 1];
  if (row) row.replaceWith(messageRow(newM, prev && prev.sender !== 'system' ? prev : null));
  renderSeen();
}

function renderThread() {
  $('[data-empty]').hidden = true; $('[data-thread]').hidden = false;
  renderThreadHead();
  msgBox.replaceChildren();
  let prev = null; let lastDay = '';
  for (const m of state.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { msgBox.append(el('div', { class: 'lc-day', text: day === new Date().toDateString() ? 'Today' : dayFmt.format(m.createdAt) })); lastDay = day; prev = null; }
    msgBox.append(messageRow(m, prev && prev.sender !== 'system' ? prev : null)); prev = m;
  }
  renderSeen(); renderTyping();
  requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
}
function appendToThread(m) {
  const prev = state.messages[state.messages.length - 2];
  const near = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 160;
  const typing = msgBox.querySelector('.lc-typing');
  const row = messageRow(m, prev && prev.sender !== 'system' ? prev : null);
  typing ? msgBox.insertBefore(row, typing) : msgBox.append(row);
  renderSeen();
  if (near || m.sender === 'agent') requestAnimationFrame(() => { msgBox.scrollTop = msgBox.scrollHeight; });
}
function renderSeen() {
  msgBox.querySelectorAll('.lc-receipt').forEach((n) => n.remove());
  const last = [...state.messages].reverse().find((m) => m.sender === 'agent');
  if (!last) return;
  const row = msgBox.querySelector(`.lc-row[data-id="${last.id}"]`);
  if (row) row.append(el('span', { class: `lc-receipt${last.readAt ? ' is-seen' : ''}`, text: last.readAt ? 'Seen by visitor' : 'Delivered' }));
}
function renderTyping() {
  const on = state.typing.get(state.activeId);
  let t = msgBox.querySelector('.lc-typing');
  if (on && !t) { msgBox.append(el('div', { class: 'lc-typing' }, el('span', { class: 'lc-typing-dots' }, el('i'), el('i'), el('i')), el('span', { text: 'Visitor is typing' }))); msgBox.scrollTop = msgBox.scrollHeight; }
  else if (!on && t) t.remove();
}

function renderDetails() {
  const box = $('[data-details]');
  const c = state.convs.get(state.activeId);
  if (!c || box.hidden) return;
  const row = (k, v) => [el('dt', { text: k }), el('dd', {}, v || el('span', { class: 'ib-muted', text: 'Not given' }))];
  box.replaceChildren(...[
    el('h3', { text: displayName(c) }),
    el('dl', {},
      row('Email', c.email ? el('a', { href: `mailto:${c.email}`, text: c.email }) : null),
      row('Interested in', c.topic),
      row('Their local time', c.timezone ? localTime(c.timezone) : null),
      row('Came from', c.referrer || 'Direct visit'),
      row('Page', c.page),
      row('Browser', browserName(c.userAgent)),
      row('First message', c.createdAt ? fullFmt.format(c.createdAt) : null),
      row('Status', c.online ? 'On the page now' : 'Not on the page')),
    c.email ? el('a', { class: 'hx-btn', href: `mailto:${c.email}?subject=${encodeURIComponent('Following up on your chat with Plumb')}` }, 'Email a follow-up', el('span', { text: '→' })) : null,
    el('button', { class: 'ib-ghost', type: 'button', style: 'margin-top:10px;width:100%', text: 'Hide details', onclick: () => { box.hidden = true; } })].filter(Boolean));
}
$('[data-t-details]').addEventListener('click', () => { const box = $('[data-details]'); box.hidden = !box.hidden; renderDetails(); });

$('[data-t-status]').addEventListener('click', () => {
  const c = state.convs.get(state.activeId); if (!c) return;
  state.socket.emit('conversation:status', { conversationId: c.id, status: c.status === 'closed' ? 'open' : 'closed' }, () => {});
});

// Composer
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
let typingTimer; let typingOn = false;
input.addEventListener('input', () => {
  autosize(); sendBtn.disabled = !input.value.trim();
  if (!state.activeId) return;
  if (!typingOn) { typingOn = true; state.socket.emit('typing', { conversationId: state.activeId, typing: true }); }
  clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 2500);
});
function stopTyping() { clearTimeout(typingTimer); if (typingOn && state.activeId) state.socket.emit('typing', { conversationId: state.activeId, typing: false }); typingOn = false; }
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); } });
$('[data-compose]').addEventListener('submit', (e) => { e.preventDefault(); sendReply(); });
function sendReply() {
  const body = input.value.trim(); if (!body || !state.activeId) return;
  input.value = ''; autosize(); sendBtn.disabled = true; stopTyping();
  const cid = state.activeId;
  state.socket.emit('message', { conversationId: cid, body }, (res) => {
    if (res?.error) { input.value = body; autosize(); sendBtn.disabled = false; alert(res.error); return; }
    if (state.activeId === cid && !state.messages.some((m) => m.id === res.message.id)) { state.messages.push(res.message); appendToThread(res.message); }
  });
}
wireFileInputs({ dropZone: $('[data-thread]'), pasteTarget: input, onFiles: sendFiles, enabled: () => state.features.files && !!state.activeId });
$('[data-quick]').append(...QUICK_REPLIES.map((t) => el('button', { type: 'button', text: t.length > 46 ? t.slice(0, 44) + '…' : t, title: t, onclick: () => { input.value = t; autosize(); sendBtn.disabled = false; input.focus(); } })));

// ---------------------------------------------------------------- alerts
function chime() {
  try {
    const ctx = chime.ctx || (chime.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.setValueAtTime(660, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.45);
  } catch {}
}
function alertNew(m) {
  const c = state.convs.get(m.conversationId);
  const viewing = document.visibilityState === 'visible' && state.activeId === m.conversationId;
  if (viewing) return;
  chime();
  if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(c ? displayName(c) : 'New message', { body: m.attachment ? `Sent a file: ${m.attachment.name}` : m.body.slice(0, 140), tag: m.conversationId, icon: '/favicon.svg' });
    n.onclick = () => { window.focus(); openConversation(m.conversationId); n.close(); };
  }
}

// ---------------------------------------------------------------- socket
function start() {
  show('app');
  $('[data-me]').replaceChildren(el('span', { class: 'status-dot' }), `Online as ${state.auth.name}`);
  renderNotifyBtn();
  const socket = io({ auth: { role: 'agent', token: state.auth.token }, transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') { localStorage.removeItem(AUTH_KEY); state.auth = null; show('login'); $('[data-login-error]').textContent = 'Your session expired. Sign in again.'; socket.disconnect(); }
  });
  socket.on('session:expired', () => { localStorage.removeItem(AUTH_KEY); state.auth = null; socket.disconnect(); show('login'); $('[data-login-error]').textContent = 'Your session expired. Sign in again.'; });
  socket.on('ready', (r) => {
    applyFeatures(r.features);
    state.convs = new Map(r.conversations.map((c) => [c.id, c]));
    renderList();
    const fromHash = location.hash.slice(1);
    if (state.activeId || (fromHash && state.convs.has(fromHash))) openConversation(state.activeId || fromHash);
  });
  socket.on('agents', (p) => {
    state.presence = p;
    const others = p.agents.filter((a) => a !== state.auth.name);
    $('[data-me]').replaceChildren(el('span', { class: 'status-dot' }), `Online as ${state.auth.name}${others.length ? ` · ${others.join(', ')} also online` : ''}`);
  });
  socket.on('conversation:update', (c) => {
    if (!c) return;
    const isNew = !state.convs.has(c.id);
    if (c.id === state.activeId && document.visibilityState === 'visible') c.unread = 0;
    state.convs.set(c.id, c);
    renderList();
    if (isNew) $(`.ib-item[data-id="${c.id}"]`)?.classList.add('is-new');
    if (c.id === state.activeId) { renderThreadHead(); renderDetails(); }
  });
  socket.on('message', (m) => {
    const c = state.convs.get(m.conversationId);
    if (c) { c.lastBody = m.attachment ? `File: ${m.attachment.name}` : m.body; c.lastSender = m.sender; c.lastMessageAt = m.createdAt; }
    if (m.conversationId === state.activeId && !state.messages.some((x) => x.id === m.id)) {
      state.messages.push(m); appendToThread(m);
      if (m.sender === 'visitor' && document.visibilityState === 'visible') socket.emit('read', { conversationId: m.conversationId });
    }
    if (m.sender === 'visitor') { state.typing.delete(m.conversationId); renderTyping(); alertNew(m); }
    renderList();
  });
  socket.on('typing', (t) => {
    if (t.from !== 'visitor') return;
    t.typing ? state.typing.set(t.conversationId, true) : state.typing.delete(t.conversationId);
    renderList();
    if (t.conversationId === state.activeId) { renderTyping(); renderThreadHead(); }
  });
  socket.on('visitor:presence', (p) => {
    const c = state.convs.get(p.conversationId); if (!c) return;
    c.online = p.online; renderList();
    if (p.conversationId === state.activeId) { renderThreadHead(); renderDetails(); }
  });
  socket.on('read', (r) => {
    if (r.by !== 'visitor' || r.conversationId !== state.activeId) return;
    state.messages.forEach((m) => { if (m.sender === 'agent' && !m.readAt) m.readAt = r.at; });
    renderSeen();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.activeId) socket.emit('read', { conversationId: state.activeId });
  });
}

finishGoogleSignIn().then((handled) => { if (handled) return; if (state.auth?.token) start(); else show('login'); });
