/**
 * `npm run tmux:ls` / `npm run tmux:prune`.
 *
 * Sessions on our socket outlive the server on purpose — that is what makes a
 * terminal survive a restart. The cost is that a session can end up with nothing
 * pointing at it (its row was deleted while the server was down, say), and only
 * the DB knows which those are. Orphaned-but-listed terminals are left alone:
 * that is the reattachable state, not litter.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import * as tmux from "../lib/tmux";

const [, , action = "ls"] = process.argv;

function rowFor(terminalId: string) {
  return db.select().from(schema.terminals).where(eq(schema.terminals.id, terminalId)).get();
}

const sessions = tmux.listSessions();
if (sessions.length === 0) {
  console.log(`No sessions on tmux socket "${tmux.TMUX_SOCKET}".`);
  process.exit(0);
}

const rows = sessions.map((session) => {
  const terminalId = tmux.terminalIdOf(session);
  const row = terminalId ? rowFor(terminalId) : undefined;
  const stale = !row || row.status === "exited";
  return { session, terminalId, row, stale };
});

for (const { session, row, stale } of rows) {
  const label = row ? `${row.title} — ${row.cwd} [${row.status}]` : "no terminal row";
  console.log(`${stale ? "stale" : "keep "}  ${session}  ${label}`);
}

if (action === "prune") {
  const stale = rows.filter((r) => r.stale);
  for (const { session, terminalId } of stale) {
    if (terminalId) tmux.killSession(terminalId);
    console.log(`killed ${session}`);
  }
  console.log(`\nPruned ${stale.length} of ${rows.length} session(s).`);
} else if (action !== "ls") {
  console.error(`Unknown action "${action}" — use ls or prune.`);
  process.exit(1);
}
