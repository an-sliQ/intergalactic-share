// Database backups to Supabase Storage (same private bucket as chat files).
//
// Render's free plan wipes the server's disk whenever it sleeps, restarts or redeploys. So:
//   • on start, if there is no database file yet, the latest backup is downloaded from storage;
//   • while running, a compressed copy is uploaded every BACKUP_INTERVAL_SEC, only if something changed;
//   • on shutdown (Render sends SIGTERM before sleeping), one final copy is uploaded.
// Also keeps one copy per day for BACKUP_KEEP_DAYS days, so a bad day can be rolled back.
//
// Cost: none. Uploads to Supabase are free (only downloads count toward the 5 GB monthly egress), and a
// compressed chat database is tiny. Old daily copies are deleted so storage stays small.
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';

const LATEST = 'backups/latest.db.gz';
const dailyKey = (d) => `backups/daily/${d}.db.gz`;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// Returns { restored: boolean, safeToBackUp: boolean }.
// If storage can't be reached at start, we must not later overwrite a good backup with an empty database.
export async function restoreIfMissing({ store, dbFile, log = console }) {
  if (!store.enabled) return { restored: false, safeToBackUp: false };
  if (existsSync(dbFile) && statSync(dbFile).size > 0) {
    // The real data is here already (e.g. a VPS), so backing it up is always safe.
    await store.ensureBucket().catch((e) => log.warn(`  ⚠  Storage check failed: ${e.message}`));
    return { restored: false, safeToBackUp: true };
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await store.ensureBucket(); // creates the private bucket on the very first start
      const gz = await store.get(LATEST);
      if (!gz) { log.log('  ↺  No backup in storage yet, starting with a fresh database.'); return { restored: false, safeToBackUp: true }; }
      const buf = gunzipSync(gz);
      if (buf.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('backup is not a SQLite file');
      mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
      writeFileSync(`${dbFile}.restore`, buf, { mode: 0o600 });
      renameSync(`${dbFile}.restore`, dbFile);
      log.log(`  ↺  Restored the database from storage (${(buf.length / 1024).toFixed(0)} KB).`);
      return { restored: true, safeToBackUp: true };
    } catch (e) {
      log.warn(`  ⚠  Restore attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  log.error('  ✖  Could not reach storage to restore the database. Running WITHOUT backups this time so the good backup is not overwritten.');
  return { restored: false, safeToBackUp: false };
}

export function startBackups({ store, db, intervalSec = 180, keepDays = 14, safeToBackUp, log = console }) {
  const state = { enabled: store.enabled && safeToBackUp, lastChange: -1, lastDaily: null, lastBytes: 0, running: null, lastAt: 0, lastError: null };
  if (!state.enabled) return { enabled: false, run: async () => {}, final: async () => {}, status: () => ({ ...state }), bytesStored: () => 0 };

  async function run({ force = false } = {}) {
    if (state.running) return state.running;
    state.running = (async () => {
      const before = db.changeCounter();
      if (!force && before === state.lastChange) return false;
      store.persistUsage(); // counters ride along inside the backup
      const tmp = join(tmpdir(), `plumb-backup-${process.pid}-${Date.now()}.db`);
      try {
        db.snapshot(tmp);
        const gz = gzipSync(readFileSync(tmp), { level: 9 });
        await store.put(LATEST, gz, { contentType: 'application/gzip' });
        const today = day();
        if (state.lastDaily !== today) {
          await store.put(dailyKey(today), gz, { contentType: 'application/gzip' });
          state.lastDaily = today;
          store.del(dailyKey(day(Date.now() - keepDays * 86400_000))).catch(() => {}); // free
        }
        state.lastBytes = gz.length; state.lastAt = Date.now(); state.lastError = null;
        state.lastChange = db.changeCounter();
        return true;
      } catch (e) {
        state.lastError = e.message;
        log.warn(`  ⚠  Backup to storage failed: ${e.message}`);
        return false;
      } finally {
        try { unlinkSync(tmp); } catch { /* already gone */ }
      }
    })();
    try { return await state.running; } finally { state.running = null; }
  }

  // Don't back up immediately on boot (nothing changed yet); start the timer.
  state.lastChange = db.changeCounter();
  const timer = setInterval(() => { run().catch(() => {}); }, Math.max(30, intervalSec) * 1000);
  timer.unref();

  return {
    enabled: true,
    run,
    // Called on shutdown: always try one last upload if anything changed.
    final: async () => { clearInterval(timer); return run(); },
    status: () => ({ enabled: true, lastAt: state.lastAt, lastBytes: state.lastBytes, lastError: state.lastError }),
    // Rough storage estimate: latest + one per kept day.
    bytesStored: () => state.lastBytes * (keepDays + 1),
  };
}
