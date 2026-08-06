# claude-station

Local dashboard for driving Claude Code across several repos at once — FE, BE, iOS/Swift,
Android/Kotlin, KMP — plus the daily Jira/Excel/GitHub chores. Runs entirely on your machine:
a Node server owns the PTYs and the Claude sessions, the browser is just the UI.

Implementation plan and decisions: [`docs/plans/claude-station.md`](docs/plans/claude-station.md).

## Requirements

- Node 24+ (tested on 26.4)
- `claude` CLI logged in (the Agent SDK reuses that login — no API key needed)
- Xcode Command Line Tools (node-pty builds against them on macOS)
- optional: `gh` CLI for the GitHub views

## Setup

```sh
npm install
cp .env.example .env
# put a fixed token in .env so it survives restarts:
#   CLAUDE_STATION_TOKEN=$(openssl rand -hex 32)
npm run dev
```

Without a token in `.env` the server generates one per install and keeps it in `data/.token`.
Either way it prints the URL to open:

```
  claude-station ready
  → http://127.0.0.1:5173/?t=09c5042c…
```

Open it once; the token goes into `localStorage` and the address bar is cleaned up immediately. The
same token works for `npm run build && npm start`, which serves UI and API from a single port.

## Why the token

The API can spawn shells and run build commands, so it is remote code execution by design.
Binding to `127.0.0.1` is not enough on its own: any page open in your browser can POST to
localhost. Every request therefore needs the shared token **and** an `Origin` from the
whitelist derived from `PORT` / `WEB_PORT`. Requests with a foreign `Origin` get 403,
requests without the token get 401.

## Where things live

Everything the app manages sits in `<repo>/data/` (gitignored), so deleting the repo leaves
nothing behind:

```
data/claude-station.db      SQLite (projects, sessions, messages, runs, settings)
data/.token                 API token, chmod 600
data/knowledge/<projectId>  per-project docs and spreadsheets
data/knowledge/global       the shared asset library (folders live here)
data/skills/<name>          skill sources (symlinked into ~/.claude/skills)
data/logs/<runId>.log       full build logs
data/worktrees/<sessionId>  per-session git checkouts
```

Move it with `CLAUDE_STATION_DATA`. The only path written outside the repo is the skills
symlink, because that is where Claude Code looks for user-level skills
(`CLAUDE_SKILLS_DIR` to change it).

## Configuration

| Layer | Where | Examples |
|---|---|---|
| Infrastructure | `.env` (read at boot) | `PORT`, `WEB_PORT`, `CLAUDE_STATION_DATA`, `CLAUDE_SKILLS_DIR`, `MCP_TOOL_TIMEOUT` |
| Behaviour | Settings page → `app_settings` table | approval timeout, parallel-turn cap, repo lock, IDE command, log tail sizes, worktree default |
| Per project | project detail → DB | repo paths + labels + descriptions, build/test commands, env sets |

## What it does

| Area | Notes |
|---|---|
| **Projects** | Group repos with a label + description per path (`~` and relative paths accepted). Descriptions are what Claude reads to tell your BE from your iOS app. |
| **Claude** | Embedded `claude` CLI terminals per repo (PTY + xterm, like Terminals but auto-running claude): the CLI's own TUI handles approvals; restart after a server restart resumes via `claude --continue`. Jira/GitHub "Work on this with Claude" opens one with the issue context pre-typed, never auto-sent. Agent workspaces and workflows still use the Agent SDK chat (streaming, approval modal, per-message history). |
| **Terminals** | Multiple real PTYs per project, scrollback replay on reconnect, orphan detection + restart. |
| **Commands** | Per-path build/test/lint runner (`xcodebuild`, `./gradlew`, `npm run …`) with live log, timeout and process-group kill. Presets for iOS / Android / KMP / Node. |
| **Claude's own tools** (MCP) | `jira_search/get/comment/transition/worklog`, `excel_list/read/write`, `knowledge_search`, `list_project_commands`, `run_project_command`, `read_command_log`. Every mutating call goes through the approval modal, so Claude can fix a failing build or update a ticket while you stay in control. |
| **Jira** | Cloud and self-hosted (Server/DC — Bearer PAT, API v2): my-issues list + JQL, ADF→markdown detail, comment / transition / log-work from the UI, "Work on this with Claude" seeds a session with the issue as context. |
| **GitHub** | PRs, issues, branches (incl. delete), releases, and a read-only file browser via the `gh` CLI (your existing login); repo entries accept full URLs; shortcut links into github.com per repo and per project path; same "Work with Claude" entry point. |
| **Knowledge** | Drop docs and spreadsheets per project, or into a global library organised in folders (`android`, `fe`, `be`…). Attach a whole folder to a project in one click — assets are shared, not copied, so fixing a skill fixes it everywhere. `.xlsx` is flattened to CSV per sheet so Claude reads it reliably. Skills are symlinked into `~/.claude/skills`. |
| **Agents** | Define subagents the main session can delegate to: prompt, per-tool allow/deny, model alias, turn cap. Enable one globally or per project. Presets for build-fixing (can run your gradle/xcodebuild commands), code review (read-only), Jira write-ups and spreadsheets. Imports and exports `.agent.md`, so they stay portable to plain Claude Code. |
| **Agent workspaces** | Start an agent from a project and it opens its own working tab in that project, with its own history that survives restarts. That agent runs as the main thread, so its prompt and tool allowlist apply to the whole conversation. Point an agent at your own `.html` and the tab renders that instead of the chat view. |
| **Workflows** | The sequence you repeat for a kind of work — read docs → plan → confirm → update docs → implement → test — as a library asset you import into projects. Steps are agents, project commands, or a stop for your decision; each step sets its own permission mode, so a long implement step can run unattended while the planning step still asks. An agent stops the run by calling `workflow_ask`, you answer on the run view, and later steps get those answers. Artifacts (plans, reports) are downloadable per step. A restart marks the in-flight step interrupted rather than re-running it blind. |
| **Project memory** | Notes that aren't in the code — conventions, decisions, gotchas. Pinned ones go into every session's prompt in full; the rest are titles Claude fetches on demand, so a big memory bank never eats the context window. Claude can save its own via `memory_write`. Import and export `.md`. |
| **Diff** | git status/diff per path, discard a file, optional per-session git worktree so two agents never share a working tree. |
| **Search** | SQLite FTS5 across chat history and imported knowledge. |
| **Env sets** | Global or per project, injected into terminals, build commands and chat sessions. |
| **History** | Audit feed of everything the app (and Claude) did. |
| **Doctor** | Versions, login state, PTY health, data-dir writability. |

## Scripts

```sh
npm run dev         # server (tsx watch) + vite
npm run check       # typecheck + eslint + vitest
npm run test        # vitest only
npm run lint        # eslint
npm run format      # prettier --write
npm run build       # build the web app
npm start           # production, single port
npm run db:generate # regenerate drizzle migrations after a schema change
npm run fix:pty     # re-apply +x on node-pty's spawn-helper (see below)
```

## Troubleshooting

**Terminals fail with `posix_spawnp failed`.** npm can skip dependency install scripts
(`allow-scripts`), and node-pty's `spawn-helper` then keeps its non-executable bit. `npm run
fix:pty` re-applies it; `postinstall` also runs it automatically. The Settings → Doctor panel
reports this as a failed PTY check.

**401, or the UI asks for a token.** Your browser is holding a stale token — the value in `.env`
changed, or the generated `data/.token` was regenerated. Reopen the URL the server printed, or paste
the token into the prompt.

**"Another session is already working in this repo."** Two Claude sessions must not write the
same working tree. Wait, or create the session with *own git worktree* checked — it gets its own
checkout under `data/worktrees/`.
