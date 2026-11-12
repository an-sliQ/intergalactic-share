// Team sign-in with Google, through Supabase Auth (free plan, no card).
//
// Flow: the inbox sends the browser to Supabase → Google → back to /inbox with a one-time code (PKCE).
// The browser swaps the code for a Supabase access token and gives it to this server. The server asks
// Supabase who the token belongs to (so the signature, expiry and revocation are checked by Supabase itself),
// requires a Google identity with a verified email, and checks the email against TEAM_EMAILS.
// Only the project URL and the *publishable* key are used here; both are public by design.

export function makeSupabaseAuth(env) {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const publishableKey = (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '').trim();
  const team = parseTeam(env.TEAM_EMAILS);
  const teamConfigured = team.emails.size > 0 || team.domains.length > 0;
  // Google sign-in switches on only when there is someone allowed in. So adding the Supabase keys (setup step 1)
  // never locks the team out of the password login before Google is ready (step 2).
  const ready = Boolean(url && publishableKey);
  const enabled = ready && teamConfigured;
  if (publishableKey.startsWith('sb_secret_')) throw new Error('SUPABASE_PUBLISHABLE_KEY is a SECRET key. Use the publishable key (sb_publishable_…) there.');
  const keyHeaders = () => ({ apikey: publishableKey, ...(publishableKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${publishableKey}` }) });

  async function verifyAccessToken(token) {
    if (!enabled) throw Object.assign(new Error('Supabase sign-in is not configured'), { code: 'DISABLED' });
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      throw Object.assign(new Error('malformed token'), { code: 'MALFORMED' });
    }
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { ...keyHeaders(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('token rejected by Supabase'), { code: 'REJECTED' });
    if (!res.ok) throw Object.assign(new Error(`Supabase /user ${res.status}`), { code: 'UPSTREAM' });
    const u = await res.json();
    const email = String(u.email || '').toLowerCase();
    const google = (u.identities || []).find((i) => i.provider === 'google' && String(i.identity_data?.email || i.email || '').toLowerCase() === email);
    const meta = u.user_metadata || {};
    return {
      uid: u.id,
      email,
      emailVerified: Boolean(email && u.email_confirmed_at && u.aud === 'authenticated'),
      viaGoogle: Boolean(google),
      name: String(meta.full_name || meta.name || google?.identity_data?.full_name || '').slice(0, 80),
    };
  }

  return {
    enabled,
    publicConfig: enabled ? { url, key: publishableKey } : null,
    ready,
    teamConfigured,
    isTeam: (email) => isTeam(team, email),
    verifyAccessToken,
    csp: enabled ? { connect: [new URL(url).origin] } : null,
  };
}

// TEAM_EMAILS="aman@gmail.com, sara@cairnly.studio, @cairnly.studio"  (an entry starting with @ allows a whole domain)
function parseTeam(raw = '') {
  const emails = new Set(); const domains = [];
  for (const part of String(raw).split(/[,\s;]+/)) {
    const v = part.trim().toLowerCase();
    if (!v) continue;
    if (v.startsWith('@') && v.length > 3) domains.push(v);
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) emails.add(v);
  }
  return { emails, domains };
}
function isTeam(team, email) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  const at = e.lastIndexOf('@');
  return team.emails.has(e) || (at > 0 && team.domains.includes(e.slice(at)));
}
