// Home page: "who's online" status + the floating link to the chat page.
// The chat itself lives on /chat; this only shows whether the team is around.
const STORE_KEY = 'cairnly.chat.v1';
const $ = (sel) => document.querySelector(sel);

// Old links and bookmarks to the in-page chat (/#chat) now open the chat page.
if (location.hash === '#chat') location.replace('/chat');

const launcher = $('[data-launcher]');
const initials = (name) => (name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function avatar(text) { const s = document.createElement('span'); s.textContent = text; return s; }

function render({ online, agents = [] }) {
  const line = $('[data-presence-line]');
  if (line) {
    line.classList.toggle('is-online', online);
    $('[data-presence-text]').textContent = online ? 'Team online now, replies in minutes' : 'Team away, we reply within hours';
  }
  if (launcher) {
    launcher.classList.toggle('is-online', online);
    $('[data-launcher-status]').textContent = online ? 'Online now, replies in minutes' : 'Leave a message, we reply by email';
    $('[data-launcher-avatars]').replaceChildren(...(online && agents.length ? agents.slice(0, 2).map((a) => avatar(initials(a))) : [avatar('C.')]));
  }
}

// Someone who already started a chat on this device picks it up where they left off.
try {
  if (JSON.parse(localStorage.getItem(STORE_KEY))?.conversationId) {
    $('[data-launcher-label]').textContent = 'Continue your chat';
    launcher?.setAttribute('aria-label', 'Continue your chat with the team');
  }
} catch {}

let timer = 0;
async function refresh() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/presence', { cache: 'no-store' });
    if (res.ok) render(await res.json());
  } catch {}
  if (document.visibilityState === 'visible') timer = setTimeout(refresh, 60_000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
refresh();

// The floating link stays out of the way while the hero (with its own "Start a chat" button) is on screen.
const hero = $('.ed-opening');
if (launcher && hero && 'IntersectionObserver' in window) {
  new IntersectionObserver(([en]) => launcher.classList.toggle('is-away', en.isIntersecting), { rootMargin: '0px 0px -40% 0px' }).observe(hero);
} else launcher?.classList.remove('is-away');
