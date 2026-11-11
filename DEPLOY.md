# Publishing on your domain

The live chat needs a server that **stays running** and keeps WebSocket connections open, plus a disk that **keeps the chat history**. Static hosts (Netlify, GitHub Pages) and serverless hosts (Vercel functions) can't do that, so use one of the options below.

| Option | Best for | Cost (approx.) | Effort |
|---|---|---|---|
| **A. Render** (recommended) | No server admin. Auto-deploys from GitHub, HTTPS included | ~$7/mo + $0.25/GB disk | 15 min |
| **B. VPS** (Hetzner, DigitalOcean, Hostinger…) | Cheapest at scale, full control | ~$4–6/mo | 30–45 min |
| C. Railway / Fly.io / Coolify | Use the included `Dockerfile` and mount a volume at `/data` | ~$5/mo | 15 min |

> **Main site elsewhere?** If `yourdomain.com` already hosts your website, publish this on a subdomain such as **`talk.yourdomain.com`** or **`contact.yourdomain.com`**, and link your site's “Contact” button to it. You only add one DNS record and nothing on your current site changes.

---

## A. Render (recommended)

### 1. Deploy
1. Sign in at **render.com** with GitHub.
2. **New → Blueprint** → choose the `an-sliQ/intergalactic-share` repo and the branch with this code (or merge it into `main` first).
3. Render reads `render.yaml` and asks for:
   - `INBOX_PASSWORD`: the team password for `/inbox`, at least 12 characters (the app won't start with a weak one).
   - `PUBLIC_URL`: `https://yourdomain.com` (or your subdomain).
   - `NOTIFY_WEBHOOK_URL`: optional Slack or Discord webhook. Leave it empty if you don't need one.
4. Click **Apply**. In 2–3 minutes the site is live at `https://plumb-contact.onrender.com`. Open it and `/inbox` to check.

`render.yaml` already sets the Singapore region (closest to India), the Starter plan, a 1 GB disk for chat history, a generated `SESSION_SECRET`, production security mode, real-visitor-IP detection, and health checks.

### 2. Connect your domain
1. In Render: your service → **Settings → Custom Domains → Add**. Enter `yourdomain.com` (Render adds `www` automatically) or your subdomain.
2. At your domain registrar (GoDaddy, Namecheap, Hostinger, Cloudflare…), open **DNS settings**:

| You're using | Type | Name / Host | Value |
|---|---|---|---|
| Root domain `yourdomain.com` | **A** | `@` | `216.24.57.1` |
| `www.yourdomain.com` | **CNAME** | `www` | `plumb-contact.onrender.com` |
| A subdomain, e.g. `talk.yourdomain.com` | **CNAME** | `talk` | `plumb-contact.onrender.com` |

3. **Delete** any other `A` or `AAAA` records for the same name. Render uses IPv4 only, and leftover records block the HTTPS certificate.
4. **On Cloudflare:** set the record to **DNS only** (grey cloud) until Render shows the domain as verified. Keep it that way: Render already runs behind Cloudflare.
5. Back in Render, click **Verify**. HTTPS is issued automatically, usually within minutes; DNS changes can occasionally take a few hours.

After that, every push to the branch redeploys automatically.

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
git clone -b arena/07be7b4b-intergalactic-share https://github.com/an-sliQ/intergalactic-share.git /opt/plumb
useradd --system --no-create-home --home-dir /opt/plumb plumb
cd /opt/plumb && npm ci --omit=dev
cp .env.example .env && nano .env        # set INBOX_PASSWORD (12+ chars), SESSION_SECRET (openssl rand -hex 32), PUBLIC_URL
chmod 600 .env
mkdir -p .data && chown -R plumb:plumb /opt/plumb

# Run it forever
cp deploy/plumb.service /etc/systemd/system/plumb.service
systemctl daemon-reload && systemctl enable --now plumb
systemctl status plumb --no-pager

# HTTPS on your domain
cp deploy/Caddyfile /etc/caddy/Caddyfile && nano /etc/caddy/Caddyfile   # replace yourdomain.com
systemctl reload caddy
```

Open `https://yourdomain.com`; Caddy fetches the certificate on the first request.

**Updating later:** `cd /opt/plumb && git pull && npm ci --omit=dev && chown -R plumb:plumb /opt/plumb && systemctl restart plumb`
(If the repo is private, use a GitHub deploy key or a personal access token for the clone.)
**Backups:** copy `/opt/plumb/.data/chat.db` (e.g. a nightly cron job).

---

## After going live (checklist)

- [ ] Read [SECURITY.md](SECURITY.md) → “Your part” (production mode, strong password, real-IP header for your host).

- [ ] Replace **Plumb**, `hello@plumb.studio` and the placeholder client quotes in `public/index.html`. The chat's team name is `TEAM_NAME` in `public/js/chat.js`.
- [ ] Open `/inbox` on your phone and laptop, sign in, and click **Turn on alerts**. Visitors see you as online whenever an inbox tab is open.
- [ ] Optional: set `NOTIFY_WEBHOOK_URL` so new chats ping your Slack or Discord when nobody has the inbox open.
- [ ] Send yourself a test message from another device.
