# Plan: Inject workspace context vào Claude **terminal** (không chỉ Chat session)

## Context

User cấu hình project `wis555-reelme-film-studio` với 3 repo paths kèm label + description:

| Path | Label |
|---|---|
| `/Users/dinhngocthe/Web/FE-ReelMe-film-studio` | FE source (default cwd) |
| `/Users/dinhngocthe/Docs/WIS555-Reelme-FilmStudio` | Document source |
| `/Users/dinhngocthe/BE/BE-WISS555` | BE source |

Khi user mở một **Claude terminal** từ claude-station và hỏi về BE, Claude trả lời "không tìm thấy BE project" — vì nó **hoàn toàn không biết** 2 path còn lại tồn tại.

**Root cause đã xác nhận bằng process tree.** Session đang chạy là PTY con của claude-station:

```
claude ← /bin/zsh -l -i -c claude ← node (claude_station/server, PID 46658)
```

`buildWorkspaceContext()` (`server/src/services/workspace-context.ts`) sinh ra đúng cái map repo đó, nhưng **chỉ được gọi ở một chỗ duy nhất** — `server/src/services/claude-session.ts:199`, tức Agent-SDK Chat session. Terminal kind `claude` chạy qua `claudeCommand()` (`server/src/services/terminals.ts:11-13`):

```ts
export function claudeCommand(restart: boolean): string {
  return restart ? "claude --continue || claude" : "claude";
}
```

CLI trần, không cờ nào. Nên terminal chỉ nhận được `cwd` + env set — không repo map, không knowledge index, không memory.

Khoảng cách giữa 2 loại session:

| | Chat (Agent SDK) | Claude terminal |
|---|---|---|
| Repo map + label/description | ✅ `systemPrompt.append` | ❌ |
| Knowledge index + memory | ✅ (cùng blob trên) | ❌ |
| Các repo path khác đọc được | ✅ `additionalDirectories` | ❌ |
| Station MCP tools | ✅ | ❌ (ngoài scope, xem cuối) |

**Kết quả mong muốn:** terminal `claude` biết đủ như Chat session — trả lời được "BE source ở đâu" và Read được file trong BE/Docs mà không cần user paste path.

## Scope

Chỉ terminal `kind: "claude"`. Không đụng:
- Terminal `kind: "shell"` — là shell thường, không phải Claude.
- App-agent terminal (`routes/agents.ts:122`) — truyền `command: agent.startCommand` riêng, thêm cờ claude vào là sai.

Cả 3 entry point tạo terminal `kind: "claude"` đều **không** truyền `command`, nên đều đi qua `claudeCommand()` và được fix cùng lúc:
- `routes/terminals.ts:48` — tab Claude thủ công
- `routes/integrations.ts:166` — "Work with Claude" từ Jira
- `routes/integrations.ts:366` — "Work with Claude" từ GitHub
- `routes/workflows.ts:193` — workflow run

## Cơ chế đã verify trên máy

CLI `claude` 2.1.222 nhận `--append-system-prompt-file <path>` (có thật, tuy không nằm trong danh sách chính của `--help`; xuất hiện ở dòng 47) và `--add-dir <dirs...>`.

Test thực tế trong scratchpad — đã chạy, đã pass:

```
$ printf 'TEST_MARKER_ZQ42: the secret project codename is Blueberry.\n' > ctx.md
$ claude -p "What is the secret project codename? Answer with one word." \
    --append-system-prompt-file ./ctx.md
Blueberry
```

Control: `claude -p "hi" --definitely-not-a-flag` → `error: unknown option` (chứng minh cờ lạ bị reject, nên "chạy được" không phải do CLI bỏ qua cờ).

Dùng **file** thay vì nhồi text vào command line: context là markdown nhiều dòng có backtick, `$`, `#`, quote — escape vào `zsh -l -i -c '<...>'` rất dễ vỡ. File tránh hẳn chuyện đó, và đọc được để debug.

Kích thước không phải vấn đề: cap là `prompt.knowledgeIndexBytes` (default 8192, `shared/src/types.ts:1077`) → context ≤ ~16KB + memory section ≤ 8KB, còn `ARG_MAX` = 1048576.

## Các bước

### 1. `server/src/lib/data-dir.ts` — thêm dir cho context file

Thêm `TERMINAL_CONTEXT_DIR = join(DATA_DIR, "terminal-context")` và đưa vào vòng lặp `ensureDataDirs()` (đang có sẵn ở dòng 14-18).

### 2. `server/src/services/terminals.ts` — sinh context file + build command

Hàm mới, đặt cạnh `claudeCommand`:

```ts
/** Ghi workspace context ra file để CLI đọc qua --append-system-prompt-file. */
function writeTerminalContext(projectId: string, terminalId: string): string
```

- Gọi lại `buildWorkspaceContext(projectId)` — **reuse, không viết lại** (`services/workspace-context.ts:14`).
- Ghi ra `TERMINAL_CONTEXT_DIR/<terminalId>.md`, return path.
- Context rỗng (project không tồn tại) → return `""`, caller bỏ cờ.

Đổi `claudeCommand` thành nhận đủ thông tin để dựng cờ:

```ts
export function claudeCommand(
  restart: boolean,
  opts?: { projectId: string; terminalId: string; cwd: string },
): string
```

- Không có `opts` → giữ nguyên hành vi cũ (`"claude"` / `"claude --continue || claude"`), để không phá caller nào còn sót.
- Có `opts` → dựng flag string:
  - `--append-system-prompt-file <ctxFile>`
  - `--add-dir` cho: các `projectPaths` của project **trừ** `cwd`, cộng `projectKnowledgeDir(projectId)` và `attachedAssetDirs(projectId)` — mirror đúng `claude-session.ts:158-165`, reuse cùng helper đó.
- Mọi path **single-quote** và escape `'` thành `'\''` trước khi nối, vì string này chui vào `zsh -c`.
- Restart: cờ phải có ở **cả hai** nhánh → `claude --continue <flags> || claude <flags>`.

**Lệch so với plan ban đầu (đã impl như dưới):** phần dựng string thuần được tách ra module riêng `server/src/lib/claude-cli.ts` (`shq()` + `buildClaudeCommand()`) thay vì để inline trong `terminals.ts`. Lý do: `terminals.ts` import `db`, mà `db/index.ts` mở SQLite + chạy migrate ngay lúc import — test nào import nó cũng đụng DB thật. Tách ra `lib/` (nơi các helper pure khác đang ở) thì unit test chạy được độc lập. `claudeCommand()` giữ nguyên vai trò gom dữ liệu từ DB/fs rồi delegate.

### 3. `createTerminal` (`services/terminals.ts:32`) — gọi trước `pty.start`

`id` đã được tạo ở dòng 34 trước `pty.start` (dòng 47), nên đủ dữ liệu:

```ts
command: input.command ?? (kind === "claude"
  ? claudeCommand(false, { projectId, terminalId: id, cwd })
  : undefined),
```

Dùng `cwd` (đã tính worktree ở dòng 45), không phải `base` — để `--add-dir` không loại trừ sai path.

### 4. `routes/terminals.ts:111` — restart cũng phải regenerate

Sinh **lại** context file mỗi lần restart, vì user có thể đã sửa/thêm path (đúng ca đang gặp):

```ts
existing.command ?? (existing.kind === "claude"
  ? claudeCommand(true, { projectId: existing.projectId, terminalId: id, cwd })
  : undefined)
```

### 5. Cleanup

Xóa `TERMINAL_CONTEXT_DIR/<terminalId>.md` ở chỗ đang set terminal `closedAt`/kill. File nhỏ nên không gấp, nhưng để lại thì data dir phình dần theo số terminal từng mở.

## Edge cases

- **Project chưa có path** → `resolveCwd` đã throw `badRequest` trước đó (dòng 23), không tới được bước dựng cờ.
- **Context rỗng** → bỏ `--append-system-prompt-file`, vẫn giữ `--add-dir`.
- **Worktree terminal** → `cwd` là `data/worktrees/<id>`, không nằm trong `projectPaths`, nên **tất cả** repo path đều vào `--add-dir`. Đúng ý muốn.
- **Path có space/quote** → xử lý bởi `shq()`; cần test 1 path có space.
- **`claude --continue` fail** → nhánh `|| claude` vẫn giữ nguyên cờ, không tụt về CLI trần.
- **Backward compat** → `claudeCommand(restart)` gọi không `opts` vẫn hoạt động như cũ.

## Kết quả verification (đã chạy)

| Bước | Kết quả |
|---|---|
| `npm test` | 67/67 pass (9 file), gồm 10 test mới ở `lib/__tests__/claude-cli.test.ts` |
| `npm run typecheck` | sạch — chỉ còn 2 lỗi **có sẵn** ở `lib/__tests__/zip.test.ts` (file không chạm) |
| `eslint` các file đã sửa | sạch |
| Command sinh ra cho project thật | `claude --append-system-prompt-file '…/terminal-context/<id>.md' --add-dir '…/Docs/WIS555-Reelme-FilmStudio' --add-dir '…/BE/BE-WISS555' --add-dir '…/knowledge/<projectId>'` — cwd (FE) bị loại đúng |
| Nội dung context file | đủ 3 repo kèm label + description + path commands + memory section |
| Hỏi "repo BE ở đâu, Document source ở đâu" | trả lời đúng 2 đường dẫn tuyệt đối (đây là câu đã fail trước fix) |
| Read `BE-WISS555/package.json` | đọc được → `be-wiss555` |
| Control: cùng câu Read **không** `--add-dir` | bị chặn "outside this session's working directory" — đúng failure mode cũ |
| `ensureDataDirs()` | `data/terminal-context/` được tạo sau hot-reload |

## Verification (checklist gốc)

1. `npm run dev` trong `~/SkillsAgent/claude_station`.
2. Mở project `wis555-reelme-film-studio` → tab Terminals → tạo tab **Claude**.
3. Kiểm tra command thật sự được spawn: `ps -o command= -p <pid>` phải thấy `--append-system-prompt-file` + 2 `--add-dir`.
4. Đọc `~/SkillsAgent/claude_station/data/terminal-context/<terminalId>.md` — phải có cả 3 path kèm label/description.
5. Trong terminal đó hỏi: **"repo BE của project này ở đâu, mô tả gì?"** → phải trả lời `/Users/dinhngocthe/BE/BE-WISS555` là BE source (đây chính là câu đã fail).
6. Yêu cầu Read 1 file trong `BE-WISS555` và 1 file trong `Docs/WIS555-Reelme-FilmStudio` → không bị chặn ngoài-workspace.
7. Kill tab rồi Restart → lặp lại bước 5, vẫn đúng (chứng minh regenerate).
8. Thêm 1 path thứ 4 vào project → Restart tab → hỏi lại, phải thấy path mới.
9. `npm run typecheck` và `npm test` (có sẵn `services/__tests__/pure.test.ts`) — thêm unit test cho `shq()` và cho việc `claudeCommand(true, opts)` gắn cờ vào cả 2 nhánh.

## Gap còn lại (không nằm trong plan này)

Terminal `claude` vẫn **không** có `mcpServers.station` (Jira / knowledge_search / memory / build-command tools) mà Chat session có. `stationMcpServer()` là in-process SDK MCP server, muốn đưa cho CLI thì phải bọc thành stdio/HTTP MCP rồi truyền `--mcp-config` — việc riêng, đáng làm sau. Cần confirm với user có muốn làm không.
