import { eq } from "drizzle-orm";
import { db, schema, sqlite } from "../db";
import { textBodyOf } from "./knowledge";

/**
 * FTS5 lives outside drizzle's schema (virtual tables), so it's created here and
 * kept in sync by triggers for chat + an explicit reindex for knowledge (which
 * has to read files off disk).
 */
export function ensureSearchTables(): void {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(
      text, message_id UNINDEXED, session_id UNINDEXED, seq UNINDEXED, tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_search(text, message_id, session_id, seq)
      VALUES (new.text_preview, new.id, new.session_id, new.seq);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
      DELETE FROM chat_search WHERE message_id = old.id;
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(
      name, description, body, item_id UNINDEXED, tokenize='porter unicode61'
    );
  `);
}

/** Rebuild one knowledge row's index entry (called after import). */
export function reindexKnowledge(itemId: string): void {
  const row = db
    .select()
    .from(schema.knowledgeItems)
    .where(eq(schema.knowledgeItems.id, itemId))
    .get();
  sqlite.prepare("DELETE FROM knowledge_search WHERE item_id = ?").run(itemId);
  if (!row) return;
  sqlite
    .prepare(
      "INSERT INTO knowledge_search(name, description, body, item_id) VALUES (?, ?, ?, ?)",
    )
    .run(row.name, row.description, textBodyOf(row.storedPath, row.kind), itemId);
}

export function reindexAllKnowledge(): number {
  const rows = db.select().from(schema.knowledgeItems).all();
  sqlite.prepare("DELETE FROM knowledge_search").run();
  for (const row of rows) {
    sqlite
      .prepare(
        "INSERT INTO knowledge_search(name, description, body, item_id) VALUES (?, ?, ?, ?)",
      )
      .run(row.name, row.description, textBodyOf(row.storedPath, row.kind), row.id);
  }
  return rows.length;
}

/** Backfill for rows that predate the index (or after a manual DB edit). */
export function backfillChatSearch(): number {
  const count = sqlite.prepare("SELECT count(*) AS n FROM chat_search").get() as { n: number };
  if (count.n > 0) return 0;
  const info = sqlite
    .prepare(
      `INSERT INTO chat_search(text, message_id, session_id, seq)
       SELECT text_preview, id, session_id, seq FROM chat_messages`,
    )
    .run();
  return info.changes;
}

export interface ChatHit {
  kind: "chat";
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  seq: number;
  snippet: string;
}

export interface KnowledgeHit {
  kind: "knowledge";
  itemId: string;
  name: string;
  projectId: string | null;
  itemKind: string;
  snippet: string;
}

/** FTS5 treats punctuation as syntax — quote each term so free text can't error. */
function toMatchQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  return terms.join(" AND ");
}

export function search(
  queryText: string,
  scope: "all" | "chat" | "knowledge" = "all",
  limit = 40,
): { chat: ChatHit[]; knowledge: KnowledgeHit[] } {
  const match = toMatchQuery(queryText);
  if (!match) return { chat: [], knowledge: [] };

  const chat: ChatHit[] =
    scope === "knowledge"
      ? []
      : (sqlite
          .prepare(
            `SELECT s.message_id AS messageId, s.session_id AS sessionId, s.seq AS seq,
                    snippet(chat_search, 0, '«', '»', '…', 12) AS snippet,
                    cs.title AS sessionTitle, cs.project_id AS projectId
               FROM chat_search s
               JOIN chat_sessions cs ON cs.id = s.session_id
              WHERE chat_search MATCH ?
              ORDER BY rank LIMIT ?`,
          )
          .all(match, limit) as Omit<ChatHit, "kind">[]).map((r) => ({ ...r, kind: "chat" as const }));

  const knowledge: KnowledgeHit[] =
    scope === "chat"
      ? []
      : (sqlite
          .prepare(
            `SELECT k.item_id AS itemId, ki.name AS name, ki.project_id AS projectId,
                    ki.kind AS itemKind,
                    snippet(knowledge_search, 2, '«', '»', '…', 14) AS snippet
               FROM knowledge_search k
               JOIN knowledge_items ki ON ki.id = k.item_id
              WHERE knowledge_search MATCH ?
              ORDER BY rank LIMIT ?`,
          )
          .all(match, limit) as Omit<KnowledgeHit, "kind">[]).map((r) => ({
          ...r,
          kind: "knowledge" as const,
        }));

  return { chat, knowledge };
}
