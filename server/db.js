// Persistence on Node's built-in SQLite (node:sqlite, Node >= 22.13). No native modules to build.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
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
    getMsg: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    listMsgs: db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500`),
    markRead: db.prepare(`UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender = ? AND read_at IS NULL`),
    countVisitorMsgs: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender = 'visitor'`),
    listConvs: db.prepare(`
      SELECT c.*,
        (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
        (SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'visitor' AND m.read_at IS NULL) AS unread
      FROM conversations c
      WHERE c.last_message_at IS NOT NULL
      ORDER BY c.last_message_at DESC
      LIMIT 300`),
    convSummary: db.prepare(`
      SELECT c.*,
        (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
        (SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'visitor' AND m.read_at IS NULL) AS unread
      FROM conversations c WHERE c.id = ?`),
  };

  return {
    close: () => db.close(),
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
