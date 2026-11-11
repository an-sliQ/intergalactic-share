// Live chat, visitor side. One panel that lives in the page (#chat-slot) or the floating drawer.
const TEAM_NAME = 'Plumb team';
const STORE_KEY = 'plumb.chat.v1';
const QUICK_STARTS = [
  { label: 'I need a new website', topic: 'A new website' },
  { label: 'Redesign my current site', topic: 'Website redesign' },
  { label: 'Automate a task with AI', topic: 'AI automation' },
  { label: 'An AI chat assistant', topic: 'An AI chat assistant' },
  { label: 'Get a price estimate', topic: 'Price estimate' },
  { label: 'Just exploring', topic: 'Exploring' },
];

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
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
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
  mode: 'inline',
  unread: 0,
  pending: new Map(),
};

// ---------------------------------------------------------------- DOM
const slot = $('#chat-slot');
const drawer = $('[data-drawer]');
const launcher = $('[data-launcher]');
if (!slot) throw new Error('chat slot missing');

const ui = {};
function buildPanel() {
  ui.avatars = el('div', { class: 'lc-avatars', 'aria-hidden': 'true' });
  ui.statusText = el('span', { text: 'Connecting…' });
  ui.status = el('span', { class: 'lc-status' }, el('i', { class: 'status-dot' }), ui.statusText);
  ui.conn = el('span', { class: 'lc-conn', text: 'Reconnecting' });
  ui.close = el('button', { class: 'lc-close', type: 'button', 'aria-label': 'Close chat', onclick: () => closeDrawer() });
  ui.close.append(svg(ICON_CLOSE));
  ui.thread = el('div', { class: 'lc-thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', tabindex: '0' });
  ui.input = el('textarea', { id: 'lc-input', rows: '1', placeholder: 'Write a message…', maxlength: '4000', autocomplete: 'off', enterkeyhint: 'send' });
  ui.send = el('button', { class: 'lc-send', type: 'submit', 'aria-label': 'Send message', disabled: true });
  ui.send.append(svg(ICON_SEND));
  ui.form = el('form', { class: 'lc-compose', novalidate: true },
    el('label', { class: 'sr-only', for: 'lc-input', text: 'Message' }), ui.input, ui.send);
  ui.panel = el('div', { class: 'lc', 'data-mode': 'inline' },
    el('header', { class: 'lc-head' }, ui.avatars,
      el('div', { class: 'lc-title' }, el('strong', { text: TEAM_NAME }), ui.status), ui.conn, ui.close),
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
}
function autosize() { ui.input.style.height = 'auto'; ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + 'px'; }

// ---------------------------------------------------------------- rendering
function nearBottom() { const t = ui.thread; return t.scrollHeight - t.scrollTop - t.clientHeight < 120; }
function scrollToBottom(force = false) { if (force || nearBottom()) requestAnimationFrame(() => { ui.thread.scrollTop = ui.thread.scrollHeight; }); }

function renderHeader() {
  const { online, agents } = state.presence;
  ui.avatars.replaceChildren(...(online && agents.length ? agents.slice(0, 3).map((a) => el('span', { text: initials(a) })) : [el('span', { text: 'P.' })]));
  ui.status.classList.toggle('is-online', online);
  ui.statusText.textContent = !state.connected && !state.socket?.connected ? 'Connecting…'
    : online ? `${agents.length === 1 ? `${agents[0]} is online` : agents.length > 1 ? `${agents[0]} +${agents.length - 1} online` : 'Online now'} · replies in minutes`
      : 'Away right now · we reply by email';
  // Page-wide presence indicators
  const line = $('[data-presence-line]');
  if (line) { line.classList.toggle('is-online', online); $('[data-presence-text]').textContent = online ? 'Team online now, replies in minutes' : 'Team away, we reply within hours'; }
  if (launcher) {
    launcher.classList.toggle('is-online', online);
    $('[data-launcher-status]').textContent = online ? 'Online now, replies in minutes' : 'Leave a message, we reply by email';
    $('[data-launcher-avatars]').replaceChildren(...(online && agents.length ? agents.slice(0, 2).map((a) => el('span', { text: initials(a) })) : [el('span', { text: 'P.' })]));
  }
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
  row.append(el('div', { class: 'lc-bubble' }, richText(m.body)));
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
function retry(m) { m.failed = false; m.pending = true; updateRow(m); deliver(m); }
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
let inlineVisible = false;
let heroVisible = true;
function panelVisible() { return document.visibilityState === 'visible' && (state.mode === 'drawer' || inlineVisible); }
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
  const badge = $('[data-launcher-badge]');
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  document.title = n ? `(${n}) New reply · ${baseTitle}` : baseTitle;
  updateLauncher();
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

// ---------------------------------------------------------------- drawer & launcher
function updateLauncher() {
  if (!launcher) return;
  launcher.hidden = false;
  launcher.classList.toggle('is-away', (heroVisible && !state.unread) || inlineVisible || state.mode === 'drawer');
  launcher.setAttribute('aria-expanded', String(state.mode === 'drawer'));
}
function openDrawer() {
  if (state.mode === 'drawer') { ui.input.focus(); return; }
  state.mode = 'drawer';
  ui.panel.dataset.mode = 'drawer';
  drawer.hidden = false;
  drawer.append(ui.panel);
  drawer.classList.remove('is-leaving'); drawer.classList.add('is-entering');
  if (matchMedia('(max-width:650px)').matches) document.documentElement.classList.add('menu-locked');
  fitDrawer();
  scrollToBottom(true);
  updateLauncher();
  markReadIfVisible();
  setTimeout(() => ui.input.focus({ preventScroll: true }), 60);
}
function closeDrawer() {
  if (state.mode !== 'drawer') return;
  drawer.classList.remove('is-entering'); drawer.classList.add('is-leaving');
  document.documentElement.classList.remove('menu-locked');
  const done = () => {
    drawer.hidden = true; drawer.classList.remove('is-leaving');
    state.mode = 'inline'; ui.panel.dataset.mode = 'inline'; fitDrawer();
    slot.append(ui.panel); scrollToBottom(true); updateLauncher();
    launcher?.focus({ preventScroll: true });
  };
  matchMedia('(prefers-reduced-motion: reduce)').matches ? done() : setTimeout(done, 280);
}
launcher?.addEventListener('click', openDrawer);

// Phones: keep the full-screen chat exactly the size of the visible area, so the
// on-screen keyboard never covers the message box (iOS doesn't resize 100dvh for it).
const vv = window.visualViewport;
const phone = matchMedia('(max-width:650px)');
function fitDrawer() {
  if (!vv || state.mode !== 'drawer' || !phone.matches) { drawer.style.removeProperty('--vvh'); drawer.style.removeProperty('top'); return; }
  drawer.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  drawer.style.top = `${Math.round(vv.offsetTop)}px`;
  if (document.activeElement === ui.input) scrollToBottom(true);
}
vv?.addEventListener('resize', fitDrawer);
vv?.addEventListener('scroll', fitDrawer);
phone.addEventListener?.('change', fitDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.mode === 'drawer') closeDrawer(); });

// Any "start a chat" link: scroll to the in-page chat when it's above it, otherwise open the drawer.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open-chat]');
  if (!a) return;
  e.preventDefault();
  const topic = a.dataset.topic;
  if (topic && !ui.input.value) { state.topic = topic; ui.input.value = `Hi, I'm interested in ${topic.toLowerCase()}. `; autosize(); ui.send.disabled = false; }
  document.querySelector('.mast.menu-open .menu-toggle')?.click();
  const slotTop = slot.getBoundingClientRect().top + scrollY;
  const linkTop = a.getBoundingClientRect().top + scrollY;
  if (state.mode !== 'drawer' && linkTop < slotTop) {
    const target = matchMedia('(max-width:900px)').matches ? slot : $('#chat');
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => { ui.input.focus({ preventScroll: true }); const v = ui.input.value; ui.input.setSelectionRange(v.length, v.length); }, 650);
  } else {
    openDrawer();
  }
});

new IntersectionObserver((entries) => {
  for (const en of entries) inlineVisible = en.isIntersecting && en.intersectionRatio > 0.25;
  updateLauncher(); markReadIfVisible();
}, { threshold: [0, 0.25, 0.5] }).observe(slot);
document.addEventListener('visibilitychange', markReadIfVisible);
const hero = document.querySelector('.ed-opening');
if (hero) new IntersectionObserver(([en]) => { heroVisible = en.isIntersecting; updateLauncher(); }, { rootMargin: '0px 0px -40% 0px' }).observe(hero);

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
updateLauncher();
connect();
