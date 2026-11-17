// Live chat, visitor side. Runs on the /chat page and mounts the panel into #chat-slot.
import { prepareFile, uploadFile, makeUrlCache, attachmentNode, uploadingNode, wireFileInputs, ICON_CLIP } from './attachments.js';
const TEAM_NAME = 'Cairnly team';
const STORE_KEY = 'cairnly.chat.v1';
const QUICK_STARTS = [
  { label: 'I need a new website', topic: 'A new website' },
  { label: 'Redesign my current site', topic: 'Website redesign' },
  { label: 'Automate a task with AI', topic: 'AI automation' },
  { label: 'An AI chat assistant', topic: 'An AI chat assistant' },
  { label: 'Get a price estimate', topic: 'Price estimate' },
  { label: 'Just exploring', topic: 'Exploring' },
];
const LINK_TOPICS = [...QUICK_STARTS.map((q) => q.topic), 'Integrations'];

const $ = (sel, root = document) => root.querySelector(sel);
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
const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4L19 7"/></svg>';
const ICON_SEEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12.5l4 4 8.5-9M10.5 16.5l1 0 8.5-9"/></svg>';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtTime = (ts) => timeFmt.format(new Date(ts)).toLowerCase();
const initials = (name) => (name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
function saveStore(patch) { const s = { ...loadStore(), ...patch }; try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} return s; }

// Render text safely, turning URLs and emails into links. Never uses innerHTML for user content.
function richText(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|([\w.+-]+@[\w-]+\.[\w.-]+\w)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const href = m[1] ? m[1] : `mailto:${m[2]}`;
    frag.append(el('a', { href, target: m[1] ? '_blank' : null, rel: 'noopener noreferrer nofollow', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// ---------------------------------------------------------------- state
const state = {
  socket: null,
  connected: false,
  conversationId: loadStore().conversationId || null,
  token: loadStore().token || null,
  profile: { name: null, email: null, topic: null },
  messages: [],
  presence: { online: false, agents: [] },
  agentReadAt: 0,
  agentTyping: null,
  topic: null,
  unread: 0,
  pending: new Map(),
  features: { files: false, fileMaxMb: 10, accept: '' },
};

// ---------------------------------------------------------------- DOM
const slot = $('#chat-slot');
if (!slot) throw new Error('chat slot missing');

const ui = {};
function buildPanel() {
  ui.avatars = el('div', { class: 'lc-avatars', 'aria-hidden': 'true' });
  ui.statusText = el('span', { text: 'Connecting…' });
  ui.status = el('span', { class: 'lc-status' }, el('i', { class: 'status-dot' }), ui.statusText);
  ui.conn = el('span', { class: 'lc-conn', text: 'Reconnecting' });
  ui.thread = el('div', { class: 'lc-thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', tabindex: '0' });
  ui.input = el('textarea', { id: 'lc-input', rows: '1', placeholder: 'Write a message…', maxlength: '4000', autocomplete: 'off', enterkeyhint: 'send' });
  ui.send = el('button', { class: 'lc-send', type: 'submit', 'aria-label': 'Send message', disabled: true });
  ui.send.append(svg(ICON_SEND));
  ui.file = el('input', { type: 'file', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', multiple: true });
  ui.attach = el('button', { class: 'lc-attach', type: 'button', 'aria-label': 'Attach a file', title: 'Attach a file', hidden: true, onclick: () => ui.file.click() });
  ui.attach.append(svg(ICON_CLIP));
  ui.file.addEventListener('change', () => { const f = [...ui.file.files]; ui.file.value = ''; sendFiles(f); });
  ui.form = el('form', { class: 'lc-compose', novalidate: true },
    el('label', { class: 'sr-only', for: 'lc-input', text: 'Message' }), ui.attach, ui.file, ui.input, ui.send);
  ui.panel = el('div', { class: 'lc', 'data-mode': 'page' },
    el('header', { class: 'lc-head' }, ui.avatars,
      el('div', { class: 'lc-title' }, el('strong', { text: TEAM_NAME }), ui.status), ui.conn),
    ui.thread,
    ui.form,
    el('p', { class: 'lc-foot' },
      el('span', { text: 'Real people reply here. Your details are only used to answer you.' }),
      el('span', {}, el('kbd', { text: 'Enter' }), ' to send')));
  slot.append(ui.panel);

  ui.form.addEventListener('submit', (e) => { e.preventDefault(); sendFromInput(); });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFromInput(); }
  });
  ui.input.addEventListener('input', () => { autosize(); ui.send.disabled = !ui.input.value.trim(); signalTyping(); });
  wireFileInputs({ dropZone: ui.panel, pasteTarget: ui.input, onFiles: sendFiles, enabled: () => state.features.files });
}
function applyFeatures(f) {
  if (!f) return;
  state.features = f;
  ui.attach.hidden = !f.files;
  ui.file.setAttribute('accept', f.accept || '');
  ui.form.classList.toggle('has-attach', !!f.files);
}
function autosize() { ui.input.style.height = 'auto'; ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + 'px'; }

// ---------------------------------------------------------------- rendering
function nearBottom() { const t = ui.thread; return t.scrollHeight - t.scrollTop - t.clientHeight < 120; }
function scrollToBottom(force = false) { if (force || nearBottom()) requestAnimationFrame(() => { ui.thread.scrollTop = ui.thread.scrollHeight; }); }

function renderHeader() {
  const { online, agents } = state.presence;
  ui.avatars.replaceChildren(...(online && agents.length ? agents.slice(0, 3).map((a) => el('span', { text: initials(a) })) : [el('span', { text: 'C.' })]));
  ui.status.classList.toggle('is-online', online);
  ui.statusText.textContent = !state.connected && !state.socket?.connected ? 'Connecting…'
    : online ? `${agents.length === 1 ? `${agents[0]} is online` : agents.length > 1 ? `${agents[0]} +${agents.length - 1} online` : 'Online now'} · replies in minutes`
      : 'Away right now · we reply by email';
  // Page-wide presence indicators
  const line = $('[data-presence-line]');
  if (line) { line.classList.toggle('is-online', online); $('[data-presence-text]').textContent = online ? 'Team online now, replies in minutes' : 'Team away, we reply within hours'; }
}

function renderWelcome() {
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'lc-day', text: 'Today' }));
  frag.append(el('div', { class: 'lc-row from-agent', 'data-welcome': '' },
    el('div', { class: 'lc-meta' }, el('b', { text: TEAM_NAME })),
    el('div', { class: 'lc-bubble', text: 'Hi, tell us what you’re working on: a new website, an AI automation, or both. A real person on the team will reply right here.' })));
  if (!state.messages.some((m) => m.sender === 'visitor')) {
    const chips = el('div', { class: 'lc-chips', 'data-chips': '' }, el('span', { class: 'lc-chips-label', text: 'Or start with' }));
    for (const q of QUICK_STARTS) {
      chips.append(el('button', { class: 'lc-chip', type: 'button', text: q.label, onclick: () => { state.topic = q.topic; send(q.label); } }));
    }
    frag.append(chips);
  }
  return frag;
}

function messageNode(m, prev) {
  if (m.sender === 'system') return el('div', { class: 'lc-system', 'data-id': m.id ?? '', text: m.body });
  const from = m.sender === 'visitor' ? 'from-visitor' : 'from-agent';
  const grouped = prev && prev.sender === m.sender && prev.agentName === m.agentName && (m.createdAt - prev.createdAt) < 3 * 60 * 1000;
  const row = el('div', { class: `lc-row ${from}${grouped ? ' is-grouped' : ''}${m.pending ? ' is-pending' : ''}`, 'data-id': m.id ?? '', 'data-client': m.clientId ?? '' });
  if (!grouped) {
    row.append(el('div', { class: 'lc-meta' },
      m.sender === 'agent' ? el('b', { text: m.agentName || TEAM_NAME }) : 'You',
      ` · ${fmtTime(m.createdAt)}`));
  }
  if (m.uploading) {
    m.uploadNode ||= uploadingNode(m.fileName);
    row.append(el('div', { class: 'lc-bubble lc-bubble-att' }, m.uploadNode));
  } else if (m.attachment) {
    row.append(el('div', { class: `lc-bubble lc-bubble-att${m.attachment.kind === 'image' ? ' is-image' : ''}` }, attachmentNode(m.attachment, getFileUrl)));
  } else row.append(el('div', { class: 'lc-bubble' }, richText(m.body)));
  return row;
}

function renderAll() {
  ui.thread.replaceChildren(renderWelcome());
  let prev = null;
  for (const m of state.messages) { ui.thread.append(messageNode(m, prev)); prev = m; }
  renderTail();
  scrollToBottom(true);
}

function appendMessage(m) {
  const prev = [...state.messages].reverse().find((x) => x !== m) || null;
  ui.thread.querySelector('[data-chips]')?.remove();
  const tail = ui.thread.querySelector('[data-tail]');
  const node = messageNode(m, prev && prev.sender !== 'system' ? prev : null);
  if (tail) ui.thread.insertBefore(node, tail); else ui.thread.append(node);
  renderTail();
  scrollToBottom(m.sender === 'visitor');
}

// Tail = receipt on the last visitor message + contact card + typing indicator.
function renderTail() {
  ui.thread.querySelectorAll('.lc-receipt').forEach((n) => n.remove());
  const lastVisitor = [...state.messages].reverse().find((m) => m.sender === 'visitor');
  if (lastVisitor) {
    const row = ui.thread.querySelector(lastVisitor.id ? `.lc-row[data-id="${lastVisitor.id}"]` : `.lc-row[data-client="${lastVisitor.clientId}"]`);
    if (row) {
      let receipt;
      if (lastVisitor.failed) {
        receipt = el('span', { class: 'lc-receipt' }, 'Not sent. ', el('button', { class: 'lc-retry', type: 'button', text: 'Retry', onclick: () => retry(lastVisitor) }));
      } else if (lastVisitor.pending) {
        receipt = el('span', { class: 'lc-receipt', text: 'Sending…' });
      } else {
        const seen = state.agentReadAt >= lastVisitor.createdAt || !!lastVisitor.readAt;
        receipt = el('span', { class: `lc-receipt${seen ? ' is-seen' : ''}` }, svg(seen ? ICON_SEEN : ICON_CHECK), seen ? 'Seen' : 'Delivered');
      }
      row.append(receipt);
    }
  }

  let tail = ui.thread.querySelector('[data-tail]');
  if (!tail) { tail = el('div', { 'data-tail': '', style: 'display:contents' }); ui.thread.append(tail); }
  else ui.thread.append(tail); // keep last

  // Contact card: once the visitor has said something and we don't have an email yet.
  const hasVisitorMsg = state.messages.some((m) => m.sender === 'visitor' && !m.pending);
  let card = tail.querySelector('.lc-card');
  if (hasVisitorMsg && !state.profile.email && !card) tail.prepend(contactCard());
  if (state.profile.email && card && !card.dataset.done) card.remove();

  let typing = tail.querySelector('.lc-typing');
  if (state.agentTyping && !typing) {
    typing = el('div', { class: 'lc-typing' }, el('span', { class: 'lc-typing-dots' }, el('i'), el('i'), el('i')), el('span', { text: `${state.agentTyping} is typing` }));
    tail.append(typing); scrollToBottom();
  } else if (!state.agentTyping && typing) typing.remove();
  else if (typing) typing.lastChild.textContent = `${state.agentTyping} is typing`;
}

function contactCard() {
  const away = !state.presence.online;
  const err = el('p', { class: 'lc-card-error', role: 'alert' });
  const name = el('input', { name: 'name', autocomplete: 'name', placeholder: 'Jane Smith', value: state.profile.name || '' });
  const email = el('input', { name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'jane@company.com', required: true });
  const btn = el('button', { type: 'submit' }, 'Save and notify me', svg(ICON_SEND));
  const card = el('div', { class: 'lc-card' },
    el('h4', { text: away ? 'We’re away. Where should we reply?' : 'Where should we reply if you step away?' }),
    el('p', { text: 'We’ll answer here and send a copy to your inbox. No mailing lists.' }),
    el('form', { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const v = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { err.textContent = 'Enter an email address so we can reply.'; email.focus(); return; }
      btn.disabled = true;
      state.socket.emit('profile', { name: name.value.trim(), email: v, topic: state.topic }, (res) => {
        btn.disabled = false;
        if (res?.error) { err.textContent = res.error; return; }
        state.profile.email = v; state.profile.name = name.value.trim() || state.profile.name;
        card.dataset.done = '1';
        card.replaceChildren(el('div', { class: 'lc-card-done' }, svg(ICON_CHECK), `Thanks${state.profile.name ? `, ${state.profile.name.split(' ')[0]}` : ''}. If you leave, we’ll reply to ${v}.`));
      });
    } },
    el('label', {}, 'Name', name), el('label', {}, 'Email', email), btn, err));
  return card;
}

// ---------------------------------------------------------------- sending
function sendFromInput() {
  const body = ui.input.value.trim();
  if (!body) return;
  ui.input.value = ''; autosize(); ui.send.disabled = true;
  send(body);
  ui.input.focus();
}

function send(body) {
  const clientId = Math.random().toString(36).slice(2);
  const m = { clientId, sender: 'visitor', body, createdAt: Date.now(), pending: true };
  state.messages.push(m);
  appendMessage(m);
  deliver(m);
  stopTyping();
}

function deliver(m) {
  const timeout = setTimeout(() => { if (m.pending) { m.pending = false; m.failed = true; updateRow(m); } }, 12000);
  state.socket.emit('message', { body: m.body, topic: state.topic }, (res) => {
    clearTimeout(timeout);
    if (!res || res.error) { m.pending = false; m.failed = true; updateRow(m); if (res?.error) showSystem(res.error); return; }
    if (res.token) { state.conversationId = res.conversationId; state.token = res.token; saveStore({ conversationId: res.conversationId, token: res.token }); state.socket.auth = authPayload(); }
    Object.assign(m, res.message, { pending: false, failed: false });
    updateRow(m);
  });
}
function retry(m) { m.failed = false; m.pending = true; updateRow(m); if (m.file) deliverFile(m); else deliver(m); }

// ---------------------------------------------------------------- files
const getFileUrl = makeUrlCache((id) => new Promise((resolve) => {
  if (!state.socket?.connected) return resolve({ error: 'Offline' });
  state.socket.timeout(8000).emit('file:url', { id }, (err, res) => resolve(err ? { error: 'Timed out' } : res));
}));

async function sendFiles(files) {
  if (!state.features.files || !files.length) return;
  if (!state.conversationId || !state.token) {
    showSystem('Send a quick message first so we know what it’s about, then attach your files.');
    ui.input.focus(); return;
  }
  for (const raw of files.slice(0, 5)) {
    let file;
    try { file = await prepareFile(raw, state.features.fileMaxMb); } catch (e) { showSystem(e.message); continue; }
    const clientId = Math.random().toString(36).slice(2);
    const m = { clientId, sender: 'visitor', body: '', createdAt: Date.now(), pending: true, uploading: true, file, fileName: file.name || 'file' };
    state.messages.push(m);
    appendMessage(m);
    deliverFile(m);
  }
  if (files.length > 5) showSystem('You can send up to 5 files at a time.');
}

async function deliverFile(m) {
  m.uploading = true;
  replaceRow(m);
  try {
    const msg = await uploadFile({
      file: m.file,
      headers: { 'X-Conversation-Id': state.conversationId, 'X-Conversation-Token': state.token, 'X-Socket-Id': state.socket?.id },
      onProgress: (p) => m.uploadNode?.setProgress(p),
    });
    if (state.messages.some((x) => x !== m && x.id === msg.id)) { state.messages = state.messages.filter((x) => x !== m); ui.thread.querySelector(`.lc-row[data-client="${m.clientId}"]`)?.remove(); renderTail(); return; }
    Object.assign(m, msg, { pending: false, failed: false, uploading: false, file: null, uploadNode: null });
  } catch (e) {
    Object.assign(m, { pending: false, failed: true });
    showSystem(e.message);
  }
  replaceRow(m);
}
function replaceRow(m) {
  const row = ui.thread.querySelector(`.lc-row[data-client="${m.clientId}"]`);
  if (!row) return;
  const i = state.messages.indexOf(m);
  const prev = i > 0 ? state.messages[i - 1] : null;
  const node = messageNode(m, prev && prev.sender !== 'system' ? prev : null);
  node.classList.toggle('is-failed', !!m.failed);
  row.replaceWith(node);
  renderTail();
}
function updateRow(m) {
  const row = ui.thread.querySelector(`.lc-row[data-client="${m.clientId}"]`);
  if (row) { row.classList.toggle('is-pending', !!m.pending); row.classList.toggle('is-failed', !!m.failed); if (m.id) row.dataset.id = m.id; }
  renderTail();
}
function showSystem(text) { const m = { sender: 'system', body: text, createdAt: Date.now() }; state.messages.push(m); appendMessage(m); }

let typingTimer = null; let typingOn = false;
function signalTyping() {
  if (!state.conversationId || !state.socket?.connected) return;
  if (!typingOn) { typingOn = true; state.socket.emit('typing', true); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 2500);
}
function stopTyping() { clearTimeout(typingTimer); if (typingOn) { typingOn = false; state.socket?.emit('typing', false); } }

// ---------------------------------------------------------------- visibility, read receipts, unread
function panelVisible() { return document.visibilityState === 'visible'; }
function markReadIfVisible() {
  if (!panelVisible()) return;
  if (state.messages.some((m) => m.sender === 'agent' && !m.readAt)) {
    state.messages.forEach((m) => { if (m.sender === 'agent') m.readAt = m.readAt || Date.now(); });
    state.socket?.emit('read');
  }
  setUnread(0);
}
function setUnread(n) {
  state.unread = n;
  document.title = n ? `(${n}) New reply · ${baseTitle}` : baseTitle;
}
const baseTitle = document.title;

function chime() {
  try {
    const ctx = chime.ctx || (chime.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
  } catch {}
}

// ---------------------------------------------------------------- page
// Phones: the chat fills the screen. Size it to the visible area so the on-screen
// keyboard never covers the message box (iOS doesn't shrink 100dvh for the keyboard).
const vv = window.visualViewport;
const phone = matchMedia('(max-width:650px)');
const root = document.documentElement;
function fitViewport() {
  if (!vv || !phone.matches) { root.style.removeProperty('--vvh'); root.style.removeProperty('--vvt'); return; }
  root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
  if (document.activeElement === ui.input) scrollToBottom(true);
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
phone.addEventListener?.('change', fitViewport);

// Links like /chat?topic=AI%20automation pre-fill the first message (known topics only).
function applyLinkTopic() {
  const params = new URLSearchParams(location.search);
  const topic = params.get('topic');
  if (!params.has('topic')) return;
  history.replaceState(null, '', location.pathname + location.hash); // a reload shouldn't refill the box
  if (!LINK_TOPICS.includes(topic) || state.messages.some((m) => m.sender === 'visitor')) return;
  state.topic = topic;
  const phrase = topic.split(' ').map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase())).join(' '); // keeps "AI"
  ui.input.value = `Hi, I'm interested in ${phrase}. `;
  autosize(); ui.send.disabled = false;
}

// Ready to type straight away on computers. Phones wait for a tap, so the keyboard doesn't hide the welcome.
function focusComposer() {
  if (!matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  ui.input.focus({ preventScroll: true });
  const v = ui.input.value; ui.input.setSelectionRange(v.length, v.length);
}

document.addEventListener('visibilitychange', markReadIfVisible);
addEventListener('focus', markReadIfVisible);

// ---------------------------------------------------------------- socket
function authPayload() { return state.conversationId && state.token ? { role: 'visitor', conversationId: state.conversationId, token: state.token } : { role: 'visitor' }; }

function connect() {
  if (typeof io !== 'function') { setTimeout(connect, 200); return; }
  const socket = io({ auth: authPayload(), transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    state.connected = true; ui.conn.classList.remove('is-on');
    socket.emit('context', { page: location.pathname + location.search, referrer: document.referrer, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    renderHeader();
  });
  socket.on('disconnect', () => { state.connected = false; ui.conn.classList.add('is-on'); });
  socket.io.on('reconnect_attempt', () => { socket.auth = authPayload(); });

  socket.on('session', (s) => {
    state.presence = s.presence;
    applyFeatures(s.features);
    if (!s.conversationId && state.conversationId) { state.conversationId = null; state.token = null; saveStore({ conversationId: null, token: null }); }
    if (s.conversation) state.profile = { ...state.profile, ...s.conversation };
    // Keep unsent local messages when reconnecting.
    const local = state.messages.filter((m) => m.pending || m.failed);
    state.messages = [...s.messages, ...local];
    const lastAgentRead = s.messages.filter((m) => m.sender === 'visitor' && m.readAt).map((m) => m.readAt);
    state.agentReadAt = lastAgentRead.length ? Math.max(...lastAgentRead) : 0;
    renderHeader(); renderAll();
    local.forEach((m) => { if (m.failed) retry(m); });
    markReadIfVisible();
  });

  socket.on('presence', (p) => { state.presence = p; renderHeader(); const card = ui.thread.querySelector('.lc-card:not([data-done]) h4'); if (card) card.textContent = p.online ? 'Where should we reply if you step away?' : 'We’re away. Where should we reply?'; });

  socket.on('message', (m) => {
    if (state.messages.some((x) => x.id === m.id)) return;
    state.messages.push(m);
    appendMessage(m);
    if (m.sender === 'agent') {
      state.agentTyping = null; renderTail();
      if (panelVisible()) markReadIfVisible();
      else { setUnread(state.unread + 1); chime(); }
    }
  });

  socket.on('typing', (t) => {
    if (t.from !== 'agent') return;
    state.agentTyping = t.typing ? (t.name || 'The team') : null;
    renderTail();
    clearTimeout(state.typingClear);
    if (t.typing) state.typingClear = setTimeout(() => { state.agentTyping = null; renderTail(); }, 8000);
  });

  socket.on('read', (r) => { if (r.by === 'agent') { state.agentReadAt = r.at; renderTail(); } });
  socket.on('connect_error', () => { ui.conn.classList.add('is-on'); });
}

buildPanel();
renderHeader();
renderAll();
applyLinkTopic();
fitViewport();
focusComposer();
connect();
