# Go live: the complete guide

This takes your Cairnly contact page from GitHub to a live site. It covers live chat, the team inbox, Google sign-in, file sharing and automatic backups. Do the steps in order. Each one ends with a check, so you know it worked before you move on.

**Time:** about 45 minutes, plus waiting for your domain's DNS if you use one.
**Cost:** ₹0. Every service below is a free plan that **never asks for a card**. If any screen asks for a card, billing or a free trial, **skip it**: you're on the wrong button. A service with no card on file can't bill you. At worst it pauses until the next month.

---

## How it fits together

```
 Visitor's browser ──► Render (free)  ── runs the site, live chat and team inbox (one Node.js server)
                         │
                         ├──► Supabase Storage (free) ── chat backups + files people send
                         └──► Supabase Auth (free) ── "Continue with Google" for your team
                                   ▲
 GitHub (free) ── stores the code; Render redeploys when it changes;
                  a daily job keeps Supabase from pausing
```

| Service | What it does for you | Free limits that matter |
|---|---|---|
| **Render** | Runs the site and the realtime chat | Sleeps after 15 min with no visitors, and the next visitor waits ~1 min. 750 hours/month (enough for 24/7). 5 GB traffic/month ≈ 15,000 first visits. Its disk is wiped on every sleep, so chats are restored from Supabase. |
| **Supabase** | Keeps chat history safe, stores files, handles Google sign-in | 1 GB files, 5 GB downloads/month, 50,000 sign-ins/month. Pauses after 7 quiet days (step 6 prevents that). |
| **Google Cloud** | Shows the "Continue with Google" screen | Free. No billing needed. |
| **GitHub** | Holds the code, triggers deploys, runs the keep-awake job | Free for public repos. |

### Keep a private note
You'll collect a few values on the way. Put them in a password manager or a private note, **not** in GitHub or a chat:

```
Supabase Project URL:      https://xxxxxxxx.supabase.co
Supabase publishable key:  sb_publishable_...
Supabase secret key:       sb_secret_...        <- a password, never share
Supabase database password:                     <- not used by the app, but keep it
Render site address:       https://cairnly-contact.onrender.com
Inbox password:                                 <- 12+ characters
Google Client ID / Secret:                      <- secret is a password
```

---

## Step 1: Put the finished code on `main` (2 min)

Render deploys from one branch. Use `main`, so whatever is on `main` is what's live.

1. Open **github.com/an-sliQ/intergalactic-share** → **Pull requests**.
2. Open the pull request from `arena/07be7b4b-intergalactic-share` → **Merge pull request** → **Confirm merge**.
   Don't delete the branch afterwards if GitHub offers to.

✅ **Check:** on the repo's front page (branch `main`) you see `GO-LIVE.md`, `server/` and `public/`.

> Later, when changes are made on another branch, they only go live after you merge them into `main` the same way. That makes `main` your "publish" button.

---

## Step 2: Supabase project (10 min)

### 2a. Create it
1. Go to **supabase.com** → **Start your project** → **Continue with GitHub**.
2. If asked to create an organization: any name (e.g. `Cairnly`), type **Personal**, plan **Free**.
3. **New project**:
   - **Name:** `cairnly`
   - **Database password:** click **Generate a password** and save it in your note.
   - **Region:** **South Asia (Mumbai)**
   - Leave everything else as it is → **Create new project**. Wait about a minute until the dashboard loads.

### 2b. Copy three values
In the project, click **Project Settings** (gear icon, bottom left):
1. **Data API** → copy **Project URL** (`https://xxxxxxxx.supabase.co`). You can also click **Connect** at the top of the dashboard.
2. **API Keys** →
   - **Publishable key** → copy (`sb_publishable_…`). It's safe to be public.
   - **Secret keys** → click the eye/reveal on the `default` key → copy (`sb_secret_…`). **This is a password.** It goes only into Render.

> Don't see `sb_publishable_` / `sb_secret_` keys, only "anon" and "service_role"? Click the **API Keys** tab (not "Legacy API keys") and choose **Create new API keys**.

You don't need to create tables or buckets. The app creates a **private** storage bucket called `chat` by itself on first start.

✅ **Check:** you have the URL and both keys in your note.

---

## Step 3: Put the site on Render (10 min)

### 3a. Create the web service
1. Go to **render.com** → **Get Started** → **GitHub**. Sign in. **Don't add a card** if asked about billing; just skip.
2. Top right **+ New** → **Web Service**.
3. **Git Provider → GitHub**. If Render asks to install its GitHub app: choose **Only select repositories** → `intergalactic-share` → **Install**. Then click the repo.
4. Fill in the form:

| Field | Value |
|---|---|
| **Name** | `cairnly-contact` (this becomes `cairnly-contact.onrender.com`) |
| **Language** | `Node` |
| **Branch** | `main` |
| **Region** | **Singapore** (closest to India) |
| **Root Directory** | leave empty |
| **Build Command** | `npm ci --omit=dev` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** ($0 / month) |

### 3b. Environment variables
Still on the same page, under **Environment Variables**, add these. Use **Add from .env** to paste them all at once, then fill in your values:

```
NODE_VERSION=22
NODE_ENV=production
CLIENT_IP_HEADER=true-client-ip
PUBLIC_URL=https://cairnly-contact.onrender.com
INBOX_PASSWORD=
SESSION_SECRET=
CONTACT_EMAIL=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

| Key | What to put | Notes |
|---|---|---|
| `NODE_VERSION` | `22` | Node.js version for the server. |
| `NODE_ENV` | `production` | Turns on strict security mode. |
| `CLIENT_IP_HEADER` | `true-client-ip` | Lets spam limits see each visitor's real IP on Render. |
| `PUBLIC_URL` | `https://cairnly-contact.onrender.com` | Your site address, used for links in alerts. Fix it in 3d if Render gives a different address. |
| `INBOX_PASSWORD` | 12+ characters, e.g. a passphrase | Team login for `/inbox` until Google sign-in is on (step 5). The site refuses to start if it's shorter. |
| `SESSION_SECRET` | click **Generate** next to the value box, or paste 40+ random letters and numbers from your password manager | Keeps your team signed in across restarts. Never share. |
| `CONTACT_EMAIL` | the email you want shown on the site | Shown in every "Email us" link. Change it any time (see "Everyday changes"). |
| `SUPABASE_URL` | Project URL from 2b | |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` | Secret. Render keeps it hidden. |

Leave `TEAM_EMAILS` out for now. You add it in step 5.

### 3c. Health check and deploy
1. Open **Advanced** → **Health Check Path**: `/healthz`. Leave **Auto-Deploy** on **On Commit**.
2. Click **Deploy Web Service**. The first build takes 2–4 minutes.

✅ **Check:** the **Logs** tab ends with lines like:
```
✚  Created private storage bucket "chat".
Contact page  → ...
Contact email → you@yourmail.com
Sign-in       → team password
Files         → on, up to 10 MB, Supabase bucket "chat" ...
Backups       → to Supabase every 180s when something changed, 14 daily copies kept
==> Your service is live 🎉
```

### 3d. Confirm your address
At the top of the service page, Render shows the site address. If it isn't exactly `https://cairnly-contact.onrender.com` (Render adds letters when a name is taken), go to **Environment** → edit `PUBLIC_URL` to the real address → **Save, rebuild, and deploy**. Use that address everywhere this guide says `cairnly-contact.onrender.com`.

---

## Step 4: Test it (5 min)

1. Open your site on your **phone**. Click **Start a chat**, enter a name and email, and send "test".
2. On your **laptop**, open `https://cairnly-contact.onrender.com/inbox` → sign in with `INBOX_PASSWORD` → the test chat is there. Reply, and the reply appears on your phone instantly.
3. On the phone, attach a photo in the chat. It shows up in the inbox.
4. **History survives restarts:** wait 3 minutes (a backup is taken) → in Render click **Manual Deploy → Restart service** → wait for it to come back → reload the inbox. The chat and the photo are still there.
5. In the inbox, click **Turn on alerts** so you get notified about new chats while the inbox is open in a tab.

✅ All five work → the core is live. Supabase → **Storage** now shows a `chat` bucket with a `backups/` folder.

> **"Online" vs "away":** visitors see your team as online whenever someone has the inbox open. Otherwise the page says you reply by email, and the chat still collects the message.

---

## Step 5: Google sign-in for your team (15 min)

This replaces the shared password. Each person signs in with their own Google account, and only the emails you list get in.

### 5a. Copy Supabase's callback address
Supabase → **Authentication** → **Sign In / Providers** → **Google**. Copy the **Callback URL (for OAuth)**. It looks like `https://xxxxxxxx.supabase.co/auth/v1/callback`. Keep this tab open.

### 5b. Register the app with Google
1. Open **console.cloud.google.com**. If it offers a free trial or asks for billing, **close it**: not needed.
2. Project picker (top left) → **New project** → name `cairnly-inbox` → **Create** → make sure it's selected at the top.
3. Search bar → **Google Auth Platform** → **Get started**:
   - **App name:** `Cairnly inbox` · **User support email:** yours → **Next**
   - **Audience:** **External** → **Next**
   - **Contact information:** your email → **Next** → agree → **Continue** → **Create**
4. **Clients** → **Create client**:
   - **Application type:** Web application · **Name:** `Supabase`
   - **Authorized redirect URIs** → **Add URI** → paste the Callback URL from 5a
   - **Create** → copy the **Client ID** and **Client secret** into your note right away.
5. **Audience** → **Publish app** → **Confirm**. Status becomes *In production*. The app only asks for name and email, so no Google review is needed.

### 5c. Turn Google on in Supabase
1. Back on Supabase's **Google** provider screen: switch **Enable Sign in with Google** on → paste **Client ID** and **Client Secret** → **Save**.
2. In the same provider list, open **Email** → switch it **off** → **Save**. Only Google can create accounts now.
3. **Authentication → URL Configuration**:
   - **Site URL:** `https://cairnly-contact.onrender.com/inbox` → **Save**
   - **Redirect URLs → Add URL:** `https://cairnly-contact.onrender.com/inbox` → **Save**

### 5d. Choose who gets in
Render → your service → **Environment** → **Add** → `TEAM_EMAILS`, e.g.
```
you@gmail.com, partner@gmail.com
```
For company Google accounts, `@yourcompany.com` lets in everyone at that domain. → **Save, rebuild, and deploy**.

✅ **Check:** open `/inbox`. It now shows **Continue with Google** instead of the password box. Sign in, and you see "Online as *your name*". Sign out and try a Google account that's not on the list: it's refused with "… is not on the team list".

> Google's screen says "to continue to xxxxxxxx.supabase.co". That's normal on the free plan: Supabase handles the sign-in for you.
> Want the password as a backup way in too? Add `ALLOW_PASSWORD_LOGIN=true`.

---

## Step 6: Keep Supabase awake (2 min)

Supabase pauses a free project after 7 days with no activity. Chats count as activity, and this daily job covers quiet weeks.

1. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**
   - **Name:** `SITE_URL` · **Value:** `https://cairnly-contact.onrender.com` → **Add variable**
2. **Actions** tab → if GitHub asks, click **I understand my workflows, go ahead and enable them**.
3. **Keep free services awake** → **Run workflow** → **Run workflow**.

✅ **Check:** after about a minute the run shows a green tick, and its log ends with `{"ok":true,"supabase":"pinged"}`.

> GitHub switches scheduled jobs off after 60 days with no commits. It emails you first, and one click on **Enable workflow** turns it back on.

---

## Step 7: Your own domain (optional, 10 min + DNS wait)

The `onrender.com` address works fine. Use this step if you own a domain. Render and SSL are free; only the domain itself costs money, paid to your registrar.

Use either the bare domain (`cairnly.com`) or a subdomain (`chat.cairnly.com`) if your main website lives elsewhere.

1. Render → service → **Settings** → **Custom Domains** → **+ Add Custom Domain** → type the domain → **Save**.
2. At your registrar (GoDaddy, Namecheap, Hostinger, Cloudflare…) → **DNS**:

| You're adding | Type | Name / Host | Value |
|---|---|---|---|
| Bare domain `cairnly.com` | **A** | `@` | `216.24.57.1` |
| `www.cairnly.com` | **CNAME** | `www` | `cairnly-contact.onrender.com` |
| A subdomain, e.g. `chat.cairnly.com` | **CNAME** | `chat` | `cairnly-contact.onrender.com` |

   - Delete any other **A** or **AAAA** records with the same name (often a registrar "parking" page).
   - On Cloudflare, set the record to **DNS only** (grey cloud).
3. Render → **Verify**. The certificate appears in minutes; DNS can take up to a few hours.
4. Now point everything at the new address. `yourdomain` below means your real domain:
   - Render → **Environment** → `PUBLIC_URL` = `https://yourdomain.com` → save.
   - Supabase → **Authentication → URL Configuration** → **Site URL** = `https://yourdomain.com/inbox`, and **add** `https://yourdomain.com/inbox` to **Redirect URLs**. Keep the onrender one too.
   - GitHub → the `SITE_URL` variable = `https://yourdomain.com`.
   - Google needs no change: it only talks to Supabase.

✅ **Check:** `https://yourdomain.com` shows the padlock, and Google sign-in at `https://yourdomain.com/inbox` works.

---

## Step 8: Final touches

- **Your email address:** you need a real inbox for `CONTACT_EMAIL`. A Gmail address works. For an address at your domain without paying, use your registrar's free email forwarding, or Zoho Mail's free plan.
- **Slack/Discord ping for new chats** (optional): create an incoming webhook in Slack or Discord and add it in Render as `NOTIFY_WEBHOOK_URL`.
- **Wording, prices, client quotes:** edit `public/index.html` (see "Editing the page text" below). Replace the placeholder client quotes before you share the site.
- **Your phone:** open `/inbox` on your phone's browser and use **Add to Home Screen**, so it opens like an app.

---

## Everyday changes

### Change the contact email (1 minute, no code)
1. **render.com** → your `cairnly-contact` service → **Environment**.
2. Click the pencil next to `CONTACT_EMAIL` → type the new address → **Save, rebuild, and deploy** (or **Save and deploy**).
3. About 2 minutes later, every "Email us" button, the footer, the FAQ and Google's business info show the new address.

If the address is mistyped (not a valid email), the site keeps working and shows the placeholder instead. The **Logs** tab says `CONTACT_EMAIL … doesn't look like an email address`.

### Add or remove a team member
Render → **Environment** → edit `TEAM_EMAILS` → save. Someone you remove is signed out on their next action.

### Change the inbox password
Render → **Environment** → edit `INBOX_PASSWORD` → save. Everyone using the password is signed out.

### Editing the page text
On GitHub, go to branch `main` → `public/index.html` → pencil icon → change the text (leave the `<…>` tags alone) → **Commit changes**. Render redeploys automatically in about 2 minutes.

### Seeing your usage
- Render: **Billing → Monthly Included Usage** (hours, bandwidth).
- Supabase: **Organization → Usage** (storage, downloads).
- The app stops file sharing on its own before Supabase's limits (800 MB stored, ~3.5 GB downloads/month), and asks people to email files instead. Chat keeps working.

---

## If something goes wrong

| What you see | Why | Fix |
|---|---|---|
| The site takes ~1 minute to open | It was asleep (free plan) | Normal. The keep-awake job also wakes it once a day. |
| Render deploy fails with `Refusing to start: set INBOX_PASSWORD…` | Password missing or under 12 characters | Set a longer `INBOX_PASSWORD`, or finish step 5. |
| Logs say `Files → off` / `Backups → off` | Supabase values missing or mistyped | Re-copy `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (no spaces). |
| Logs say `Backups → OFF this run (Supabase was unreachable at start)` | Supabase project paused or down | Supabase dashboard → **Restore project** (free), then Render → **Restart service**. |
| Chats disappeared after a sleep | Backups weren't on yet | Finish step 2/3b. Backups run every 3 minutes and when the server sleeps. |
| Google: `Error 400: redirect_uri_mismatch` | Callback URL in Google doesn't match Supabase's | Step 5b.4: paste the exact Callback URL from 5a. |
| After Google you land on the wrong page or see "requested path is invalid" | Inbox address not allowed in Supabase | Step 5c.3: add `https://<your site>/inbox` to Redirect URLs. |
| "… is not on the team list" | That email isn't in `TEAM_EMAILS` | Add it (step 5d). |
| Inbox still shows the password box | `TEAM_EMAILS` or the publishable key isn't set | Check both in Render → Environment. |
| Email shown on the site didn't change | Deploy still running, or the address is invalid | Wait for "Your service is live", check the Logs line `Contact email →`. |
| Render says the service is suspended | Free monthly limit reached (rare) | Resumes on the 1st of next month. Nothing is billed. |

---

## All settings (Render → Environment)

| Key | Required | Default | Meaning |
|---|---|---|---|
| `NODE_VERSION` | yes | — | `22` |
| `NODE_ENV` | yes | — | `production` |
| `CLIENT_IP_HEADER` | yes on Render | — | `true-client-ip` |
| `SESSION_SECRET` | yes | random per start | Keeps sessions valid across restarts |
| `PUBLIC_URL` | yes | — | Your site address |
| `CONTACT_EMAIL` | recommended | `hello@cairnly.studio` | Email shown on the page |
| `INBOX_PASSWORD` | until Google is on | — | Team password, 12+ characters |
| `SUPABASE_URL` | for files, backups, Google | — | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | for Google | — | `sb_publishable_…` |
| `SUPABASE_SECRET_KEY` | for files + backups | — | `sb_secret_…` (secret) |
| `TEAM_EMAILS` | for Google | — | Who may sign in: emails and/or `@domain.com` |
| `ALLOW_PASSWORD_LOGIN` | no | auto | `true` keeps the password next to Google |
| `NOTIFY_WEBHOOK_URL` | no | — | Slack/Discord webhook for new chats |
| `FILE_UPLOADS` | no | on | `off` = backups only, no file sharing |
| `FILE_MAX_MB` | no | `10` | Largest file a person can send |
| `STORAGE_CAP_MB` / `EGRESS_CAP_MB` | no | `800` / `3500` | Safety stops under Supabase's free limits |
| `BACKUP_INTERVAL_SEC` / `BACKUP_KEEP_DAYS` | no | `180` / `14` | How often backups run / days of daily copies |

## What file sharing allows
- **Types:** images (JPG, PNG, GIF, WebP, HEIC), PDF, Word, Excel, PowerPoint, TXT, CSV, MP4/MOV. The server checks the real contents, not just the name. SVG, HTML, archives and programs are refused.
- Visitors can attach files after their first message; screenshots can be pasted. Big phone photos are shrunk before upload.
- Only that conversation and your team can open a file. Links expire after 30 minutes and refresh automatically.
- Limits: 30 files per conversation per day, 300 uploads per day across the site.

## What's stored in Supabase (bucket `chat`, private)
- `backups/latest.db.gz`: newest copy of all chats (every 3 minutes when something changed, and when the server sleeps).
- `backups/daily/YYYY-MM-DD.db.gz`: one copy per day, kept 14 days.
- `files/<conversation>/<random id>`: files sent in chats. Random names, so links can't be guessed.
