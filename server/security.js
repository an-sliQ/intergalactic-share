// Security helpers: client IP resolution, rate limiting, input sanitising, HTTP headers / CSP, origin checks.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';

// ---------------------------------------------------------------- client IP
// Behind a proxy the TCP peer is the proxy, so visitors would all share one rate-limit bucket.
// The leftmost X-Forwarded-For entry is attacker-controlled, so it is never trusted.
//   CLIENT_IP_HEADER  a header your platform overwrites itself (Render: true-client-ip, Cloudflare: cf-connecting-ip).
//                     When set, only that header is read.
//   TRUST_PROXY       number of proxies in front of the app (Caddy/nginx on the same box: 1, none: 0).
//                     The client is read that many hops from the right of X-Forwarded-For.
export function makeClientIp({ header = '', hops = 1 } = {}) {
  const h = header.trim().toLowerCase();
  const validHeader = /^[a-z0-9-]{1,64}$/.test(h) ? h : '';
  return function clientIp(headers, remoteAddress) {
    const peer = normalizeIp(remoteAddress) || 'unknown';
    if (validHeader) {
      const v = headers[validHeader];
      const first = String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim();
      return normalizeIp(first) || peer;
    }
    if (hops <= 0) return peer;
    const xff = String(headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const chain = [...xff, peer];
    const pick = chain[Math.max(0, chain.length - 1 - hops)];
    return normalizeIp(pick) || peer;
  };
}

function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  let s = ip.trim().replace(/^\[|\]$/g, '');
  if (s.startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7);
  return isIP(s) ? s : '';
}

// One person on IPv6 typically controls a whole /64, so rate limit by /64 rather than by address.
export function rateKey(ip) {
  if (isIP(ip) !== 6) return ip;
  const [head] = ip.split('%');
  const parts = expandV6(head);
  return parts ? `${parts.slice(0, 4).join(':')}::/64` : ip;
}
function expandV6(ip) {
  const [l, r] = ip.split('::');
  const left = l ? l.split(':') : [];
  const right = r !== undefined && r ? r.split(':') : [];
  if (ip.includes('::')) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...Array(fill).fill('0'), ...right];
  }
  return left.length === 8 ? left : null;
}

// ---------------------------------------------------------------- rate limiting
// Token buckets in memory. Bounded so an attacker rotating keys can't exhaust memory.
export function makeLimiter({ maxKeys = 50_000 } = {}) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
  }, 60_000);
  timer.unref();
  return function allow(key, { capacity = 8, refillPerSec = 0.5, cost = 1 } = {}) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value); // drop the oldest
      b = { tokens: capacity, at: now };
    } else {
      buckets.delete(key); // re-insert to keep Map order ≈ least recently used first
    }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    buckets.set(key, b);
    return ok;
  };
}

// ---------------------------------------------------------------- input
// Removes control characters (keeps newline/tab for message bodies) and invisible bidi overrides,
// which can make text in the inbox display differently from what it really says.
const CONTROL_MULTI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CONTROL_SINGLE = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
export function cleanText(s, max, { multiline = false } = {}) {
  if (typeof s !== 'string') return '';
  let out = s.normalize('NFC').replace(BIDI, '').replace(multiline ? CONTROL_MULTI : CONTROL_SINGLE, multiline ? '' : ' ');
  if (multiline) out = out.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  else out = out.replace(/\s+/g, ' ');
  return out.trim().slice(0, max);
}

// Strict on purpose: no "?", "&" or quotes, so the address can't smuggle extra fields into a mailto: link.
export const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Makes visitor text safe to post into Slack / Discord (no @everyone, <!channel>, or link spoofing).
export function webhookSafe(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@(everyone|here|channel)/gi, '@\u200B$1')
    .replace(/[`*_~|]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------- headers
// Hash every inline <script> (not JSON-LD) so the CSP can forbid all other inline script.
function inlineScriptHashes(publicDir) {
  const hashes = new Set();
  for (const f of readdirSync(publicDir).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(join(publicDir, f), 'utf8');
    for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1] || '';
      if (/\ssrc\s*=/.test(attrs) || /application\/ld\+json/i.test(attrs)) continue;
      hashes.add(`'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`);
    }
  }
  return [...hashes];
}

export function securityHeaders({ publicDir, production, extra = () => null }) {
  const scriptHashes = inlineScriptHashes(publicDir).join(' ');
  const cache = new Map();
  // extra(req) can add sources per page, e.g. the Supabase file host for images, or Supabase sign-in on /inbox.
  function buildCsp(x = {}) {
    const key = JSON.stringify(x);
    if (cache.has(key)) return cache.get(key);
    const j = (a) => (a && a.length ? ' ' + [...new Set(a)].join(' ') : '');
    const csp = [
      "default-src 'self'",
      `script-src 'self' ${scriptHashes}${j(x.script)}`.replace(/\s+/g, ' ').trim(),
      "style-src 'self' 'unsafe-inline'",   // style="" attributes only drive CSS variables for animation delays
      `img-src 'self' data: blob:${j(x.img)}`,
      "font-src 'self'",
      `connect-src 'self'${j(x.connect)}`,  // 'self' includes same-origin ws:/wss: for the live chat
      x.frame?.length ? `frame-src${j(x.frame)}` : "frame-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "manifest-src 'self'",
      production ? "frame-ancestors 'none'" : '',
      production ? 'upgrade-insecure-requests' : '',
    ].filter(Boolean).join('; ');
    cache.set(key, csp);
    return csp;
  }

  return (req, res, next) => {
    const x = extra(req) || {};
    res.setHeader('Content-Security-Policy', buildCsp(x));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()');
    // Google's sign-in popup must be able to report back to the inbox window.
    res.setHeader('Cross-Origin-Opener-Policy', x.popups ? 'same-origin-allow-popups' : 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (production) {
      res.setHeader('X-Frame-Options', 'DENY');
      if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
    }
    next();
  };
}

// ---------------------------------------------------------------- origin
// Blocks other websites from opening chat connections in their visitors' browsers (cross-site WebSocket hijacking).
export function makeOriginCheck({ allowed = [], production }) {
  const allowedHosts = new Set(allowed.map(hostOf).filter(Boolean));
  return function originOk(headers) {
    const origin = headers.origin;
    if (!origin) return true; // same-origin GETs and non-browser clients; browsers always send Origin cross-site
    const o = hostOf(origin);
    if (!o) return false;
    const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim().toLowerCase();
    if (o === host || allowedHosts.has(o)) return true;
    if (!production) return true; // dev previews behind rewriting proxies
    return false;
  };
}
function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}
