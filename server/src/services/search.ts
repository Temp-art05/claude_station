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

    -- Memory, so a note can be found by what it says rather than only by being
    -- pinned. Triggered like chat rather than reindexed like knowledge: the whole
    -- text is already in the row, so there is nothing to read off disk.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
      title, body, memory_id UNINDEXED, project_id UNINDEXED, tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS project_memories_ai AFTER INSERT ON project_memories BEGIN
      INSERT INTO memory_search(title, body, memory_id, project_id)
      VALUES (new.title, new.body, new.id, coalesce(new.project_id, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS project_memories_au AFTER UPDATE ON project_memories BEGIN
      DELETE FROM memory_search WHERE memory_id = old.id;
      INSERT INTO memory_search(title, body, memory_id, project_id)
      VALUES (new.title, new.body, new.id, coalesce(new.project_id, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS project_memories_ad AFTER DELETE ON project_memories BEGIN
      DELETE FROM memory_search WHERE memory_id = old.id;
    END;
  `);
}

/**
 * Turn a user's message into an FTS5 query.
 *
 * Everything is quoted and OR-ed: a prompt is prose, and prose contains `-`,
 * `*`, `"` and `:`, every one of which means something to FTS5's parser. The
 * alternative — passing the sentence through — is a syntax error on roughly
 * every real message.
 */
export function ftsQueryFrom(text: string, maxTerms = 12): string {
  const terms = [
    ...new Set(
      (text || "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  ].slice(0, maxTerms);
  return terms.map((term) => `"${term}"`).join(" OR ");
}

/**
 * Words that match everything and rank nothing. Both languages this repo is
 * worked in, because a Vietnamese prompt full of `được`/`không` otherwise ranks
 * every note equally and the retrieval is noise.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "have",
  "has",
  "was",
  "were",
  "you",
  "your",
  "our",
  "not",
  "but",
  "can",
  "will",
  "would",
  "should",
  "make",
  "made",
  "use",
  "using",
  "used",
  "add",
  "added",
  "fix",
  "fixed",
  "then",
  "than",
  "when",
  "what",
  "which",
  "được",
  "không",
  "của",
  "một",
  "những",
  "cho",
  "với",
  "này",
  "đó",
  "thì",
  "là",
  "và",
  "các",
  "nhưng",
  "nếu",
  "khi",
  "chỉ",
  "cũng",
  "đang",
  "đã",
  "sẽ",
  "trong",
  "ngoài",
  "theo",
]);

/**
 * Memories that match a message, best first.
 *
 * Pinned notes are left out by default: the prompt already carries those in full,
 * and retrieving one again would spend the budget saying the same thing twice.
 * The `memory_search` tool asks for them, because a person searching does not
 * care whether a note happens to be pinned.
 *
 * Both scopes at once: a global rule is as likely to be the relevant note as a
 * project one, and the caller renders them together.
 */
export function searchMemories(
  projectId: string | null,
  text: string,
  limit = 4,
  opts: { includePinned?: boolean } = {},
): { id: string; score: number }[] {
  const query = ftsQueryFrom(text);
  if (!query) return [];
  try {
    return sqlite
      .prepare(
        `SELECT m.memory_id AS id, bm25(memory_search) AS score
           FROM memory_search m
           JOIN project_memories p ON p.id = m.memory_id
          WHERE memory_search MATCH ?
            AND (? = 1 OR p.pinned = 0)
            AND (p.project_id IS NULL OR p.project_id = ?)
          ORDER BY score
          LIMIT ?`,
      )
      .all(query, opts.includePinned ? 1 : 0, projectId ?? "", limit) as {
      id: string;
      score: number;
    }[];
  } catch {
    // A malformed query is the user's prose, not a bug worth failing a turn for.
    return [];
  }
}

/** Index memories that predate the table (or a manual DB edit). */
export function backfillMemorySearch(): number {
  const count = sqlite.prepare("SELECT count(*) AS n FROM memory_search").get() as { n: number };
  if (count.n > 0) return 0;
  const info = sqlite
    .prepare(
      `INSERT INTO memory_search(title, body, memory_id, project_id)
       SELECT title, body, id, coalesce(project_id, '') FROM project_memories`,
    )
    .run();
  return info.changes;
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
    .prepare("INSERT INTO knowledge_search(name, description, body, item_id) VALUES (?, ?, ?, ?)")
    .run(row.name, row.description, textBodyOf(row.storedPath, row.kind), itemId);
}

export function reindexAllKnowledge(): number {
  const rows = db.select().from(schema.knowledgeItems).all();
  sqlite.prepare("DELETE FROM knowledge_search").run();
  for (const row of rows) {
    sqlite
      .prepare("INSERT INTO knowledge_search(name, description, body, item_id) VALUES (?, ?, ?, ?)")
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
      : (
          sqlite
            .prepare(
              `SELECT s.message_id AS messageId, s.session_id AS sessionId, s.seq AS seq,
                    snippet(chat_search, 0, '«', '»', '…', 12) AS snippet,
                    cs.title AS sessionTitle, cs.project_id AS projectId
               FROM chat_search s
               JOIN chat_sessions cs ON cs.id = s.session_id
              WHERE chat_search MATCH ?
              ORDER BY rank LIMIT ?`,
            )
            .all(match, limit) as Omit<ChatHit, "kind">[]
        ).map((r) => ({ ...r, kind: "chat" as const }));

  const knowledge: KnowledgeHit[] =
    scope === "chat"
      ? []
      : (
          sqlite
            .prepare(
              `SELECT k.item_id AS itemId, ki.name AS name, ki.project_id AS projectId,
                    ki.kind AS itemKind,
                    snippet(knowledge_search, 2, '«', '»', '…', 14) AS snippet
               FROM knowledge_search k
               JOIN knowledge_items ki ON ki.id = k.item_id
              WHERE knowledge_search MATCH ?
              ORDER BY rank LIMIT ?`,
            )
            .all(match, limit) as Omit<KnowledgeHit, "kind">[]
        ).map((r) => ({
          ...r,
          kind: "knowledge" as const,
        }));

  return { chat, knowledge };
}
