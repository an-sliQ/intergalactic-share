// Persistence on Node's built-in SQLite (node:sqlite, Node >= 22.13). No native modules to build.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL,
      name          TEXT,
      email         TEXT,
      topic         TEXT,
      page          TEXT,
      referrer      TEXT,
      user_agent    TEXT,
      timezone      TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      last_message_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender          TEXT NOT NULL CHECK (sender IN ('visitor','agent','system')),
      agent_name      TEXT,
      body            TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      read_at         INTEGER
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      object_key      TEXT NOT NULL,
      name            TEXT NOT NULL,
      mime            TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('image','file')),
      size            INTEGER NOT NULL,
      uploader        TEXT NOT NULL CHECK (uploader IN ('visitor','agent')),
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_att_conv ON attachments(conversation_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_att_msg ON attachments(message_id);
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);
  `);

  const q = {
    insertConv: db.prepare(`INSERT INTO conversations
      (id, token_hash, page, referrer, user_agent, timezone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getConv: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
    updateProfile: db.prepare(`UPDATE conversations SET
      name = COALESCE(?, name), email = COALESCE(?, email), topic = COALESCE(?, topic), updated_at = ?
      WHERE id = ?`),
    updateContext: db.prepare(`UPDATE conversations SET page = ?, referrer = COALESCE(referrer, ?),
      timezone = COALESCE(?, timezone), user_agent = COALESCE(?, user_agent) WHERE id = ?`),
    setStatus: db.prepare(`UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?`),
    touch: db.prepare(`UPDATE conversations SET last_message_at = ?, updated_at = ?, status = 'open' WHERE id = ?`),
    insertMsg: db.prepare(`INSERT INTO messages (conversation_id, sender, agent_name, body, created_at)
      VALUES (?, ?, ?, ?, ?)`),
    getMsg: db.prepare(`SELECT m.*, a.id AS att_id, a.name AS att_name, a.mime AS att_mime, a.kind AS att_kind, a.size AS att_size
      FROM messages m LEFT JOIN attachments a ON a.message_id = m.id WHERE m.id = ?`),
    listMsgs: db.prepare(`SELECT * FROM (
        SELECT m.*, a.id AS att_id, a.name AS att_name, a.mime AS att_mime, a.kind AS att_kind, a.size AS att_size
        FROM messages m LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 500) ORDER BY id ASC`),
    insertAtt: db.prepare(`INSERT INTO attachments (id, conversation_id, message_id, object_key, name, mime, kind, size, uploader, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getAtt: db.prepare(`SELECT * FROM attachments WHERE id = ?`),
    attBytes: db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM attachments`),
    attCountSince: db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE conversation_id = ? AND created_at > ?`),
    kvGet: db.prepare(`SELECT v FROM kv WHERE k = ?`),
    kvSet: db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`),
    totalChanges: db.prepare(`SELECT total_changes() AS n`),
    markRead: db.prepare(`UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender = ? AND read_at IS NULL`),
    countVisitorMsgs: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender = 'visitor'`),
    listConvs: db.prepare(`
      SELECT c.*,
        (SELECT CASE WHEN m.body = '' THEN 'File: ' || COALESCE((SELECT a.name FROM attachments a WHERE a.message_id = m.id), 'File') ELSE m.body END FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
        (SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'visitor' AND m.read_at IS NULL) AS unread
      FROM conversations c
      WHERE c.last_message_at IS NOT NULL
      ORDER BY c.last_message_at DESC
      LIMIT 300`),
    convSummary: db.prepare(`
      SELECT c.*,
        (SELECT CASE WHEN m.body = '' THEN 'File: ' || COALESCE((SELECT a.name FROM attachments a WHERE a.message_id = m.id), 'File') ELSE m.body END FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
        (SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'visitor' AND m.read_at IS NULL) AS unread
      FROM conversations c WHERE c.id = ?`),
  };

  return {
    close: () => db.close(),
    // A consistent copy of the whole database (safe while the app is running), for backups.
    snapshot(toPath) { db.exec(`VACUUM INTO '${String(toPath).replace(/'/g, "''")}'`); },
    // Increases on every write; backups compare it to skip uploads when nothing changed.
    changeCounter: () => Number(q.totalChanges.get().n),
    kvGet: (k) => { const r = q.kvGet.get(k); return r ? r.v : null; },
    kvSet: (k, v) => q.kvSet.run(k, String(v)),
    // Message + attachment written together: either both exist or neither does.
    addAttachmentMessage({ conversationId, sender, agentName, attachment }) {
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const { lastInsertRowid } = q.insertMsg.run(conversationId, sender, agentName ?? null, '', now);
        const a = attachment;
        q.insertAtt.run(a.id, conversationId, Number(lastInsertRowid), a.key, a.name, a.mime, a.kind, a.size, sender, now);
        q.touch.run(now, now, conversationId);
        db.exec('COMMIT');
        return q.getMsg.get(Number(lastInsertRowid));
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    getAttachment: (id) => q.getAtt.get(id),
    attachmentBytes: () => Number(q.attBytes.get().n),
    attachmentCountSince: (conversationId, since) => Number(q.attCountSince.get(conversationId, since).n),
    createConversation({ id, tokenHash, page, referrer, userAgent, timezone }) {
      const now = Date.now();
      q.insertConv.run(id, tokenHash, page ?? null, referrer ?? null, userAgent ?? null, timezone ?? null, now, now);
      return q.getConv.get(id);
    },
    getConversation: (id) => q.getConv.get(id),
    updateProfile(id, { name, email, topic }) {
      q.updateProfile.run(name ?? null, email ?? null, topic ?? null, Date.now(), id);
    },
    updateContext(id, { page, referrer, timezone, userAgent }) {
      q.updateContext.run(page ?? null, referrer ?? null, timezone ?? null, userAgent ?? null, id);
    },
    setStatus: (id, status) => q.setStatus.run(status, Date.now(), id),
    addMessage({ conversationId, sender, agentName, body }) {
      const now = Date.now();
      const { lastInsertRowid } = q.insertMsg.run(conversationId, sender, agentName ?? null, body, now);
      if (sender !== 'system') q.touch.run(now, now, conversationId);
      return q.getMsg.get(Number(lastInsertRowid));
    },
    listMessages: (id) => q.listMsgs.all(id),
    markRead(conversationId, sender) {
      const now = Date.now();
      const r = q.markRead.run(now, conversationId, sender);
      return { changed: Number(r.changes), at: now };
    },
    visitorMessageCount: (id) => q.countVisitorMsgs.get(id).n,
    listConversations: () => q.listConvs.all(),
    conversationSummary: (id) => q.convSummary.get(id),
  };
}
