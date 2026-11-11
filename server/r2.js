// Cloudflare R2 (S3-compatible) client with hard usage caps that keep the account inside R2's free tier.
//
// Free tier (per month): 10 GB stored, 1,000,000 Class A ops (writes), 10,000,000 Class B ops (reads).
// Deletes are free. The defaults below stop at well under half of those numbers, so normal use and
// even abuse can't push the account into paid usage. Counters are kept per calendar month (UTC).
import { AwsClient } from 'aws4fetch';

const MB = 1024 * 1024;

export function makeR2(env, { log = console } = {}) {
  let db = null; // attached after the database is opened (it may first be restored from R2)
  const accountId = (env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = (env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = (env.R2_BUCKET || '').trim();
  const endpoint = (env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
  const enabled = Boolean(endpoint && accessKeyId && secretAccessKey && bucket);

  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const limits = {
    writesPerMonth: num(env.R2_MONTHLY_WRITE_CAP, 300_000),     // free: 1,000,000
    readsPerMonth: num(env.R2_MONTHLY_READ_CAP, 3_000_000),     // free: 10,000,000
    storageBytes: num(env.STORAGE_CAP_MB, 5_000) * MB,          // free: 10 GB
  };

  // Only 1 automatic retry: every retry is a separate (billable) request to R2.
  const aws = enabled ? new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 1, initRetryMs: 300 }) : null;
  const objectUrl = (key) => `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

  // ---- usage counters (memory, persisted into the database before each backup) ----
  const monthNow = () => new Date().toISOString().slice(0, 7);
  let usage = { month: monthNow(), writes: 0, reads: 0 };
  function loadUsage() {
    try {
      const saved = JSON.parse(db?.kvGet('r2_usage') || 'null');
      if (saved && saved.month === monthNow()) usage = { month: saved.month, writes: saved.writes | 0, reads: saved.reads | 0 };
    } catch { /* fresh counters */ }
  }
  function persistUsage() { try { db?.kvSet('r2_usage', JSON.stringify(usage)); } catch { /* ignore */ } }
  function roll() { const m = monthNow(); if (usage.month !== m) usage = { month: m, writes: 0, reads: 0 }; }
  function canWrite(n = 1) { roll(); return usage.writes + n <= limits.writesPerMonth; }
  function canRead(n = 1) { roll(); return usage.reads + n <= limits.readsPerMonth; }

  class CapError extends Error { constructor(m) { super(m); this.code = 'R2_CAP'; } }

  async function put(key, body, { contentType = 'application/octet-stream', contentDisposition } = {}) {
    if (!enabled) throw new Error('R2 is not configured');
    if (!canWrite()) throw new CapError('Monthly R2 write cap reached');
    usage.writes += 1;
    const headers = { 'Content-Type': contentType };
    if (contentDisposition) headers['Content-Disposition'] = contentDisposition;
    const res = await aws.fetch(objectUrl(key), { method: 'PUT', body, headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function get(key) {
    if (!enabled) throw new Error('R2 is not configured');
    if (!canRead()) throw new CapError('Monthly R2 read cap reached');
    usage.reads += 1;
    const res = await aws.fetch(objectUrl(key), { method: 'GET', signal: AbortSignal.timeout(60_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function del(key) { // free operation
    if (!enabled) return;
    const res = await aws.fetch(objectUrl(key), { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${res.status}`);
  }

  // Short-lived private link for one file. Counts as one read (the typical case: one view).
  async function presignGet(key, { expiresSec = 1800, filename, contentType, inline = false } = {}) {
    if (!enabled) throw new Error('R2 is not configured');
    if (!canRead()) throw new CapError('Monthly R2 read cap reached');
    usage.reads += 1;
    const url = new URL(objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(expiresSec));
    if (contentType) url.searchParams.set('response-content-type', contentType);
    if (filename) {
      const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      url.searchParams.set('response-content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    }
    const signed = await aws.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  }

  return {
    enabled,
    origin: enabled ? new URL(endpoint).origin : '',
    limits,
    put, get, del, presignGet,
    canWrite, canRead, loadUsage, persistUsage,
    attachDb(d) { db = d; loadUsage(); },
    usage: () => { roll(); return { ...usage }; },
    CapError,
    describe: () => (enabled ? `R2 bucket "${bucket}" (caps: ${limits.writesPerMonth.toLocaleString()} writes, ${limits.readsPerMonth.toLocaleString()} reads / month, ${Math.round(limits.storageBytes / MB).toLocaleString()} MB stored)` : 'R2 not configured'),
    log,
  };
}
