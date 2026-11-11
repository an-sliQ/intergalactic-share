# Plumb: contact page with realtime live chat

A conversion-focused contact page for a websites and AI automation studio. Visitors chat with the team **in real time** on the page, and the team answers from a private **inbox** at `/inbox`.

The visual system follows the editorial style of endcap.design: paper `#f2f0e7`, ink `#181a17` and acid `#dce87a`, Hanken Grotesk at 900 weight with Fraunces italic accents, square corners, and motion on `cubic-bezier(.32,.72,0,1)` and spring `cubic-bezier(.34,1.56,.64,1)`.

> **Publishing on your domain:** see [DEPLOY.md](DEPLOY.md) (Render one-click Blueprint, or a VPS with automatic HTTPS).

## Run it

```bash
npm install
INBOX_PASSWORD='choose-a-strong-one' npm start
# Contact page → http://localhost:3000/
# Team inbox   → http://localhost:3000/inbox
```

Requires Node **22.13+**. Chat history is stored with the built-in `node:sqlite`, so there are no native modules to compile.

## How the chat works

| | |
|---|---|
| Transport | Socket.IO (WebSocket, falls back to long-polling) |
| Storage | SQLite file at `.data/chat.db` |
| Visitor identity | Random conversation id plus a secret token kept in `localStorage`. Only a SHA-256 of the token is stored. A returning visitor sees their history. |
| Team presence | Visitors see “online” while at least one team member has `/inbox` open |
| Live signals | Typing indicators both ways, delivered and seen receipts, visitor on-page status |
| Conversion | Quick-start chips, an inline email capture after the first message, an offline auto-reply, and a floating launcher with unread badge and sound |
| Alerts for the team | Sound, tab badge, desktop notifications (“Turn on alerts”), and optional Slack/Discord webhook |
| Security | See [SECURITY.md](SECURITY.md). Strict CSP, crash-proof socket handlers, layered rate limits, origin checks, signed sessions that are revoked when the password changes |

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `INBOX_PASSWORD` | `plumb-demo` | Team password for `/inbox`. **Change it** (12+ characters; required in production). Changing it signs everyone out. |
| `SESSION_SECRET` | random per boot | Signs inbox sessions. Set it so sign-ins survive restarts. |
| `NOTIFY_WEBHOOK_URL` | none | Slack or Discord incoming webhook. Pings on new chats, and on messages while nobody is online. |
| `PUBLIC_URL` | none | e.g. `https://example.com`. Adds an inbox link to webhook pings. |
| `NODE_ENV` | none | Set to `production` when live. Enables strict mode: refuses a weak or missing password, blocks framing (clickjacking) and foreign-origin chat connections, and sends HSTS. |
| `CLIENT_IP_HEADER` | none | A header your host sets to the real visitor IP (`true-client-ip` on Render, `cf-connecting-ip` behind Cloudflare, `fly-client-ip` on Fly.io). Used for rate limits. |
| `TRUST_PROXY` | `1` | Number of proxies in front of the app, used when `CLIENT_IP_HEADER` is not set. Use `0` if the app faces the internet directly. |
| `ALLOWED_ORIGINS` | none | Extra comma-separated origins allowed to open chat connections (your own domain is always allowed). |
| `SESSION_DAYS` | `14` | How long an inbox sign-in lasts (1–90). |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DB_FILE` | `.data/chat.db` | |

## Before launch

- Replace the brand name **Plumb**, `hello@plumb.studio`, and the copy in `public/index.html`. The chat team name is `TEAM_NAME` in `public/js/chat.js`.
- **The three client quotes in “In their words” are placeholders.** Replace them with real client words, or remove the section.
- Host on anything that runs a long-lived Node process with WebSockets (Render, Railway, Fly.io, a VPS). Serverless-only hosts such as Vercel functions won't keep sockets open. Put `.data/` on a persistent disk.

## Files

```
server/index.js     Express + Socket.IO: pages, login, realtime events, presence, webhook
server/db.js        SQLite schema and queries
public/index.html   Contact page
public/inbox.html   Team inbox
public/css/         site.css (design system and sections), chat.css (chat panel), inbox.css
public/js/          site.js (motion), chat.js (visitor chat), inbox.js (team inbox)
public/fonts/       Hanken Grotesk and Fraunces variable fonts (OFL), self-hosted
```
