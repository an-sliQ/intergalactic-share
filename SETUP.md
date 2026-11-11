# Free setup, step by step

Three add-ons, done one at a time. Each one stays **off** until you paste its settings into Render, so you can stop after any step and the site keeps working.

| Step | What you get | Account | Card needed? | Can it ever charge you? |
|---|---|---|---|---|
| 0. Render **Free** | The site + live chat online | render.com | **No** | No. Render cannot bill a workspace without a card. |
| 1. Firebase **Spark** | Team signs in to `/inbox` with Google | Google | **No** | No. Spark has no payment method, so it cannot bill. |
| 2. Cloudflare **R2** | Chat history survives restarts (backups) **and** clients can send files | Cloudflare | **Yes** (Cloudflare's rule, even for $0) | Only if usage passes the free tier. The app stops itself at about 30% of it (details below). |

---

## Step 0: Put the site on Render's free plan (5 min)

1. Sign in at **render.com** with GitHub. **Don't add a card.**
2. **New → Blueprint** → pick `an-sliQ/intergalactic-share` and this branch. `render.yaml` already says `plan: free` (no disk).
3. Render asks for values. For now fill only these and **leave the FIREBASE_* / TEAM_EMAILS / R2_* boxes empty**:
   - `PUBLIC_URL`: `https://plumb-contact.onrender.com` for now (your domain later).
   - `INBOX_PASSWORD`: a team password of 12+ characters (temporary; Google replaces it in step 1).
4. **Apply.** After 2–3 minutes, open the site and `/inbox`.

> **Already created it on the Starter plan earlier?** Service → **Settings → Instance type → Free**, then **Disks → delete the disk**. Disks are a paid add-on.

**What "free" means here:** the server sleeps after 15 minutes with no visitors, and the next visitor waits about a minute for it to wake. Each time it sleeps, its disk is wiped, so **chat history is lost on every sleep until you finish step 2**. Step 2 backs history up to R2 and restores it automatically.

---

## Step 1: Google sign-in for your team (Firebase, 10 min, no card)

1. Go to **console.firebase.google.com** → **Create a project** → name it e.g. `plumb-inbox`.
   - Google Analytics: **turn it off** (not needed) → **Create project**.
   - New projects start on the **Spark (free)** plan. If Firebase ever offers **Blaze** or **Upgrade to Identity Platform**, say no.
2. Left menu **Build → Authentication → Get started**.
   **Sign-in method** tab → **Google** → **Enable** → choose your support email → **Save**.
3. Still in Authentication → **Settings** tab → **Authorized domains** → **Add domain**:
   - `plumb-contact.onrender.com`
   - your own domain later (e.g. `yourdomain.com`, or `talk.yourdomain.com` if you use a subdomain)
4. ⚙️ (top left) → **Project settings** → **General** → **Your apps** → click the **`</>` (Web)** icon.
   - Nickname: `inbox`. **Don't** tick "Firebase Hosting". → **Register app**.
   - You'll see a `firebaseConfig = { ... }` block. Copy **only** these four values:
     `apiKey`, `authDomain`, `projectId`, `appId`.
5. In **Render → your service → Environment**, set:

   | Key | Value |
   |---|---|
   | `FIREBASE_API_KEY` | the `apiKey` |
   | `FIREBASE_AUTH_DOMAIN` | the `authDomain` (looks like `plumb-inbox.firebaseapp.com`) |
   | `FIREBASE_PROJECT_ID` | the `projectId` |
   | `FIREBASE_APP_ID` | the `appId` |
   | `TEAM_EMAILS` | the Google emails allowed in, comma-separated, e.g. `you@gmail.com, sara@gmail.com`. If your team uses company Google accounts, `@yourcompany.com` allows everyone at that domain. |

   **Save changes.** Render redeploys in about 2 minutes.
6. Open `/inbox` → **Continue with Google**. Done.

**Good to know**
- These Firebase values are *public by design* (every Firebase site puts them in the browser). Security comes from `TEAM_EMAILS`, which the server checks on every sign-in. Anyone not on the list is refused, even with a valid Google account.
- The team password **switches off automatically** once Google sign-in is configured. To keep both, add `ALLOW_PASSWORD_LOGIN=true`.
- Someone leaves the team? Remove their email from `TEAM_EMAILS` and save. Their session stops working right away.

---

## Step 2: Cloudflare R2 for backups + files (15 min, card on file)

**About the card:** Cloudflare requires a card or PayPal to switch R2 on, even though you'll stay inside the free tier. Free **every month**: 10 GB storage, 1,000,000 writes, 10,000,000 reads, and downloads are always free. This app enforces its own lower limits and **pauses file sharing** before it could get near them:

| Free tier (per month) | App's own cap (default) | Realistic use for a contact page |
|---|---|---|
| 10 GB stored | 5 GB (`STORAGE_CAP_MB`) | well under 1 GB |
| 1,000,000 writes | 300,000 (`R2_MONTHLY_WRITE_CAP`) | ~15,000 max for backups + a few hundred files |
| 10,000,000 reads | 3,000,000 (`R2_MONTHLY_READ_CAP`) | a few thousand |

Other limits: files are 10 MB max, 30 per conversation per day, and 300 uploads per day across the site. About 7% of the write budget is held back for backups. The usage counters are saved inside the backup, so a restart doesn't reset them.

### 2a. Turn on R2
1. Sign up or in at **dash.cloudflare.com** (free account).
2. Left menu **R2 Object Storage** → follow the prompt to enable R2. The plan shown is **$0/month + usage**. Add a card or PayPal.
   - *Extra safety (optional):* use a **virtual card with a low limit**. Many Indian banks and UPI apps can issue one.

### 2b. Create the bucket
1. R2 → **Create bucket**.
   - Name: `plumb-chat`
   - Location: **Automatic** (or the Asia-Pacific hint)
   - **Default storage class: Standard** ← important. *Infrequent Access* has **no free tier**.
2. **Create bucket.** Leave it **private**: don't turn on "Public access", the `r2.dev` URL or a custom domain. The app hands out private 30-minute links itself.
3. **Don't add lifecycle rules that move files to Infrequent Access.** The app already deletes old backups itself (deletes are free).

### 2c. Create a key that can only touch this bucket
1. R2 overview → **Manage API tokens** (also called *R2 API tokens*) → **Create API token** (an *Account* token is fine).
   - Permissions: **Object Read & Write**
   - Specify bucket(s): **Apply to specific buckets only → `plumb-chat`**
   - TTL: **Forever**
2. **Create.** Copy the **Access Key ID** and **Secret Access Key** now; the secret is shown only once.
3. Copy your **Account ID** (on the R2 overview page; it's also the first part of the endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

### 2d. Billing alert (free, optional but recommended)
Cloudflare has no hard spending cap, so add an email alert: **Manage account → Notifications → Add** → choose the **billing / usage-based billing** alert and set it for R2. With the app's caps it should never fire.

### 2e. Paste into Render
Render → **Environment**:

| Key | Value |
|---|---|
| `R2_ACCOUNT_ID` | your Account ID |
| `R2_BUCKET` | `plumb-chat` |
| `R2_ACCESS_KEY_ID` | the Access Key ID |
| `R2_SECRET_ACCESS_KEY` | the Secret Access Key |

**Save changes.** In **Logs**, after the redeploy, you should see:

```
Files    → on, up to 10 MB, R2 bucket "plumb-chat" (caps: …)
Backups  → to R2 every 180s when something changed, 14 daily copies kept
```

Test it: send a message and a photo from your phone, wait 3 minutes, then **Manual Deploy → Restart service**. The chat and the photo are still there.

**What gets stored in the bucket**
- `backups/latest.db.gz` is the newest copy of all chats, taken every 3 minutes (only when something changed) and when the server goes to sleep.
- `backups/daily/2026-11-10.db.gz` is one copy per day, kept 14 days.
- `files/<conversation>/<random id>` holds the files clients and your team send. Names are random, so nobody can guess a link.

Want backups but no file sharing? Add `FILE_UPLOADS=off`.

---

## What file sharing allows
- **Types:** images (JPG, PNG, GIF, WebP, HEIC), PDF, Word, Excel, PowerPoint, TXT, CSV, MP4/MOV. The server checks each file's real contents, not just its name. Disguised files, SVG, HTML, archives and programs are refused.
- Visitors attach files after their first message. They can paste screenshots or drag and drop. Large phone photos are shrunk in the browser first (sharper and faster on mobile data, and less storage used).
- Only people in that conversation (and your team) can open a file. Links expire after 30 minutes and refresh automatically.
