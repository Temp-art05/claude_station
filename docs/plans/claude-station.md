# Plan: claude-station — Local web app điều phối Claude Code

> Source of truth cho việc impl. Mọi path trong file này là **tương đối so với repo root** (thư mục chứa `package.json` gốc, ký hiệu `<repo>`) — không hardcode absolute path ở đâu.
> Revision 3 (2026-08-05): mọi runtime data về `<repo>/data/`, gom toàn bộ hằng số vào § Config. Xem `## Changelog` cuối file.

## Context

Người dùng cần 1 dashboard chạy local trên macOS để điều phối Claude Code làm các task dài hạn trên nhiều project (FE/BE/iOS Swift/Android Kotlin/KMP) + các việc hằng ngày (Jira, Excel, GitHub). Hiện tại phải mở nhiều terminal rời rạc, không có nơi lưu context/lịch sử tập trung.

**Quyết định đã chốt với user:**
- **Platform:** Web app local (React + Node), KHÔNG phải Electron/Tauri (có thể wrap sau). Browser chỉ render xterm.js; PTY thật chạy trong Node server → không có vấn đề xin quyền browser/macOS.
- **Claude:** Hybrid — terminal thật qua node-pty là bề mặt chính (tab Claude nhúng `claude` CLI, xem rev9 trong `docs/plans/chat-claude-terminal.md`); Agent SDK (`@anthropic-ai/claude-agent-sdk`, dùng login Claude Code sẵn có, không cần API key) phục vụ agent workspace + workflow.
- **Claude phải *tác động* được, không chỉ đọc:** expose in-process MCP server (Jira write-back, Excel read/write, knowledge search, chạy build/test command). Đây là seam kiến trúc — làm sau sẽ phải đập lại `claude-session.ts`.
- **Mobile là first-class:** mỗi project path có bộ command (build/test/lint/run) dùng chung cho UI button + Claude tool → phục vụ `xcodebuild`, `gradlew`, KMP.
- **Phase 1 gồm cả:** Projects + Chat + Terminals, Knowledge store, Env manager, Jira UI + write-back, GitHub UI, Excel import/export, commands runner, git diff panel, search, notifications. Phase 2 (để seam): quản lý agent riêng.

Đã verify trên máy (2026-08-05): Node **v26.4.0**, npm 11.12.1, `claude` CLI 2.1.222, `@anthropic-ai/claude-agent-sdk` 0.3.222, git 2.50.1. node-pty 1.1.0 chạy tốt trên Node 26 với prebuilt `darwin-arm64` — **nhưng** npm chặn install script của dependency nên `prebuilds/darwin-arm64/spawn-helper` mất bit +x → mọi `pty.spawn()` fail `posix_spawnp failed`. Đã xử lý bằng `scripts/fix-node-pty.mjs` + `postinstall` + check trong doctor. `gh` chưa có trên PATH của shell hiện tại (doctor báo đúng).

## Kiến trúc

```
Browser (localhost:5173 dev / 3789 prod)
  React UI: xterm.js, chat, dashboard, diff viewer
    │ HTTP /api (header x-cs-token) + WS /ws/terminal/:id?t=, /ws/chat/:id?t=
    │ ↑ Origin whitelist + shared token guard (xem § Security)
Node server (Fastify, bind 127.0.0.1:3789)
  • node-pty → zsh / claude CLI (multi-terminal)
  • claude-agent-sdk → chat sessions (stream + resume)
  •   └─ in-process MCP server: jira_* / excel_* / knowledge_search / run_project_command
  • command runner → xcodebuild / gradlew / npm (log ra file, stream về UI)
  • SQLite (drizzle + better-sqlite3, WAL, FTS5)
  • <repo>/data/ (db, knowledge, skills, agents, attachments, logs, worktrees)
    self-contained: xoá repo là xoá sạch; override bằng env CLAUDE_STATION_DATA
```

## Repo layout — npm workspaces (3 packages)

```
claude-station/
  package.json          # workspaces: ["shared","server","web"]; dev = concurrently
  shared/src/{types.ts, ws-protocol.ts}   # DTO + zod + WS message unions dùng chung 2 phía
  server/src/
    index.ts            # bootstrap; prod mode serve web/dist cùng port
    db/{schema.ts, index.ts, migrate.ts}
    lib/{data-dir.ts, id.ts, auth.ts, path-safety.ts}
    routes/{projects,chat,terminals,knowledge,env,jira,github,commands,git,search,attachments}.ts
    ws/{terminal-ws.ts, chat-ws.ts, command-ws.ts}
    mcp/{server.ts, tools-jira.ts, tools-excel.ts, tools-knowledge.ts, tools-commands.ts}
    services/{claude-session.ts, pty-manager.ts, knowledge.ts, skills.ts, excel.ts,
              jira.ts, gh.ts, env-sets.ts, commands.ts, git.ts, notify.ts, search.ts}
  web/src/{pages, components, features, lib, stores, theme}
```

Data dir runtime — **nằm trong repo**, `<repo>/data/`:

```
data/
  claude-station.db          # + -wal, -shm
  .token                     # shared token (chmod 600)
  knowledge/global/          # docs/xlsx global
  knowledge/<projectId>/     # docs/xlsx per project
  skills/<name>/             # nguồn thật của skill (symlink từ ~/.claude/skills trỏ vào đây)
  agents/<name>.md
  attachments/<sessionId>/
  logs/<commandRunId>.log
  worktrees/<sessionId>/     # git worktree khi session bật useWorktree
```

`.gitignore` phải có `data/` (hiện chưa có — thêm ở M1). Resolve trong `lib/data-dir.ts`: `DATA_DIR = process.env.CLAUDE_STATION_DATA ?? <repo>/data`, tìm repo root bằng cách đi lên từ `import.meta.url` tới thư mục có `package.json` chứa field `workspaces` (không dùng `process.cwd()` — nó đổi theo chỗ gõ lệnh).

## Stack

| Layer | Chọn |
|---|---|
| FE | Vite 8 + React 19 + TS 5.9, Tailwind v4 + shadcn/ui (dark default, token qua `@theme`), react-router 8, TanStack Query 5 (server state), Zustand 5 (chỉ ephemeral: terminal tabs, streaming buffer, permission queue) |
| Terminal | `@xterm/xterm` 6 + addon-fit (bắt buộc) + addon-webgl (try/catch fallback renderer thường) |
| BE | Fastify 5 + `@fastify/websocket`, zod 4 + fastify-type-provider-zod, execa 10 (gh CLI, build commands), `@fastify/multipart`, gray-matter |
| DB | drizzle-orm 0.45 + better-sqlite3 13 (sync, single-user) + drizzle-kit migrations chạy lúc boot; FTS5 tạo bằng raw SQL trong migration |
| PTY | node-pty 1.1 — native addon, Node 25 có thể phải build từ source (cần Xcode CLT); fallback: pin Node 24 LTS qua `.nvmrc` |
| Claude | `@anthropic-ai/claude-agent-sdk` **pin exact 0.3.222** — build number khớp CLI `2.1.222`; pin **cả cặp** SDK+CLI và ghi vào README + doctor panel |
| Excel | SheetJS từ CDN vendor (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` — bản npm stale ở 0.18.5) |
| Diff | `diff` + render tự viết (không cần monaco cho v1) |

### Agent SDK — cách dùng (đã verify với `sdk.d.ts` 0.3.222)

```ts
const q = query({
  prompt: userText,                          // 1 query() per user turn
  options: {
    cwd: primaryRepoPath,
    resume: sdkSessionId,                    // resume session cũ
    permissionMode,                          // xem enum bên dưới
    canUseTool: async (toolName, input, opts) => forwardToBrowserAndAwait(toolName, input, opts),
    settingSources: ['user', 'project'],     // load ~/.claude skills + CLAUDE.md của repo ('local' cũng hợp lệ)
    additionalDirectories: [...otherRepoPaths, projectKnowledgeDir],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: workspaceContext },
    mcpServers: { station: stationMcpServer },   // xem § MCP tool layer
    env: { ...process.env, ...envSetVars },
    includePartialMessages: true,
    abortController,
  },
});
for await (const msg of q) { captureSessionId(msg); persist(msg); broadcast(msg); }
```

**`PermissionMode` = `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`** (6 giá trị, verified). `shared/src/types.ts` phải khớp đủ — hiện đang thiếu `dontAsk` và `auto`. UI mặc định expose 4 cái đầu; `auto`/`dontAsk` để advanced.

**`canUseTool` signature là `(toolName, input, options)`** — không phải `(req)`. Policy phải chốt rõ:
- Có browser kết nối → gửi `permission_request`, chờ tối đa `permission.timeoutSec` (default 120s), hết hạn → **deny** kèm message "timeout".
- Không có browser (tab đã đóng) → **deny ngay** + ghi `work_history`, KHÔNG hold turn treo vô hạn.
- Session ở mode `bypassPermissions`/`dontAsk` → không gọi tới browser.
- Deny short-circuit không đi qua `canUseTool` sẽ về UI qua event riêng → render được lý do denial.

`workspaceContext` = map các repo path kèm label + mô tả ("`<path do user cấu hình>` — BE source: …") + index knowledge files (cap `prompt.knowledgeIndexBytes`, quá thì chỉ liệt kê tên + gợi ý dùng `knowledge_search`) + note file .xlsx có bản .csv parse sẵn bên cạnh + danh sách command khả dụng của từng path.

## Config

Nguyên tắc: **không hardcode**. Ba tầng, tầng sau override tầng trước.

**1. `.env` ở `<repo>` (hạ tầng — cần trước khi server boot)** — commit `.env.example`, `.env` đã ignore:

| Key | Default | Ghi chú |
|---|---|---|
| `PORT` | `3789` | prod serve cả web/dist cùng port |
| `WEB_PORT` | `5173` | dev only, dùng để build Origin whitelist |
| `CLAUDE_STATION_DATA` | `<repo>/data` | đổi nếu muốn data ra ngoài repo |
| `CLAUDE_SKILLS_DIR` | `~/.claude/skills` | đích symlink; **chỗ duy nhất buộc ra ngoài repo** vì Claude Code đọc user-level ở đây |
| `CLAUDE_STATION_TOKEN` | auto-gen | set cứng nếu không muốn token đổi mỗi lần boot |
| `MCP_TOOL_TIMEOUT` | `900000` | ms, cho `run_project_command` |

**2. Bảng `app_settings(key pk, value JSON)` (hành vi — sửa được từ UI Settings, không cần restart):**

| Key | Default |
|---|---|
| `ide.command` | `xed` (macOS Xcode) — chọn `idea` / `code` / `xed` / custom |
| `permission.timeoutSec` | `120` |
| `concurrency.maxTurns` | `3` |
| `concurrency.repoLock` | `true` |
| `log.streamTailBytes` | `204800` (về UI) |
| `log.toolTailBytes` | `8192` (về Claude tool result) |
| `prompt.knowledgeIndexBytes` | `8192` |
| `terminal.scrollbackBytes` | `204800` |
| `notifications.enabled` | `true` |
| `git.useWorktreeDefault` | `false` |
| `theme.mode` / `theme.accent` | `dark` / `teal` |

Jira/GitHub credential vẫn ở bảng `integrations` (không để trong `.env`, để sửa được từ UI và không lẫn vào shell env của child process).

**3. Per-project / per-path (trong DB):** `project_paths` (path, label, description), `path_commands` (command, cwd_override, timeout_sec), `env_sets` + `env_vars`.

**Path do user nhập** (project paths): lưu **absolute đã normalize** vì trỏ tới repo bất kỳ ngoài máy; nhưng chấp nhận input dạng `~/...` và relative rồi expand + `realpath` trước khi lưu. UI hiển thị dạng rút gọn `~/IOS/ReelMe`. Không có path nào của user bị hardcode trong source hay trong plan này.

## Design system (user yêu cầu tự custom UI)

Chốt token trước khi code UI để các milestone không lệch nhau. Định nghĩa trong `web/src/index.css` qua Tailwind v4 `@theme`.

- **Mode:** dark only ở v1. `:root { color-scheme: dark }` để control native (checkbox, radio, scrollbar) tự dark — không thì cái checkbox chưa tick là thứ sáng nhất màn hình.
- **Palette (không đổi):** nền `#0e1013` / surface `#15181d` / `#1c2027` / `#242933`; accent **teal `#2dd4bf`** (action, focus, icon active); `amber #fbbf24` (đang chạy), `rose #fb7185` (lỗi/denied), `emerald #34d399` (exit 0), `violet #a78bfa` (thinking + glow phụ).
- **Typography:** display **Outfit Variable** (h1–h3, tiêu đề dialog), UI **Plus Jakarta Sans Variable**, mono **JetBrains Mono Variable**. Cả 3 self-host qua `@fontsource-variable/*` (10 file woff2 vào bundle) — không CDN, chạy offline. Body `letter-spacing: -0.006em`, heading `-0.02em`.
- **Shape:** radius sm 8 / md 12 / lg 16 / xl 20 / **pill 999** (button, tab, nav item, badge đều pill). Control height 28/36, gutter 12.
- **Liquid glass:** 3 utility trong `@utility` — `glass` (fill translucent + hairline `rgb(255 255 255 / 7%)` + `backdrop-filter: blur(16px) saturate(150%)` + inner top highlight), `glass-raised` (dialog, blur 22px), `glass-flat` (panel có scroll riêng, bỏ shadow). Nền app có 4 pool radial (teal góc trên-trái, violet góc trên-phải + dưới) để glass có gì mà khúc xạ — không có nó thì translucent chỉ ra xám phẳng.
- **`<select>` style global** trong base layer (appearance:none + chevron vẽ bằng gradient): native select không nhận class nên nếu bỏ qua thì nó là control vuông xám duy nhất còn lại.
- **Layout:** shell `p-2 gap-2`, sidebar 224px glass rounded-xl, content panel `glass-flat` rounded-xl.
- **Sidebar:** brand `text-lg font-bold` (font display); nav chia 3 nhóm, mỗi nhóm cách nhau bằng hairline `border-t`; nhãn nhóm (LIBRARY/SETUP) `text-xs font-bold uppercase tracking-[0.14em]`; item `font-semibold` (active `font-bold` + pill glass + icon teal); icon `strokeWidth 2.25` cho khớp độ đậm của chữ.
- **State color mapping:** idle=neutral, running=amber (pulse), error=rose, exited/orphaned=neutral-dim, success=emerald.
- **Verify UI bằng ảnh thật:** Chrome headless (`--headless=new --screenshot`) trỏ vào prod build kèm `?t=<token>` — đã dùng để bắt select/checkbox native và project mồ côi.

## SQLite schema

```sql
projects(id ulid pk, name, description, created_at, updated_at)
project_paths(id pk, project_id fk, path, label, description, is_default, sort_order)
path_commands(id pk, project_path_id fk, name, kind /*build|test|lint|run|custom*/,
              command, cwd_override NULL, timeout_sec DEFAULT 900, sort_order)
command_runs(id pk, project_id fk, path_command_id fk NULL, command, cwd,
             exit_code NULL, log_path, origin /*ui|claude*/, session_id NULL,
             started_at, finished_at NULL)
chat_sessions(id pk, project_id fk, title, sdk_session_id, cwd, env_set_id NULL,
              permission_mode, model NULL, origin /*manual|jira:KEY|github:pr:N*/,
              status /*idle|running|error*/, worktree_path NULL,
              kind /*chat|agent*/, agent_name NULL,
              created_at, updated_at, archived)
chat_messages(id pk, session_id fk, seq /*monotonic*/, role, type /*SDKMessage.type*/,
              content /*raw SDKMessage JSON — source of truth*/, text_preview, created_at)
chat_attachments(id pk, session_id fk, kind /*image|file*/, mime, stored_path,
                 original_filename, created_at)
terminals(id pk, project_id fk, title, cwd, env_set_id NULL, pid NULL,
          kind /*shell|claude — claude chạy `claude` CLI, PTY chết theo nó*/,
          command NULL /*app agent: lệnh PTY đã chạy — restart chạy lại đúng lệnh*/,
          status /*running|exited|orphaned*/, created_at, closed_at)   -- metadata only
env_sets(id pk, project_id NULL /*NULL = global, dùng được mọi project*/, name,
         description, created_at)
env_vars(id pk, env_set_id fk, key, value, is_secret)                 -- plaintext local
knowledge_items(id pk, project_id NULL /*NULL=global*/, kind /*doc|excel|skill|folder*/, folder,
                name, description, original_filename, stored_path /*kind=folder|skill: directory*/,
                parsed_path NULL, size_bytes, created_at)
integrations(id pk, kind UNIQUE /*jira|github*/, config JSON)
app_settings(key pk, value JSON)                                      -- xem § Config tầng 2
agents(id pk, name UNIQUE, description, prompt, tools JSON NULL, disallowed_tools JSON NULL,
       skills JSON NULL, model NULL, max_turns NULL, background, view_path NULL,
       view_url NULL /*app agent: URL web UI của app, iframe trong workspace tab*/,
       start_command NULL /*app agent: lệnh chạy trong terminal Station tại bundle_dir*/,
       bundle_dir NULL /*folder import: companion files, thêm vào additionalDirectories*/,
       enabled_globally, source /*manual|imported*/, created_at, updated_at)
project_agents(id pk, project_id fk, agent_id fk)                     -- UNIQUE(project_id, agent_id)
project_knowledge(id pk, project_id fk, knowledge_item_id fk)         -- attach asset library vào project
project_memories(id pk, project_id fk, title, body, tags JSON NULL, pinned,
                 source /*manual|imported|claude*/, created_at, updated_at)
work_history(id pk, project_id fk, kind, ref_id, summary, created_at)
```

`work_history.kind` — enum chốt cứng, mỗi service tự ghi row khi hành động thành công:
`session_created | session_archived | session_error | terminal_opened | terminal_killed | knowledge_imported | knowledge_deleted | env_set_applied | command_run | permission_denied | jira_commented | jira_transitioned | jira_worklogged | github_linked | git_reverted`.
UI group theo ngày, filter theo `kind`.

**FTS5** (raw SQL trong migration, external-content tables):
```sql
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(text_preview, content=chat_messages, content_rowid=rowid);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(name, description, body);
```
+ trigger insert/delete sync. `knowledge_fts.body` chỉ index file text/markdown/csv < 1MB.

Index: `chat_messages(session_id, seq)` UNIQUE, `project_paths(project_id)`, `path_commands(project_path_id)`, `command_runs(project_id, started_at)`, `knowledge_items(project_id)`, `env_sets(project_id)`.
Lưu chat theo **row từng message** (không phải 1 blob transcript) → pagination, re-render từng phần, crash-safe.

## Security (localhost KHÔNG có nghĩa là an toàn)

API này spawn PTY = arbitrary code execution. Bất kỳ trang web nào đang mở trong browser đều POST được vào `localhost:3789` (CSRF / DNS rebinding) → **bắt buộc** có guard, không phải nice-to-have.

- **Shared token:** boot sinh 32-byte hex (hoặc lấy `CLAUDE_STATION_TOKEN`), lưu `<repo>/data/.token` (chmod 600, đã trong `.gitignore` theo `data/`). In URL kèm `?t=<token>` ra console lúc start. Web đọc từ query → lưu `localStorage` → gửi header `x-cs-token` cho REST, query `?t=` cho WS. **Dev**: Vite plugin (`apply:'serve'`) đọc `data/.token` rồi chèn `<meta name="cs-dev-token">` vào HTML → `npm run dev` vào thẳng UI, không phải copy URL. Không dùng `define` vì Vite 8 không substitute define trong module dev-served và fail im lặng; prod build không có meta tag lẫn token (có check trong quy trình verify).
- **Guard middleware (`lib/auth.ts`)** áp cho mọi route trừ `GET /health`:
  1. token khớp (so sánh timing-safe), thiếu/sai → 401;
  2. `Origin`/`Host` nếu có phải thuộc whitelist sinh từ `PORT` + `WEB_PORT` (`http://localhost:{PORT,WEB_PORT}` + `http://127.0.0.1:{PORT,WEB_PORT}`) — có `Origin` lạ → 403 (chặn CSRF từ tab khác);
  3. WS: check cả token + Origin lúc handshake, reject trước khi upgrade.
- **CORS:** chỉ allow whitelist trên, `credentials: false`.
- **Bind:** `127.0.0.1` only, không `0.0.0.0`.
- **Path safety (`lib/path-safety.ts`):** mọi path do client cấp → `realpath` rồi prefix-guard theo allowlist = union(project_paths của project, data dir). Dùng cho file-serving, knowledge, command cwd, git.
- **Command allowlist:** command chỉ chạy từ `path_commands` đã lưu, không nhận command tự do từ body (Claude cũng phải gọi qua `run_project_command` với `commandId`, không phải shell string).
- **Secrets:** env/Jira token plaintext trong SQLite local: chấp nhận được (máy cá nhân); chmod 600 DB + `.token`, mask UI, không log value, redact khi ghi command log. Keychain = future option.

## MCP tool layer (để Claude *làm việc*, không chỉ đọc)

`mcp/server.ts` dùng `createSdkMcpServer({ name: 'station', version, instructions, tools })` + `tool(name, description, zodShape, handler)` (verified có trong SDK 0.3.222). Truyền qua `options.mcpServers = { station: server }` → Claude thấy tool tên `mcp__station__<tool>`.

| Tool | Input | Ghi chú |
|---|---|---|
| `jira_get_issue` | `key` | trả ADF→markdown |
| `jira_search` | `jql`, `limit` | |
| `jira_comment` | `key`, `body` | ghi `work_history` |
| `jira_transition` | `key`, `transitionId\|statusName` | list transition trước khi apply |
| `jira_worklog` | `key`, `timeSpent`, `comment?` | |
| `excel_read` | `knowledgeItemId`, `sheet?`, `range?` | đọc từ bản CSV parse sẵn |
| `excel_write` | `knowledgeItemId?`, `filename`, `sheets[]` | ghi file mới vào knowledge store, trả path để user download |
| `knowledge_search` | `query`, `projectScope` | FTS5, trả snippet + path (giữ prompt nhỏ) |
| `run_project_command` | `commandId`, `args?` | chạy build/test, stream log, trả tail log + exit code |
| `list_project_commands` | `projectId` | |

Ràng buộc: tool có side-effect (`jira_comment/transition/worklog`, `excel_write`, `run_project_command`) đi qua `canUseTool` → user duyệt trên UI. `MCP_TOOL_TIMEOUT` (ms) set ~15 phút cho `run_project_command` (mặc định gần như vô hạn).

## Commands / Mobile support

Đây là phần biến app từ chat-wrapper thành công cụ thật cho iOS/Android/KMP.

- Mỗi `project_path` có N `path_commands`. Preset gợi ý khi tạo path (user sửa được):
  - iOS: `xcodebuild -scheme <S> -destination 'platform=iOS Simulator,name=iPhone 16' build` / `... test`
  - Android/KMP: `./gradlew :app:assembleDebug` / `./gradlew test` / `./gradlew :shared:allTests`
  - FE: `npm run build` / `npm test` / `npm run lint`
  - BE: tuỳ repo
- Runner (`services/commands.ts`): execa 10, `cwd` = `cwd_override ?? path`, env = merge env set, timeout theo `timeout_sec`, log ghi thẳng file `logs/<runId>.log` + stream qua `WS /ws/command/:runId`, kill được.
- UI: tab **Commands** trong project — bảng command per path, nút Run, panel log (dùng chung CodeBlock/xterm-lite), history `command_runs` kèm exit code + duration.
- Claude gọi cùng runner qua `run_project_command` → log build lỗi quay lại chat làm context để tự sửa.
- **Không** làm simulator/emulator management ở v1 (chỉ chạy qua command; `xcrun simctl boot` cứ để user đưa vào command nếu cần).

## API surface

**REST `/api`** (zod-validated, sau auth guard):
- `projects` CRUD + `projects/:id/paths` CRUD + `paths/:id/commands` CRUD
- `projects/:id/sessions` (create nhận `{seedPrompt?, cwdPathId?, envSetId?, permissionMode?, origin?, useWorktree?}`), `sessions/:id`, `sessions/:id/messages?afterSeq=`, `sessions/:id/attachments` (multipart)
- `projects/:id/terminals`, `terminals/:id`
- `projects/:id/commands/run` (`{commandId, args?}`) → `{runId}`; `command-runs/:id` + `/log?offset=`
- `projects/:id/git/status|diff?pathId=`, `projects/:id/git/revert` (`{files[]}` — confirm 2 bước ở UI)
- knowledge per-project + global (multipart) + `knowledge/skills/import` + `knowledge/folder` (import cả thư mục = 1 item `kind=folder`; part filename mang relative path — cần `preservePath: true` khi register `@fastify/multipart`; root có `SKILL.md` → skill bundle nguyên cây). Tương tự: `agents/import-folder` (1 file .md định nghĩa + companion files vào `data/agents/<name>` = `bundle_dir`), `workflows/import-folder` (batch: mỗi yaml/json = 1 workflow, trả `{results[]}` imported/renamed/skipped/error). Trùng tên khi import → auto suffix `-2`, `-3`; sanitize relative path server-side (`lib/multipart.ts`)
- `env-sets` CRUD (`?projectId=` filter, `null` = global) + nested vars
- `jira/issues?jql=`, `jira/issues/:key`, `jira/issues/:key/comment|transition|worklog`, `jira/issues/:key/transitions`
- `github/:owner/:repo/pulls|issues`
- `integrations/:kind`, `projects/:id/history?kind=`, `search?q=&scope=chat|knowledge|all`
- `doctor` (version claude CLI / SDK / gh, login status, node-pty ok, data dir writable)

**WS `/ws/terminal/:id`**: client→ `{t:'input'|'resize'|'kill'}`; server→ **binary frame = raw PTY output**, JSON `{t:'exit'|'error'}`. Connect → replay ring buffer scrollback (`terminal.scrollbackBytes`).

**WS `/ws/chat/:sessionId`**: client→ `{t:'user_message'|'interrupt'|'permission_response'|'set_options'}`; server→ `{t:'session'|'message'|'delta'|'permission_request'|'tool_denied'|'status'|'result'|'error'}`. Reconnect: hydrate từ REST `afterSeq` rồi nghe live.

**WS `/ws/command/:runId`**: server→ binary log chunk + JSON `{t:'exit', code}`.

## Frontend pages

Sidebar: Projects · Jira · GitHub · Knowledge · Env · Search · Settings. Dark theme mặc định. Global header: indicator số turn đang chạy + số permission đang chờ.

- `/projects` — grid ProjectCard + dialog tạo/sửa (name, desc, bảng paths: path+label+description+commands preset)
- `/projects/:id` — tabs:
  - **Claude** (value `chat`, rev9 — xem `docs/plans/chat-claude-terminal.md`): `TerminalsTab kind="claude"` — nhiều PTY nhúng `claude` CLI (spawn `$SHELL -l -i -c "claude"`, restart orphaned → `claude --continue || claude`). Approve tool/resume/permission dùng TUI của chính CLI; hội thoại KHÔNG persist per-message vào DB (không vào search FTS). UI chat SDK cũ (`ChatTab`: MessageView, PermissionPrompt modal countdown, ChatInput + paste ảnh) chỉ còn dùng cho agent workspace.
  - **Terminals**: tabs tạo/kill/rename, TerminalPane (xterm + fit qua ResizeObserver + webgl fallback), popover chọn repo path + env set. Bắt phím trong xterm trước browser + `beforeunload` warning khi còn terminal chạy (mitigate Cmd+W)
  - **Commands**: bảng command per path + Run + log panel + history
  - **Diff**: panel git kiểu Android Studio — cây file project, changes + checkbox, diff side-by-side/unified, commit & push, branch info, revert file (confirm); group theo session (dùng `worktree_path` nếu có). Chi tiết: `git-panel.md`
  - **Knowledge**: bảng + dropzone import (nhận cả kéo-thả **folder** từ Finder, hoặc nút Import folder qua `webkitdirectory`); xlsx có nút xem bản parse
  - **History**: feed work_history (filter theo kind) + session archived
  - **Settings**: paths + commands CRUD, env set mặc định, repos GitHub, worktree on/off, delete
- `/jira` — bảng my-issues (REST v3, email+token từ Settings), drawer detail (ADF→markdown) + action **Comment / Transition / Log work** ngay trên UI, nút **"Work on this with Claude"** → chọn project → tạo terminal `kind='claude'` → nhảy vào tab Claude, context issue được gõ sẵn vào composer của CLI qua bracketed paste (không auto-gửi)
- `/github` — chọn repo (từ integrations), tabs PRs/Issues (gh CLI `--json` server-side), drawer detail, cùng action "Work with Claude"
- `/knowledge` — docs global + section Skills (trạng thái symlink) + section Agents
- `/env` — list env set (global + per-project), editor var (mask value, toggle reveal)
- `/search` — 1 input, kết quả group Chat / Knowledge, click → nhảy tới message/file
- `/settings` — Jira config, GitHub repos, IDE command, notification on/off, doctor panel

**Notifications:** khi session `result`, session `error`, hoặc `permission_request` mà tab không focus → Web Notification + sound + badge count trên sidebar. `services/notify.ts` fallback `osascript display notification` khi không có browser nào kết nối.

## Persist + resume chat

- `chat_sessions.sdk_session_id` = SDK session id **mới nhất**, ghi đè mỗi khi nhận init `system` message (resume có thể sinh id mới).
- Mọi SDKMessage persist thành row ngay khi stream → history render 100% từ DB của mình.
- Resume fail (transcript `~/.claude` bị prune) → catch, mở query mới kèm recap từ `text_preview` N message cuối, flag session "context rebuilt".
- Model: **1 `query()` / 1 user turn** — đơn giản, crash-safe. Interrupt = AbortController.
- **Concurrency theo repo:** 1 turn chạy/session; cap global ~3 turn song song; **và** lock theo repo path — 2 session cùng `cwd` không được chạy turn đồng thời (queue + cảnh báo UI). Muốn song song thật → bật `useWorktree` khi tạo session (default = `git.useWorktreeDefault`): server `git worktree add` vào `data/worktrees/<sessionId>`, lưu `worktree_path`, dọn khi archive.

## Knowledge/Skills vào session Claude

- Docs/Excel: copy vào store; xlsx parse server-side (SheetJS → CSV per sheet + meta.json) đặt cạnh bản gốc. Inject qua `additionalDirectories` (quyền Read) + `systemPrompt.append` (index có mô tả, **cap 8KB**) + tool `knowledge_search` cho phần còn lại.
- Skills: file thật nằm trong `data/skills/<name>/`, rồi **symlink `$CLAUDE_SKILLS_DIR/<name>` → `data/skills/<name>`**. Đây là chỗ duy nhất app ghi ra ngoài repo, vì Claude Code chỉ đọc skill user-level ở `~/.claude/skills`; gỡ = xóa link, nội dung vẫn nằm trong repo. Session chạy `settingSources: ['user','project']`.
- Agent definitions (**Phase 2 — đã impl**): bảng `agents` là nguồn thật (không phải file rời), `project_agents` giữ opt-in theo project. `agentsForProject(projectId)` = agent global ∪ opt-in của project → `options.agents`. Editor cho phép set `tools`/`disallowedTools` (3 trạng thái per tool: allow/deny/inherit), `model` alias, `maxTurns`, `background`, `skills`. Import/export `.agent.md` (frontmatter + prompt) nên agent vẫn portable sang Claude Code thường. Import được cả **folder agent** (1 file .md định nghĩa — ưu tiên `agent.md` — + companion files): companion vào `data/agents/<name>` (`bundle_dir`), session nào có agent đó sẽ nhận dir này trong `additionalDirectories` và prompt được append mục "Companion files" trỏ path; delete agent xoá luôn bundle dir. Kho file `knowledge_items` không còn giữ kind `agent`.
- Env set: merge vào `options.env` (chat), spawn env (PTY), và env của command runner.

## Agent workspace · Memory · Asset folders (rev8)

**Agent workspace = 1 route, không phải cơ chế mới.** Bấm Start ở tab Agents của project → tạo một `chat_sessions` với `kind='agent'` + `agent_name`, rồi điều hướng tới `/projects/:id?tab=agent:<sessionId>`. Tab đó xuất hiện trong thanh tab của project cạnh Claude/Terminals/… và **giữ context** vì bản chất vẫn là session bình thường: message persist theo row, resume qua `sdkSessionId`, duyệt tool y hệt. Khác biệt duy nhất là `options.agent = <tên agent>` — SDK cho agent đó chạy làm **main thread** (prompt/tools/model/maxTurns của agent áp cho luồng chính, không phải subagent). Agent được start luôn được nhồi vào `options.agents` dù chưa bật cho project, vì user đã chủ động start.
- **Agent thường** không cần workspace: nó là subagent, main session tự gọi qua tool `Agent` ngay trong tab Chat/Terminal của project.
- **Agent "to" có UI riêng:** `agents.view_path` trỏ tới file `.html` trong data dir. Có view thì tab render iframe `/api/agents/:id/view` (path-guarded, cùng origin nên HTML tự gọi được API bằng token); không có thì dùng chat view mặc định.

**Memory per project** — bảng `project_memories`. `pinned` đi vào `systemPrompt.append` **nguyên văn** (cap `prompt.knowledgeIndexBytes`), phần còn lại chỉ liệt kê tiêu đề; Claude tự lấy khi cần bằng `memory_get`. Đây là lý do memory không phình prompt. Import `.md` (heading `#` đầu làm title), export lại `.md`. MCP tools: `memory_list / memory_get / memory_search / memory_write` — `memory_write` cho Claude tự ghi lại điều đáng nhớ (source `claude`, có badge riêng trong UI).

**Asset folders** — `knowledge_items.folder` (`android`, `ios`, `kmp`, `fe`, `be`, …) + bảng `project_knowledge`. Asset global **không copy** vào project: attach là tạo liên kết, nên một skill dùng được cho nhiều project và sửa một chỗ là mọi project thấy. Attach cả folder một nhát (`POST /api/projects/:id/knowledge/attach {folder}`) — đúng mục đích "chọn nhóm cho nhanh". Session context liệt kê asset kèm nhãn `[library/<folder>]`, và `additionalDirectories` thêm thư mục của asset attach để tool Read đọc được.

## Workflows (nhóm asset thứ tư)

Trình tự làm việc lặp lại của một loại dự án (đọc docs → plan → confirm → update docs → impl → test), là asset có folder, import được vào nhiều project. Thiết kế + ghi chú khi impl: **[`workflows.md`](workflows.md)** — **đã impl W1→W5**.

Ba điểm chốt để nhớ: step `agent` **là** một `chat_sessions` (nên có sẵn stream/persist/resume/duyệt tool); câu hỏi confirm đến từ MCP tool `workflow_ask` (block trong lúc turn đang chạy) chứ không parse markdown; và **mỗi step khai `permissionMode` riêng** — step `impl` để `acceptEdits` mới chạy được không cần ngồi canh, còn tool `workflow_*` thì luôn allow vì chính nó là kênh consent.

## Milestones (thứ tự impl)

**Trạng thái 2026-08-06: M1 → M7 + Phase 2 đã impl xong toàn bộ.** M1 ✅ · M2 ✅ · M2.5 ✅ · M3 ✅ · M4 ✅ · M4.5 ✅ · M5 ✅ · M6 ✅ (vitest 24 test + eslint + prettier, `npm run check`) · M7 ✅ (git panel/worktree/repo lock, notifications, FTS5 search, open-in-IDE, image attachment) · **Phase 2 ✅** (bảng `agents` + `project_agents`, editor có allow/deny per tool, preset, import/export `.agent.md`, bật global hoặc per-project).

| # | Nội dung | Testable |
|---|---|---|
| M1 | Scaffold workspaces, Fastify+drizzle+migrate, Vite+Tailwind4+shadcn shell dark theo design token, Projects/paths CRUD (validate + expand `~` + realpath), `data/` trong repo + `.gitignore`, `.env.example`, `app_settings` + `lib/config.ts` | Tạo workspace 2 path có label; restart không mất; `git status` sạch sau khi chạy app |
| M2 | pty-manager, WS terminal, xterm tabs+fit+webgl, cwd picker, ring buffer replay, kill + sweeper | Chạy `claude` tương tác 2 tab; resize ok; restart đánh dấu orphaned |
| **M2.5** | **Security guard (token + Origin + CORS + path-safety), `path_commands` CRUD + command runner + WS log + tab Commands, doctor panel** | curl không token → 401; curl Origin lạ → 403; chạy `./gradlew test` và `xcodebuild` từ UI thấy log stream + exit code |
| M3 | claude-session service, WS chat, persist per-message, streaming UI, permission modal (timeout/deny policy), interrupt, resume qua restart, image attachment | Chat multi-turn sửa file repo có duyệt tool; paste screenshot Claude đọc được; tắt app mở lại chat tiếp |
| M4 | Knowledge import, skills symlink, agents qua options.agents, env sets CRUD (global + per-project) + inject, workspace context prompt (cap 8KB) | Claude nói đúng repo nào là "BE source", đọc doc import; skill trigger; env var thấy trong terminal + command |
| **M4.5** | **MCP server in-process: jira_* / excel_* / knowledge_search / run_project_command / list_project_commands; side-effect tool đi qua canUseTool** | Bảo Claude "comment vào ABC-123 và transition sang In Progress" → duyệt tool → Jira thật đổi; bảo Claude "build iOS rồi sửa lỗi compile" → nó gọi command, đọc log, sửa |
| M5 | Jira config + my-issues + detail + write-back UI, gh CLI PRs/issues, "Work with Claude" seeded session (origin), xlsx pipeline + preview + export | Chọn issue Jira thật → session có context issue; log work từ UI; Claude đọc sheet qua CSV và xuất file mới |
| M6 | History feed (kind filter), reconnect hardening, virtualized message list, cost display, prod single-port, README, vitest cho services + eslint/prettier + `npm run check` | `npm run build && npm start` dùng 1 port; `npm run check` xanh |
| **M7** | **Git panel (status/diff/revert) + worktree per session + repo lock, notifications, FTS5 search page, open-in-IDE** | Claude sửa 3 file → xem diff, revert 1 file; 2 session cùng repo bị queue; tắt focus tab → nhận notification; search ra message cũ |

## Risks / edge cases

- **node-pty build** trên Node 25 (không LTS, có thể không có prebuilt) → cần Xcode CLT; fallback `.nvmrc` Node 24; `npm rebuild node-pty` sau khi đổi Node major.
- **SDK 0.x drift** → pin exact `0.3.222` + kiểm CLI `2.1.222` trong doctor; lưu raw JSON + render defensive theo type với fallback raw view; mọi call SDK gói trong `claude-session.ts`. Đổi version = chạy lại checklist verify option names.
- **CSRF/DNS rebinding vào localhost** → token + Origin whitelist (§ Security). Đây là risk cao nhất vì API spawn được process.
- **Command injection** → chỉ chạy command đã lưu theo `commandId`, không nhận shell string từ client/Claude; args validate whitelist.
- **Long transcript** → pagination theo seq, virtualized list, không persist delta (chỉ message final).
- **Concurrency cùng repo** → repo lock + tuỳ chọn git worktree; không cho 2 turn ghi cùng working tree.
- **Prompt bloat từ knowledge** → cap index 8KB, phần còn lại qua `knowledge_search`.
- **Orphan PTY / command** → boot đánh dấu orphaned; SIGINT/SIGTERM kill hết PTY + child process managed; command run quá `timeout_sec` bị kill.
- **Build log khổng lồ** (xcodebuild) → ghi file `data/logs/`, chỉ stream tail `log.streamTailBytes` về UI, trả tail `log.toolTailBytes` cho Claude tool result.
- **Jira write-back sai** → luôn đi qua `canUseTool`; list transition trước khi apply; ghi `work_history` mọi mutation để audit.
- **Web vs native** → xung đột phím browser (Cmd+W): xterm bắt phím trước + beforeunload guard. Muốn app thật sau này: wrap Tauri/Electron, không viết lại.

## Verification tổng thể

1. `npm run dev` → mở URL kèm token, tạo project trỏ 2 repo thật (FE-ReelMe + 1 repo iOS), label rõ, thêm command build/test cho từng path.
2. `curl localhost:3789/api/projects` không token → 401; có token nhưng `Origin: https://evil.com` → 403.
3. Tab Terminals: mở 2 terminal, chạy `claude` trong 1 cái, lệnh shell trong cái kia.
4. Tab Commands: chạy `xcodebuild ... test` và `./gradlew test` → log stream, exit code đúng, history lưu.
5. Tab Chat: hỏi "repo BE của project này ở đâu, làm gì?" → trả lời đúng theo mô tả path; giao 1 task sửa code nhỏ → duyệt tool qua modal → verify diff bằng tab Diff + `git diff`.
6. Giao task mobile: "build iOS, nếu lỗi compile thì sửa" → Claude gọi `run_project_command`, đọc log, sửa file, build lại.
7. Import 1 file spec + 1 xlsx → hỏi Claude nội dung → trả lời đúng; bảo nó xuất 1 xlsx tổng hợp → file xuất hiện trong Knowledge.
8. Tạo env set (1 global, 1 per-project), gán vào terminal + command → `echo $VAR` ra đúng.
9. Jira: config token → thấy list issue của mình → comment + transition từ UI → "Work with Claude" ra session có context → bảo Claude log work → Jira đổi thật.
10. GitHub: thấy list PR repo AperoVN → mở detail.
11. Paste screenshot vào chat → Claude mô tả đúng ảnh.
12. Đóng focus tab, chạy task dài → nhận notification khi xong.
13. Search "ReelMe" → ra message chat cũ + knowledge file.
14. Tắt server, bật lại → history/session còn nguyên, resume chat được, terminal cũ đánh dấu orphaned.

## Changelog

- **rev14 (2026-08-06)** — Git panel phase 2 (plan: `git-panel.md` §Phase 2): **Branch menu** kiểu AS (search, Fetch/Pull/Pull--rebase/Push/New branch; click checkout — remote tự `switch -c --track`; hover có Merge/Rebase/Delete; banner + Abort khi merge/rebase dở), **History** (log 100 commit, refs badge, click xem file list + diff từng file của commit qua `git show`), **Rollback từng hunk** (nút ⤺ trên hunk header, client gửi nguyên văn patch của hunk → `git apply -R` qua stdin — file đổi tiếp thì fail có báo). Endpoint: GET `git/branches|log|commit-files|show`, POST `git/op` (11 verb, ghi work_history `git_op`), POST `git/revert-hunk`. Lưu ý: 2 thay đổi cách nhau <7 dòng bị git gộp 1 hunk (context 3 dòng mỗi bên) — rollback là rollback cả cụm.
- **rev13 (2026-08-06)** — Env mặc định theo từng repo path: cột `project_paths.env_set_id` (migration 0008), dropdown env per-path trong tab Commands (thay dropdown chung cả tab), `startRun` fallback `input.envSetId ?? path.envSetId` — nhờ đó `run_project_command` của Claude (trước giờ KHÔNG truyền env nào) cũng tự nhận env của repo. Phát sinh: (a) rolldown (vite 8) báo MISSING_EXPORT sai cho `normalizeGithubRepo` trong `types.ts` (~1150 dòng) dù tsc/esbuild/tsx đều thấy export — đổi function↔arrow không ăn thua, phải tách hàm sang `shared/src/github.ts`; (b) mô tả project trên header thu về 1 dòng click-to-expand (nó là context cho Claude, không cần phô đầy màn hình).
- **rev12 (2026-08-06)** — Git panel kiểu Android Studio (plan: `git-panel.md`). Tab Diff giờ có: cây file project (`git ls-files --cached --others --exclude-standard`, lazy expand, dot cảnh báo dir chứa thay đổi), diff **side-by-side** (parse unified patch client-side thành 2 cột — không thêm dependency; toggle unified), commit UI (checkbox từng file mặc định chọn hết, Amend, Commit / Commit & Push — push tự `-u origin HEAD` khi thiếu upstream), branch + ahead/behind (`git status -sb`), viewer file bất kỳ (cap 1MB, detect binary). Endpoint mới: `GET git/tree`, `GET git/file?rev=worktree|head`, `POST git/commit` (work_history `git_committed`). Gotcha: `git diff HEAD` không thấy file untracked → fallback `git diff --no-index /dev/null <file>` (exit 1 vẫn có patch trên stdout, phải bắt từ err.stdout).
- **rev11 (2026-08-06)** — App agents (plan: `app-agents.md`): agent dạng ứng dụng chạy độc lập (vd `jira-ai-fixer`). Cột mới `agents.view_url`/`start_command` + `terminals.command`; `POST /api/agents/:id/start {projectId, envSetId?}` idempotent (terminal title `agent:<tên>`); workspace tab render iframe app UI + TerminalPane cùng lúc, dropdown env set per-project (env set ĐÈ `.env` bundle — verified `node --env-file` không overwrite parent env). Phát sinh: (a) **bug zod v4 `.partial().parse()` vẫn áp `.default()`** → PATCH partial reset các cột có default về default; fix bằng `lib/patch.ts parsePatch()` áp cho cả 6 route PATCH (agents/projects/paths/commands/memory/env) — bug tiềm ẩn từ trước, lộ ra khi PATCH viewUrl xoá mất startCommand; (b) multipart không giữ execute bit → chmod 755 cho `*.sh` khi ghi bundle; (c) `sanitizeRelPath` đổi sang GIỮ dotfiles (`.env` từng bị strip thành `env` làm app hỏng), vẫn chặn `.`/`..`/absolute.
- **rev10 (2026-08-06)** — Folder import cho Knowledge/Agents/Workflows (plan: `folder-import.md`). Knowledge: kéo-thả/chọn cả thư mục → 1 item `kind=folder` (root có `SKILL.md` → skill bundle nguyên cây, `linkSkillTree`); Agents: folder = 1 định nghĩa .md + companion files → `bundle_dir` + `additionalDirectories`; Workflows: batch import mỗi yaml = 1 workflow. Trùng tên → auto suffix `-2`. Ghi chú phát sinh: (a) **busboy mặc định strip path khỏi filename** (`preservePath: false`) — phải bật `preservePath: true` khi register `@fastify/multipart`, không thì relative path của folder upload thành basename hết (bắt được nhờ smoke test curl); (b) default `parts: 1000` của multipart chặn folder >1000 file → nâng limits khi register; (c) fix bug sẵn có `attachedAssetDirs` slice string theo `/` cuối — sai với `storedPath` là directory (skill/folder), giờ check `statSync().isDirectory()`; (d) skill đổi tên khi trùng phải rewrite `name:` trong frontmatter SKILL.md, không thì Claude Code thấy 2 skill trùng tên.
- **rev9 (2026-08-06)** — Impl xong Workflows (W1→W5): bảng `workflows`/`workflow_steps`/`project_workflows`/`workflow_runs`/`workflow_run_steps`/`workflow_questions`/`workflow_artifacts`, engine `workflow-runner.ts`, 3 MCP tool `workflow_ask/emit_artifact/note`, library UI + editor + project tab + run view stepper, 3 workflow preset + 3 agent preset mới (`docs-planner`, `docs-writer`, `impl`). Bốn thứ phát sinh (chi tiết trong `workflows.md` § Phát sinh khi impl): `workflow_*` phải bypass `canUseTool`, reconcile phải quét cả run `awaiting_input`, `interrupted` phải chặn run, retry phải xoá câu hỏi treo + mở session mới.
- **rev8 (2026-08-06)** — Agent workspace + project memory + asset folders (xem § trên). Ghi chú: (a) `options.agent` là cách SDK chọn main-thread agent — không phải chỉ `options.agents`; (b) memory chia pinned/on-demand để không ăn context, thêm `memory_write` cho Claude tự nhớ; (c) attach thay vì copy asset, nên sửa skill một chỗ là mọi project thấy; (d) tab của project giờ là danh sách động (fixed tabs + 1 tab mỗi agent workspace đang mở) nên type `Tab` thành `string`; (e) bỏ `kind='agent'` khỏi `knowledge_items` (agent đã có bảng riêng từ rev6).
- **rev7 (2026-08-06)** — UI restyle + token cố định. (a) Font đổi sang Outfit/Plus Jakarta/JetBrains self-host, shape lên pill + radius lớn hơn, thêm 3 utility glass và ambient glow — giữ nguyên palette; (b) `.env` giờ thực sự được đọc: server chưa bao giờ load `.env` (tsx không tự load) nên `CLAUDE_STATION_TOKEN` bị bỏ qua im lặng → thêm `lib/env-file.ts` dùng `process.loadEnvFile`, **phải là import đầu tiên** trong `index.ts`; (c) bỏ auto-inject token ở dev theo yêu cầu — dev cũng nhập token như prod; (d) **bug bắt được nhờ screenshot**: `POST /api/projects` insert project rồi mới validate path → path sai để lại project mồ côi 0 repo; đã bọc create/update trong `db.transaction`.

- **rev6 (2026-08-06)** — Phase 2: agent management. Ghi chú: (a) SDK gọi subagent qua tool tên **`Agent`** với `subagent_type: "<tên agent>"` (không phải `Task` như tài liệu cũ) — verify bằng transcript thật; (b) `AgentDefinition` còn `disallowedTools`, `skills`, `maxTurns`, `background`, `initialPrompt` — UI expose 4 cái đầu; (c) agent global và per-project loại trừ nhau: bật global thì khoá toggle per-project để tránh 2 nguồn sự thật; (d) bỏ `kind='agent'` khỏi knowledge store, agent giờ có bảng riêng — vẫn import/export `.agent.md` để portable.
- **rev5 (2026-08-05)** — Impl M4/M4.5/M5/M6 + phần còn lại M7. Ghi chú phát sinh: (a) **SheetJS ESM không resolve được `fs`** → `XLSX.writeFile` fail "cannot save file"; phải dùng `XLSX.write(...,{type:'buffer'})` rồi tự `writeFileSync` (test bắt được, nếu không thì tool `excel_write` sẽ chết lúc runtime); (b) **auth guard ban đầu chặn cả static asset** → prod mode trả 401 cho `/` và `/assets/*` nên UI không load nổi để hỏi token; guard giờ chỉ áp cho `/api` + `/ws`; (c) MCP tool đi qua `canUseTool` như tool thường → mọi hành động ghi (jira_comment, excel_write, run_project_command) đều được duyệt trên UI, và Claude tìm chúng qua ToolSearch; (d) rule `react-hooks/set-state-in-effect` (React 19) bắt 13 chỗ sync state trong effect → sửa thành derive/`key` remount/adjust-state-during-render thay vì tắt rule; (e) Jira search dùng `POST /rest/api/3/search/jql` (endpoint GET `/search` đã deprecated).
- **rev4 (2026-08-05)** — Impl M1/M2/M2.5/M3 + git panel & worktree. Ghi chú phát sinh khi code: (a) `PermissionMode` có 6 giá trị, `canUseTool` là `(toolName, input, options)`; (b) ở mode `default` SDK tự allow tool read-only (Read/Glob/Grep) — chỉ Write/Edit/Bash mới gọi `canUseTool`, nên modal duyệt chỉ xuất hiện với thao tác ghi; (c) `@anthropic-ai/claude-agent-sdk` không export `package.json` qua exports map → doctor đọc version từ chỗ pin trong `server/package.json`; (d) `execa` không dùng nữa cho command runner — dùng `child_process.spawn` với `detached:true` để kill được cả process group (gradle daemon, xcodebuild con); (e) lucide v1 bỏ icon brand `Github` → dùng `GitPullRequest`; (f) Node 26 + npm allow-scripts làm hỏng `spawn-helper` (xem § Context).
- **rev3 (2026-08-05)** — Runtime data chuyển từ `~/claude-station-data/` vào **`<repo>/data/`** (self-contained, xoá repo là sạch; `.gitignore` thêm `data/`); mọi path trong plan là tương đối theo `<repo>`, bỏ hết absolute path của máy cụ thể; thêm **§ Config** 3 tầng (`.env` hạ tầng → bảng `app_settings` hành vi sửa từ UI → per-project trong DB) và bảng `app_settings`; các hằng số rải rác (timeout duyệt tool, cap knowledge index, scrollback, tail log, worktree default, IDE command, theme) giờ trỏ về config key thay vì số cứng; Origin whitelist sinh từ `PORT`/`WEB_PORT`; chỉ còn **1 chỗ duy nhất** ghi ra ngoài repo = symlink `$CLAUDE_SKILLS_DIR/<name>` (bắt buộc, vì Claude Code đọc skill user-level ở `~/.claude/skills`), nội dung skill vẫn nằm trong `data/skills/`.
- **rev2 (2026-08-05)** — Review plan rev1 phát hiện: (a) Mobile (iOS/KMP/Android) không có gì dù là yêu cầu gốc; (b) Jira/Excel read-only, Claude không có tool để tác động; (c) thiếu guard CSRF cho localhost API spawn process; (d) không có git diff/review, concurrency cùng repo chưa xử lý; (e) thiếu notification cho task dài, image attachment, search, design token spec, test/lint plan; (f) sai path repo + `execa` 9→10, `canUseTool` signature, `PermissionMode` thiếu 2 giá trị. → Thêm M2.5 / M4.5 / M7, § Security, § MCP tool layer, § Commands/Mobile, § Design system; mở rộng schema (`path_commands`, `command_runs`, `chat_attachments`, `env_sets.project_id`, `worktree_path`, FTS5, enum `work_history.kind`).
