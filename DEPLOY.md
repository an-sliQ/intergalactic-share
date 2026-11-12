# Publishing on your domain

The live chat needs a server that **stays running** and keeps WebSocket connections open, plus somewhere that **keeps the chat history**. Static hosts (Netlify, GitHub Pages) and serverless hosts (Vercel functions) can't do that, so use one of the options below.

> **Want it completely free?** Follow **[GO-LIVE.md](GO-LIVE.md)**: Render Free + Supabase Free (backups, files, Google sign-in), step by step, no card anywhere.

| Option | Best for | Cost (approx.) | Effort |
|---|---|---|---|
| **A. Render** (recommended) | No server admin. Auto-deploys from GitHub, HTTPS included | **Free** (sleeps when idle; history kept in Supabase, see GO-LIVE.md). Starter $7/mo never sleeps | 15 min |
| **B. VPS** (Hetzner, DigitalOcean, Hostinger…) | Cheapest at scale, full control | ~$4–6/mo | 30–45 min |
| C. Railway / Fly.io / Coolify | Use the included `Dockerfile` and mount a volume at `/data` | ~$5/mo | 15 min |

> **Main site elsewhere?** If `yourdomain.com` already hosts your website, publish this on a subdomain such as **`talk.yourdomain.com`** or **`contact.yourdomain.com`**, and link your site's “Contact” button to it. You only add one DNS record and nothing on your current site changes.

---

## A. Render (recommended)

Follow **[GO-LIVE.md](GO-LIVE.md)**. It walks through Render Free, Supabase Free (backups, files, Google sign-in), the keep-awake job and your custom domain, step by step, with no card anywhere.

---

## B. Your own VPS (Ubuntu 22.04/24.04)

Point DNS first: an **A record** for `@` (and `www`) set to your server's IP address.

```bash
# On the server, as root
apt update && apt install -y curl git debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
# Caddy (automatic HTTPS + WebSocket proxy)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# App
git clone https://github.com/an-sliQ/intergalactic-share.git /opt/cairnly
useradd --system --no-create-home --home-dir /opt/cairnly cairnly
cd /opt/cairnly && npm ci --omit=dev
cp .env.example .env && nano .env        # set INBOX_PASSWORD (12+ chars), SESSION_SECRET (openssl rand -hex 32), PUBLIC_URL, CONTACT_EMAIL
chmod 600 .env
mkdir -p .data && chown -R cairnly:cairnly /opt/cairnly

# Run it forever
cp deploy/cairnly.service /etc/systemd/system/cairnly.service
systemctl daemon-reload && systemctl enable --now cairnly
systemctl status cairnly --no-pager

# HTTPS on your domain
cp deploy/Caddyfile /etc/caddy/Caddyfile && nano /etc/caddy/Caddyfile   # replace yourdomain.com
systemctl reload caddy
```

Open `https://yourdomain.com`; Caddy fetches the certificate on the first request.

**Updating later:** `cd /opt/cairnly && git pull && npm ci --omit=dev && chown -R cairnly:cairnly /opt/cairnly && systemctl restart cairnly`
(If the repo is private, use a GitHub deploy key or a personal access token for the clone.)
**Backups:** set `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (see [GO-LIVE.md](GO-LIVE.md), steps 2–3) for automatic off-site backups, or copy `/opt/cairnly/.data/chat.db` with a nightly cron job.

---

## After going live (checklist)

- [ ] Read [SECURITY.md](SECURITY.md) → “Your part” (production mode, strong password, real-IP header for your host).

- [ ] Set `CONTACT_EMAIL` to your real address, and replace the placeholder client quotes in `public/index.html`. The chat's team name is `TEAM_NAME` in `public/js/chat.js`.
- [ ] Free add-ons in [GO-LIVE.md](GO-LIVE.md): Google sign-in for the team, file sharing, automatic backups.
- [ ] Open `/inbox` on your phone and laptop, sign in, and click **Turn on alerts**. Visitors see you as online whenever an inbox tab is open.
- [ ] Optional: set `NOTIFY_WEBHOOK_URL` so new chats ping your Slack or Discord when nobody has the inbox open.
- [ ] Send yourself a test message from another device.
