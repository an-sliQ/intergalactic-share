// Motion and small interactions. Everything is visible without JS; html.mo / html.gx arm the effects.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Year
$$('[data-year]').forEach((n) => { n.textContent = new Date().getFullYear(); });

// ---------- Mobile menu
const mast = document.querySelector('.mast');
const toggle = document.querySelector('.menu-toggle');
toggle?.addEventListener('click', () => {
  const open = !mast.classList.contains('menu-open');
  mast.classList.toggle('menu-open', open);
  document.documentElement.classList.toggle('menu-locked', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.firstChild.textContent = open ? 'Close ' : 'Menu ';
});
$$('#site-nav a:not([data-open-chat])').forEach((a) => a.addEventListener('click', () => { if (mast.classList.contains('menu-open')) toggle.click(); }));

// ---------- Footer signoff: split into letters
const signoff = document.querySelector('.ed-signoff');
if (signoff) {
  const word = signoff.firstChild.textContent;
  const dot = signoff.querySelector('span');
  signoff.firstChild.remove();
  [...word].forEach((ch, i) => { const s = document.createElement('span'); s.className = 'mo-letter'; s.style.setProperty('--i', i); s.textContent = ch; signoff.insertBefore(s, dot); });
  dot.classList.add('mo-letter'); dot.style.setProperty('--i', word.length);
  const letters = $$('.mo-letter', signoff).slice(0, -1);
  signoff.addEventListener('pointermove', (e) => {
    const hit = letters.find((l) => { const r = l.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right; });
    letters.forEach((l) => l.classList.toggle('is-lift', l === hit));
  });
  signoff.addEventListener('pointerleave', () => letters.forEach((l) => l.classList.remove('is-lift')));
}

// ---------- Statement: split words so each one darkens as it crosses the reading line
const statement = document.querySelector('[data-statement]');
const statementWords = [];
if (statement) {
  const walk = (node, inEm) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(part); return; }
          const s = document.createElement('span'); s.className = inEm ? 'hx-w hx-w-em' : 'hx-w'; s.textContent = part;
          statementWords.push(s); frag.append(s);
        });
        child.replaceWith(frag);
      } else if (child.nodeType === 1) walk(child, inEm || child.tagName === 'EM');
    }
  };
  walk(statement, false);
}

// ---------- Reveal on scroll
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    en.target.classList.add('is-in');
    if (en.target.classList.contains('mo-strip')) startPacket();
    io.unobserve(en.target);
  }
}, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
$$('[data-mo-reveal], .mo-strip, .hx-proof, .hx-step, .ed-signoff, .is-drawable, .hx-quote-main').forEach((n) => io.observe(n));

// Strip packet travelling along the wire (SVG SMIL, started once the drawing is in view)
function startPacket() {
  if (reduce) return;
  const motion = document.getElementById('packet-motion');
  setTimeout(() => { try { motion?.beginElement(); } catch {} }, 2300);
}

// ---------- Scroll-linked: statement words + process rail
const rail = document.querySelector('.hx-rail span');
const process = document.querySelector('.hx-process');
let ticking = false;
function onScroll() {
  ticking = false;
  const vh = innerHeight;
  if (statementWords.length) {
    const line = vh * 0.62;
    for (const w of statementWords) w.classList.toggle('is-on', w.getBoundingClientRect().top < line);
  }
  if (rail && process) {
    const r = process.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (vh * 0.8 - r.top) / (r.height * 0.75)));
    rail.style.setProperty('--p', p.toFixed(3));
  }
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener('resize', onScroll);
onScroll();

// ---------- Follow cursor over the invitation
const cursor = document.querySelector('.mo-cursor');
const zone = document.querySelector('.re-invitation-link');
if (cursor && zone && !reduce && matchMedia('(hover:hover) and (pointer:fine)').matches) {
  let x = -200, y = -200, tx = -200, ty = -200, raf = 0;
  const loop = () => {
    x += (tx - x) * 0.2; y += (ty - y) * 0.2;
    cursor.style.setProperty('--x', `${x}px`); cursor.style.setProperty('--y', `${y}px`);
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 ? requestAnimationFrame(loop) : 0;
  };
  zone.addEventListener('pointerenter', (e) => { tx = x = e.clientX; ty = y = e.clientY; cursor.classList.add('is-on'); loop(); });
  zone.addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; if (!raf) raf = requestAnimationFrame(loop); });
  zone.addEventListener('pointerleave', () => cursor.classList.remove('is-on'));
}
