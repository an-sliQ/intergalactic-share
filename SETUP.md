# Free setup, step by step

Everything below is on free plans that **don't ask for a card**, so nothing here can ever bill you. Each add-on stays **off** until you paste its settings into Render, so you can stop after any step and the site keeps working.

| Step | What you get | Account | Card? | Can it charge you? |
|---|---|---|---|---|
| 0. Render **Free** | The site + live chat online | render.com | No | No. Render can't bill a workspace without a card. |
| 1. Supabase **Free** | Chat history survives restarts (backups) **and** clients can send files and photos | supabase.com | No | No. With no card, going over a limit means a warning and then restrictions, never a bill. |
| 2. Google sign-in (via Supabase) | Your team signs in to `/inbox` with their own Google accounts | Google Cloud (free) | No | No. Google sign-in doesn't need billing. |
| 3. Keep-awake ping | Stops Supabase pausing your project after a quiet week | GitHub (you already have it) | No | No. Actions minutes are unlimited for public repos. |

---

## Step 0: Put the site on Render's free plan (5 min)

1. Sign in at **render.com** with GitHub. **Don't add a card.**
2. **New → Blueprint** → pick `an-sliQ/intergalactic-share` and this branch. `render.yaml` already says `plan: free` (no disk).
3. Render asks for values. For now fill only these and **leave the `SUPABASE_*` and `TEAM_EMAILS` boxes empty**:
   - `PUBLIC_URL`: `https://cairnly-contact.onrender.com` for now (your domain later).
   - `INBOX_PASSWORD`: a team password of 12+ characters (temporary; Google replaces it in step 2).
4. **Apply.** After 2–3 minutes, open the site and `/inbox`.

> **Already created it on the Starter plan earlier?** Service → **Settings → Instance type → Free**, then **Disks → delete the disk**. Disks are a paid add-on.

**What "free" means here:** the server sleeps after 15 minutes with no visitors, and the next visitor waits about a minute for it to wake. Each time it sleeps, its disk is wiped, so **chat history is lost on every sleep until you finish step 1**. Step 1 backs history up to Supabase and restores it automatically.

---

## Step 1: Supabase for backups + files (10 min, no card)

### 1a. Create the project
1. Go to **supabase.com** → **Start your project** → sign in with GitHub.
2. If asked to create an organization: any name, type **Personal**, plan **Free**.
3. **New project**:
   - Name: `cairnly`
   - Database password: click **Generate**, then save it in your password manager. The app doesn't use it, but you'd need it to manage the database later.
   - Region: **South Asia (Mumbai)** (closest to your visitors)
   - Leave the other options as they are → **Create new project**. It takes about a minute.

### 1b. Copy three values
In the project, open **Project Settings** (gear icon, bottom left):
1. **Data API** (or click **Connect** at the top) → copy the **Project URL**. It looks like `https://abcdefghijkl.supabase.co`.
2. **API Keys** →
   - copy the **Publishable key** (`sb_publishable_…`). It's public by design.
   - under **Secret keys**, reveal and copy the default secret key (`sb_secret_…`). **This one is a password.** It only goes into Render; never share it or paste it in a chat.

### 1c. Paste into Render
Render → your service → **Environment**:

| Key | Value |
|---|---|
| `SUPABASE_URL` | the Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` |

**Save changes.** After the redeploy, Render's **Logs** should show:

```
✚  Created private storage bucket "chat".
Files    → on, up to 10 MB, Supabase bucket "chat" (caps: 800 MB stored, ~3,500 MB downloads / month)
Backups  → to Supabase every 180s when something changed, 14 daily copies kept
```

You don't need to create a bucket: the app makes a **private** one called `chat` the first time it starts. You can see it in Supabase → **Storage**.

**Test it:** send a message and a photo from your phone, wait 3 minutes, then in Render click **Manual Deploy → Restart service**. The chat and the photo are still there.

> Adding `SUPABASE_PUBLISHABLE_KEY` also gets Google sign-in ready (step 2). Until step 2 is finished, the inbox still shows the password box. To keep the password even after Google works, add `ALLOW_PASSWORD_LOGIN=true`.

**Free limits, and the app's own lower stops**

| Supabase Free | App stops at (default) | Typical contact-page use |
|---|---|---|
| 1 GB file storage | 800 MB (`STORAGE_CAP_MB`) | well under 200 MB |
| 5 GB downloads a month | ~3,500 MB (`EGRESS_CAP_MB`) | a few hundred MB |
| 50 MB per file | 10 MB (`FILE_MAX_MB`) | phone photos are shrunk to under ~1 MB before upload |

When a stop is reached, file sharing pauses with a polite "please email the file instead" message, and the chat keeps working. Other limits: 30 files per conversation per day and 300 uploads per day across the site.

---

## Step 2: Google sign-in for your team (15 min, no card)

Google asks every site that offers "Continue with Google" to register once. It's free and doesn't need billing. **If Google Cloud offers a free trial or asks for billing, skip it.**

### 2a. Get the address Google must send people back to
Supabase → **Authentication → Sign In / Providers** (or **Providers**) → **Google**. Copy the **Callback URL** shown there. It looks like `https://abcdefghijkl.supabase.co/auth/v1/callback`. Leave this tab open.

### 2b. Register the app with Google
1. Open **console.cloud.google.com** → project picker (top left) → **New project** → name `cairnly-inbox` → **Create**, then select it.
2. Search for **Google Auth Platform** (it's also under *APIs & Services → OAuth consent screen*) → **Get started**:
   - App name: `Cairnly inbox` · User support email: yours
   - Audience: **External**
   - Contact email: yours → agree → **Create**
3. **Clients → Create client**:
   - Application type: **Web application** · Name: `Supabase`
   - **Authorized redirect URIs → Add URI** → paste the **Callback URL** from 2a
   - **Create.** Copy the **Client ID** and **Client secret** right away. Google may only show the secret once.
4. **Audience → Publish app** (status becomes *In production*). The app only asks for name and email, so Google doesn't need to review it.
   *(Or leave it in Testing and add each team member under **Test users**.)*

### 2c. Turn on Google in Supabase
1. Back in Supabase's **Google** provider tab: **Enable**, paste the **Client ID** and **Client secret** → **Save**.
2. **Turn off email sign-ups:** in the same list open **Email** and switch the provider **off** → **Save**. Only Google should be able to create accounts. *(The app also refuses any sign-in that isn't through Google, so this is a second lock.)*
3. **Authentication → URL Configuration**:
   - **Site URL:** `https://cairnly-contact.onrender.com/inbox`
   - **Redirect URLs → Add URL:** `https://cairnly-contact.onrender.com/inbox`
     Add `https://yourdomain.com/inbox` too when your domain is connected.

### 2d. Choose who gets in
Render → **Environment** → add `TEAM_EMAILS`, for example `you@gmail.com, sara@gmail.com`. If your team uses company Google accounts, `@yourcompany.com` lets in everyone at that domain. **Save.**

Open `/inbox` → **Continue with Google**. Done. The password box disappears automatically.
- Someone leaves the team? Remove their email from `TEAM_EMAILS` and save. Their session stops working right away.
- Signing in with an email that isn't on the list shows *"… is not on the team list"* and lets nothing through.

---

## Step 3: Keep Supabase awake (2 min, optional but recommended)

Supabase pauses a free project after **7 days without activity**. A paused project keeps your data, but files and backups stop working until you click **Restore** in the Supabase dashboard (free). Every chat already counts as activity. This step covers quiet weeks:

1. GitHub → your repo → **Settings → Secrets and variables → Actions → Variables** tab → **New repository variable**
   - Name: `SITE_URL` · Value: `https://cairnly-contact.onrender.com`
2. That's it. The included workflow `.github/workflows/keepalive.yml` runs once a day. It wakes the site, and the site makes one tiny Supabase request. To test it now: repo → **Actions → Keep free services awake → Run workflow**.

Notes:
- It's free because this repository is public, and public repos get unlimited Actions minutes. If you ever make the repo private, the job still fits easily in the 2,000 free minutes, and GitHub can't charge an account without a payment method.
- GitHub turns scheduled jobs off after 60 days with no commits to the repo, and emails you first. One click on **Enable workflow** turns it back on.

---

## What file sharing allows
- **Types:** images (JPG, PNG, GIF, WebP, HEIC), PDF, Word, Excel, PowerPoint, TXT, CSV, MP4/MOV. The server checks each file's real contents, not just its name. Disguised files, SVG, HTML, archives and programs are refused.
- Visitors can attach files after their first message, and can paste screenshots or drag and drop. Large phone photos are shrunk in the browser first, which makes them faster on mobile data and saves storage.
- Only people in that conversation (and your team) can open a file. Links expire after 30 minutes and refresh automatically.

## What's stored in Supabase
Bucket `chat` (private):
- `backups/latest.db.gz` is the newest copy of all chats. It's taken every 3 minutes (only when something changed) and again when the server goes to sleep.
- `backups/daily/2026-11-10.db.gz` is one copy per day, kept 14 days.
- `files/<conversation>/<random id>` holds the files clients and your team send. The names are random, so nobody can guess a link.

Want backups but no file sharing? Add `FILE_UPLOADS=off`.
