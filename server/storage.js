// Supabase Storage client (plain fetch, no SDK) with usage caps that keep the project inside the free plan.
//
// Supabase Free (no card, cannot be billed): 1 GB file storage, 5 GB egress a month, 50 MB per file.
// Going over never costs money on Free, but Supabase may restrict the project, so the app stops itself first:
// uploads pause at STORAGE_CAP_MB and file viewing pauses at EGRESS_CAP_MB (estimated) for the rest of the month.
//
// One private bucket holds everything:  files/<conversation>/<random id>   and   backups/…
// The bucket is created (private) automatically on first start.
import { supabaseBaseUrl } from './supabase-url.js';

const MB = 1024 * 1024;

export const FILE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf', 'text/plain', 'text/csv', 'video/mp4', 'video/quicktime',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/gzip',
];

export function makeStorage(env, { log = console } = {}) {
  let db = null; // attached after the database is opened (it may first be restored from storage)
  const { url } = supabaseBaseUrl(env.SUPABASE_URL);
  const key = (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const bucket = (env.SUPABASE_BUCKET || 'chat').trim();
  const enabled = Boolean(url && key && /^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket));
  const api = `${url}/storage/v1`;

  // New keys (sb_secret_…) go in the apikey header only. Legacy service_role JWTs also go in Authorization.
  const headers = (extra = {}) => ({ apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), ...extra });
  const path = (k) => k.split('/').map(encodeURIComponent).join('/');

  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const limits = {
    storageBytes: num(env.STORAGE_CAP_MB, 800) * MB,   // free: 1 GB
    egressBytes: num(env.EGRESS_CAP_MB, 3500) * MB,    // free: 5 GB a month
  };

  // ---- usage counters (memory, saved in the database, which is itself backed up) ----
  const monthNow = () => new Date().toISOString().slice(0, 7);
  let usage = { month: monthNow(), egress: 0 };
  function loadUsage() {
    try {
      const saved = JSON.parse(db?.kvGet('storage_usage') || 'null');
      if (saved && saved.month === monthNow()) usage = { month: saved.month, egress: Number(saved.egress) || 0 };
    } catch { /* fresh counters */ }
  }
  function persistUsage() { try { db?.kvSet('storage_usage', JSON.stringify(usage)); } catch { /* ignore */ } }
  function roll() { const m = monthNow(); if (usage.month !== m) usage = { month: m, egress: 0 }; }
  function canEgress(bytes = 0) { roll(); return usage.egress + bytes <= limits.egressBytes; }
  function countEgress(bytes) { roll(); usage.egress += bytes; persistUsage(); }

  class CapError extends Error { constructor(m) { super(m); this.code = 'STORAGE_CAP'; } }

  async function call(method, p, { body, headers: h = {}, timeout = 60_000 } = {}) {
    if (!enabled) throw new Error('Supabase Storage is not configured');
    return fetch(`${api}${p}`, { method, body, headers: headers(h), signal: AbortSignal.timeout(timeout) });
  }
  const isNotFound = async (res) => res.status === 404 || (res.status === 400 && /not.?found/i.test(await res.clone().text()));

  // Create the private bucket if it doesn't exist; make sure it stays private.
  async function ensureBucket() {
    const res = await call('GET', `/bucket/${encodeURIComponent(bucket)}`, { timeout: 15_000 });
    if (res.ok) {
      const b = await res.json();
      if (b.public) {
        log.warn(`  ⚠  Bucket "${bucket}" was public. Switching it to private.`);
        await call('PUT', `/bucket/${encodeURIComponent(bucket)}`, { body: JSON.stringify({ public: false }), headers: { 'Content-Type': 'application/json' } });
      }
      return 'exists';
    }
    if (!(await isNotFound(res))) throw new Error(`Storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const made = await call('POST', '/bucket', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 50 * MB, allowed_mime_types: FILE_MIME_TYPES }),
    });
    if (!made.ok && made.status !== 409) throw new Error(`Could not create bucket: ${made.status} ${(await made.text()).slice(0, 200)}`);
    log.log(`  ✚  Created private storage bucket "${bucket}".`);
    return 'created';
  }

  async function put(k, buf, { contentType = 'application/octet-stream' } = {}) {
    const res = await call('POST', `/object/${encodeURIComponent(bucket)}/${path(k)}`, {
      body: buf, headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': '3600' },
    });
    if (!res.ok) throw new Error(`Storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function get(k) {
    const res = await call('GET', `/object/${encodeURIComponent(bucket)}/${path(k)}`);
    if (await isNotFound(res)) return null;
    if (!res.ok) throw new Error(`Storage download ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    countEgress(buf.length);
    return buf;
  }

  async function del(k) {
    const res = await call('DELETE', `/object/${encodeURIComponent(bucket)}`, {
      body: JSON.stringify({ prefixes: [k] }), headers: { 'Content-Type': 'application/json' }, timeout: 30_000,
    });
    if (!res.ok && !(await isNotFound(res))) throw new Error(`Storage delete ${res.status}`);
  }

  // Short-lived private link. One link is reused for everyone for most of its life, and its size is counted
  // once toward the monthly egress estimate.
  const linkCache = new Map(); // key -> { url, exp }
  async function signedUrl(k, { expiresSec = 1800, size = 0, downloadName = null } = {}) {
    const cacheKey = `${k}|${downloadName || ''}`;
    const hit = linkCache.get(cacheKey);
    if (hit && hit.exp - Date.now() > 5 * 60_000) return { url: hit.url, expiresAt: hit.exp - 60_000 };
    if (!canEgress(size)) throw new CapError('Monthly egress cap reached');
    const res = await call('POST', `/object/sign/${encodeURIComponent(bucket)}/${path(k)}`, {
      body: JSON.stringify({ expiresIn: expiresSec }), headers: { 'Content-Type': 'application/json' }, timeout: 15_000,
    });
    if (!res.ok) throw new Error(`Storage sign ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const signed = data.signedURL || data.signedUrl;
    if (!signed) throw new Error('Storage sign: no URL returned');
    let full = /^https?:/.test(signed) ? signed : `${api}${signed.startsWith('/') ? '' : '/'}${signed}`;
    if (downloadName) full += `${full.includes('?') ? '&' : '?'}download=${encodeURIComponent(downloadName)}`;
    const exp = Date.now() + expiresSec * 1000;
    linkCache.set(cacheKey, { url: full, exp });
    if (linkCache.size > 2000) for (const [ck, v] of linkCache) if (v.exp < Date.now() || linkCache.size > 1500) linkCache.delete(ck);
    countEgress(size);
    return { url: full, expiresAt: exp - 60_000 };
  }

  // A tiny database-backed request, so a quiet week doesn't get the free project paused.
  async function ping() {
    const res = await call('POST', `/object/list/${encodeURIComponent(bucket)}`, {
      body: JSON.stringify({ prefix: 'backups', limit: 1, offset: 0 }), headers: { 'Content-Type': 'application/json' }, timeout: 20_000,
    });
    if (!res.ok) throw new Error(`Storage ping ${res.status}`);
    return true;
  }

  return {
    enabled,
    origin: enabled ? new URL(url).origin : '',
    limits,
    ensureBucket, put, get, del, signedUrl, ping,
    canEgress, loadUsage, persistUsage,
    attachDb(d) { db = d; loadUsage(); },
    usage: () => { roll(); return { ...usage }; },
    CapError,
    describe: () => (enabled
      ? `Supabase bucket "${bucket}" (caps: ${Math.round(limits.storageBytes / MB).toLocaleString()} MB stored, ~${Math.round(limits.egressBytes / MB).toLocaleString()} MB downloads / month)`
      : 'Supabase Storage not configured'),
  };
}
