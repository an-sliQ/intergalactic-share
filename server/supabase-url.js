// The Supabase project address, cleaned up. Supabase shows it in several forms
// ("https://abc.supabase.co", ".../rest/v1/", ".../auth/v1", "abc.supabase.co"), but every
// API path is built from the bare origin, so anything after the host is dropped here.
export function supabaseBaseUrl(raw) {
  let s = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return { url: '', note: '' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return { url: '', note: `SUPABASE_URL "${raw}" is not a web address. It should look like https://abcdefghijkl.supabase.co` }; }
  const url = u.origin;
  const extra = (u.pathname + u.search).replace(/^\/+$/, '');
  const note = extra ? `SUPABASE_URL had "${extra}" after the address. Using ${url} (you can remove the extra part in your settings).` : '';
  return { url, note };
}
