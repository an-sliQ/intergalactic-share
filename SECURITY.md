# Security

What protects the site, the chat and the team inbox. Each item was tested against a running server (malformed payloads, forged tokens, forged headers, floods, path traversal).

## Protections

| Threat | Protection |
|---|---|
| **Crashing the server** with a crafted chat event (e.g. `null` payloads, fake callbacks) | Every socket handler runs inside a wrapper that type-checks input and contains errors. Unhandled promise rejections are logged instead of killing the process. |
| **Cross-site scripting (XSS)** | User text is only ever inserted with `textContent`, never as HTML. Links are only made for `http(s)://` and email addresses. A strict **Content-Security-Policy** allows scripts from this site only; the one inline script is pinned by its SHA-256 hash, computed at startup. |
| **Password guessing on `/inbox`** | 5 tries per IP, then 1 per minute, plus a site-wide cap. Failed attempts are delayed and logged with the IP. Production refuses to start without a 12+ character password. |
| **Rate limits bypassed with forged `X-Forwarded-For`** | The leftmost forwarded IP is never trusted. The real IP comes from a header the host controls (`CLIENT_IP_HEADER`) or a fixed number of proxy hops (`TRUST_PROXY`). IPv6 visitors are grouped by /64 so rotating addresses doesn't help. |
| **Forged or stolen inbox sessions** | HMAC-SHA256 signed tokens with expiry, compared in constant time. Tokens are bound to the current password: change `INBOX_PASSWORD` and every session is revoked. Expired sessions are disconnected live. |
| **Reading someone else's conversation** | Conversations are opened only with a 192-bit secret token. Only its SHA-256 is stored, so even a leaked database can't be used to hijack chats. Agent-only events are ignored on visitor connections. |
| **Spam and floods** | Limits on messages per IP, new conversations per IP and site-wide, events per connection (flooders are disconnected), connections per IP, messages per conversation, 4,000-character messages, 32 KB socket frames, 4 KB login bodies. |
| **Cross-site WebSocket hijacking** | In production, chat connections and sign-ins from other websites' origins are refused. |
| **Clickjacking** | In production, `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| **SQL injection** | Every query is a prepared statement with bound parameters. |
| **Text spoofing in the inbox** | Invisible bidi-override and control characters are stripped (e.g. `invoice‮fdp.exe` tricks). |
| **Email header / mailto injection** | Strict email validation (no `?`, `&`, quotes). |
| **@everyone / <!channel> pings via webhook** | Visitor text is escaped for Slack, and Discord mentions are disabled. Only `https://` webhooks are used, and redirects are not followed. |
| **Information leaks** | No stack traces in responses, no `X-Powered-By`, dotfiles and paths outside `public/` are not served, and `/inbox` is `noindex` and `no-store`. |
| **Slow-loris and oversized requests** | Header and request timeouts, a header count cap, and a body size cap (also in the Caddy config). |
| **Other headers** | `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, and HSTS over HTTPS in production. |
| **Fake Google sign-ins** | The browser gets a one-time code via PKCE, so a stolen redirect link is useless without the code verifier kept in that tab. The server asks Supabase to check every token (signature, expiry, revocation), then requires a verified email, a **Google** identity (email-and-password sign-ups are refused even for team addresses) and an email on `TEAM_EMAILS`. The list is re-checked on every connection, so removing someone signs them out immediately. The browser only ever sees the public publishable key, and the secret key never leaves the server. No third-party scripts are loaded. |
| **Malicious uploads** (HTML/SVG with scripts, programs renamed `.pdf`, zip bombs) | The file type comes from the file's own bytes, not its name or the browser's claim. Only an allow-list is accepted (images, PDF, Office, text, MP4/MOV), and SVG, HTML, archives and executables are refused. File names are cleaned (no paths, control characters or bidi tricks). Non-images are served as downloads. Files are served from Supabase's domain, never from this site's origin, so they can't run scripts here. The bucket also has its own type and size allow-list. |
| **Reading other people's files** | The bucket is private (the app re-checks this on every start). Objects have random names. A 30-minute signed link is issued only to the conversation's own visitor or the team. |
| **Upload abuse / surprise bills** | Who you are is checked *before* the body is read. Limits: 10 MB per file, per-IP and per-conversation limits, a site-wide daily limit, and storage and monthly download stops below Supabase Free (which can't bill anyway: no card). The download counter is saved in the backups, so restarts don't reset it. |
| **Backups overwriting good data** | If Supabase can't be reached at start-up, backups are disabled for that run, so an empty database never replaces your real history. Daily copies are kept for 14 days. The secret key lives only in the server's environment. |
| **Server compromise blast radius (VPS)** | The systemd unit runs as an unprivileged user with a read-only filesystem except `.data`, with no privilege escalation and private /tmp. The Docker image runs as non-root. |

## Your part

1. **Set `NODE_ENV=production`** when live (the Render blueprint and Dockerfile already do).
2. Prefer **Google sign-in** ([SETUP.md](SETUP.md), step 2) and keep `TEAM_EMAILS` current. If you use the password instead, make it **long and unique**, share it only with the team, and rotate it when someone leaves (that signs everyone out).
3. Set a fixed **`SESSION_SECRET`** (`openssl rand -hex 32`; Render generates one).
4. Make sure the **real visitor IP** is detected for your host: Render uses `CLIENT_IP_HEADER=true-client-ip` (already set), behind Cloudflare's orange cloud use `cf-connecting-ip`, and a VPS behind Caddy uses `TRUST_PROXY=1` (already set).
5. Keep dependencies patched: run `npm audit` and `npm update` now and then (currently 0 known vulnerabilities).
6. **Back up** the chats: Supabase does it automatically ([SETUP.md](SETUP.md), step 1). The database contains visitor names, emails and messages, so keep the bucket private and `SUPABASE_SECRET_KEY` secret.
7. On a VPS, for bigger traffic: put Cloudflare in front (orange cloud) for DDoS protection and set `CLIENT_IP_HEADER=cf-connecting-ip`, and firewall ports 80/443 to Cloudflare's IP ranges so nobody can bypass it. Render already sits behind Cloudflare.

## Known limits

- Without Google sign-in, the inbox uses one shared team password. With it, each person signs in with their own Google account.
- Inbox sessions live in the browser's `localStorage`. The CSP makes script injection very hard, but sign out on shared computers.
- Rate limits are in memory per server, which is right for this single-server setup.
