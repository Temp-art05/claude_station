import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, ensureDataDirs } from "../lib/data-dir";
import * as schema from "./schema";

ensureDataDirs();

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
try {
  chmodSync(DB_PATH, 0o600); // local single-user DB may hold tokens
} catch {
  /* best effort */
}

export const db = drizzle(sqlite, { schema });

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
migrate(db, { migrationsFolder });

export { schema, sqlite };
