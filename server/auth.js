// Google sign-in for the team inbox, through Firebase Authentication (free Spark plan).
//
// The browser signs in with Google via Firebase and gets an ID token (a JWT signed by Google).
// Here we verify that token with Google's public keys, then check the email is on the team list.
// No Firebase Admin SDK or service account is needed: verification only uses public keys.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export function makeFirebaseAuth(env) {
  const config = {
    apiKey: (env.FIREBASE_API_KEY || '').trim(),
    authDomain: (env.FIREBASE_AUTH_DOMAIN || '').trim(),
    projectId: (env.FIREBASE_PROJECT_ID || '').trim(),
    appId: (env.FIREBASE_APP_ID || '').trim(),
  };
  const enabled = Boolean(config.apiKey && config.authDomain && config.projectId);
  const team = parseTeam(env.TEAM_EMAILS || '');

  let jwks = null;
  async function verifyIdToken(idToken) {
    if (!enabled) throw new Error('Google sign-in is not configured');
    if (typeof idToken !== 'string' || idToken.length > 4096) throw new Error('bad token');
    jwks ||= createRemoteJWKSet(new URL(env.FIREBASE_JWKS_URL || GOOGLE_JWKS), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3600_000 });
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: `https://securetoken.google.com/${config.projectId}`,
      audience: config.projectId,
      algorithms: ['RS256'],
      maxTokenAge: '1h',
      clockTolerance: 60,
    });
    if (!payload.sub || typeof payload.sub !== 'string') throw new Error('token has no subject');
    return {
      uid: payload.sub,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : '',
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : '',
    };
  }

  return {
    enabled,
    publicConfig: enabled ? { ...config } : null, // safe to show to browsers (Firebase web config is public)
    teamConfigured: team.size > 0,
    isTeam: (email) => isTeamEmail(team, email),
    verifyIdToken,
    // Extra CSP sources the inbox page needs for the Google popup.
    csp: enabled ? {
      script: ['https://apis.google.com'],
      frame: [`https://${config.authDomain}`, 'https://accounts.google.com'],
      connect: ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://www.googleapis.com'],
    } : null,
  };
}

// TEAM_EMAILS="aman@gmail.com, sara@plumb.studio, @plumb.studio"  (an entry starting with @ allows a whole domain)
function parseTeam(s) {
  return new Set(String(s).split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => x && (x.startsWith('@') ? x.length > 3 : x.includes('@'))));
}
function isTeamEmail(team, email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.toLowerCase();
  if (team.has(e)) return true;
  const at = e.lastIndexOf('@');
  return at > 0 && team.has(e.slice(at));
}
