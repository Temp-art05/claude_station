# History: đưa cả hội thoại của claude CLI vào app

## Mục tiêu

Tab **Claude → History** hiện thêm mục **From the CLI**: mọi hội thoại `claude` từng chạy
trong các path của project, **kể cả mở từ Terminal thật, không qua app**. Mỗi dòng
**Continue** được (mở tab Claude nối đúng hội thoại đó) và **xoá** được (xoá file transcript).

Vì sao cần: hôm nay History chỉ thấy row của app. Đo trên máy: project `claude_station` có
**0** row claude trong DB nhưng CLI đang giữ **25 hội thoại** của đúng repo đó (69 MB) —
toàn bộ phần việc mở từ Terminal là vùng tối, app không đường nào với tới.

## Phạm vi (đã chốt)

- **Hai mục riêng**, không trộn: `Sessions in this app` (row DB, như hiện tại) rồi
  `From the CLI` (transcript). Một hội thoại mở bằng app sẽ xuất hiện ở **cả hai** mục —
  đã chốt chấp nhận, bù lại nguồn dữ liệu luôn rõ. Mục app đánh dấu dòng nào còn transcript.
- **Phạm vi**: transcript có `cwd` **trùng hoặc nằm dưới** một path của project.
- **Xoá không chặn gì**: bấm là xoá file, kể cả hội thoại đang chạy ở Terminal khác. Dòng
  vẫn hiện thời điểm ghi cuối để tự nhìn mà tránh.
- Tab **Terminals** (shell) không có mục CLI — shell không có transcript.

## Kiến trúc

### Đọc transcript mà không đoán slug

Thư mục là `~/.claude/projects/<slug-cwd>/<uuid>.jsonl`, quy tắc `slug` không có tài liệu.
Không suy ra slug: **đọc `cwd` từ trong chính file**. Đã đo trên 184 file của máy:

| Đọc | Kết quả |
|---|---|
| head 8 KB | có `cwd` ở 94 file (record thứ ~4) |
| + tail 64 KB | đủ **184/184**, tổng **15 ms** |

Head thiếu khi record đầu quá lớn (ảnh paste). Tail luôn có vì mọi record `user`/`assistant`
đều mang `cwd`. Lấy từ tail cả `gitBranch` và `aiTitle` **cuối cùng** — đó chính là title
picker `--resume` hiển thị (`{"type":"ai-title","aiTitle":"…"}`), và branch đổi giữa phiên
nên bản cuối mới đúng.

Glob `*/*.jsonl` (một cấp) → bỏ `<uuid>/subagents/*.jsonl`: transcript subagent không phải
hội thoại độc lập và không có trong picker. Đây cũng là lý do con số đúng là 184, không phải
224 như `find` đệ quy đếm.

Cache theo `file → {mtime, size}`: file không đổi thì không đọc lại.

### Continue = nhận uuid làm của mình

`createTerminal` thêm `resumeSessionId`: row mới lưu **chính uuid đó** vào
`claude_session_id` và chạy `claude --resume <uuid> … || claude --session-id <uuid> …`
(nhánh `restart = true` đã có sẵn từ `docs/plans/terminal-session-history.md`). Sau đó hội
thoại CLI này thành session của app: nó vào mục `Sessions in this app`, và xoá ở đó sẽ kéo
transcript đi theo. Không có gì đặc biệt phải viết thêm cho luồng resume.

`cwd` lấy từ transcript, client không gửi path. Nó đi qua `resolveCwd` trong `createTerminal`,
tức vẫn `assertPathAllowed(cwd, projectId)` như mọi terminal khác — và bản thân việc lọc
"nằm dưới path project" đã là hàng rào thứ hai.

## Các bước

1. **`server/src/lib/claude-transcript.ts`** — thêm:
   - `interface CliTranscript { sessionId, cwd, gitBranch, title, sizeBytes, modifiedAt }`
   - `listTranscripts(root = PROJECTS_DIR): CliTranscript[]` — head+tail như trên, cache theo
     mtime/size, sort `modifiedAt` giảm dần. `root` tham số hoá để test được.
   - `transcriptsUnder(paths: string[])` — lọc `cwd === p || cwd.startsWith(p + sep)`.
   - Giữ nguyên `transcriptPath` / `hasTranscript` / `removeTranscript`.

2. **`shared/src/types.ts`** — `cliSessionSchema` (7 field trên + `adopted: boolean` = đã có
   row app nào mang uuid này).

3. **`server/src/services/terminals.ts`** — `createTerminal` nhận thêm
   `resumeSessionId?: string`: `claudeSessionId = input.resumeSessionId ?? randomUUID()`, và
   truyền `restart = Boolean(input.resumeSessionId)` cho `claudeCommand`.

4. **`server/src/routes/terminals.ts`**
   - `GET /api/projects/:id/cli-sessions?limit=100` — path của project → `transcriptsUnder`
     → gắn `adopted` bằng một truy vấn `claude_session_id in (…)`.
   - `POST /api/projects/:id/cli-sessions/:sessionId/continue` — 404 nếu không có transcript,
     400 nếu `cwd` không thuộc project; ngược lại `createTerminal(..., { kind: "claude",
     cwd, title, resumeSessionId })`, trả row (201).
   - `DELETE /api/projects/:id/cli-sessions/:sessionId` — project-scoped như hai route trên
     (transcript trên đĩa không thuộc project nào, nhưng `workHistory.projectId` là NOT NULL
     nên phải biết xoá từ project nào) → `removeTranscript`, ghi kind `cli_session_deleted`,
     204. Không chặn gì.

5. **`web/src/features/terminals/hooks.ts`** — `useCliSessions(projectId, enabled)`,
   `useContinueCliSession(projectId)`, `useDeleteCliSession(projectId)` (invalidate
   `cli-sessions` + `terminals` + `terminal-history`).

6. **`web/src/features/terminals/TerminalsTab.tsx`** — `HistoryPanel` thành hai mục cho
   `kind === "claude"`: mục app như cũ, thêm mục `From the CLI` (title, branch, dung lượng,
   thời điểm ghi cuối, badge `in app` nếu `adopted`), nút Continue + thùng rác. `kind ===
   "shell"` giữ một mục.

7. **Test** (`server/src/lib/__tests__/claude-transcript.test.ts`) — dựng thư mục tạm giả
   `~/.claude/projects`: file có `cwd` ở head, file chỉ có `cwd` ở tail, file có nhiều
   `ai-title` (phải lấy cái cuối), file trong `subagents/` (phải bị bỏ), và `transcriptsUnder`
   với path con.

8. **Docs** — `README.md`: History gồm cả hội thoại CLI, Continue nhận nó về app, xoá là xoá
   file thật.

## File chạm

Mới: `server/src/lib/__tests__/claude-transcript.test.ts`.
Sửa: `server/src/lib/claude-transcript.ts`, `shared/src/types.ts`,
`server/src/services/terminals.ts`, `server/src/routes/terminals.ts`,
`web/src/features/terminals/{TerminalsTab.tsx,hooks.ts}`, `README.md`.

## Edge cases

- **File khổng lồ** (16.7 MB có thật): chỉ đọc 8 KB đầu + 64 KB cuối, không bao giờ đọc hết.
- **`cwd` là worktree** (`data/worktrees/<id>`): không nằm dưới path project → không hiện.
  Đúng ý: đó là session app tự tạo, đã có ở mục app.
- **Transcript đang chạy**: xoá được, không cảnh báo (đã chốt). Phiên đang chạy sẽ mất lịch
  sử ngay giữa việc — dòng có hiện thời điểm ghi cuối để tự nhận biết.
- **Xoá xong CLI lại tạo file mới cùng uuid**: không xảy ra — uuid chỉ do phiên đó dùng.
- **Continue một hội thoại đã bị CLI prune sau 30 ngày**: không còn trong danh sách nên
  không bấm được; nếu bị prune giữa lúc mở panel thì fallback `--session-id` mở phiên mới.
- **Hai project chia nhau một path**: transcript hiện ở cả hai — đúng, cùng một cwd.
- **`aiTitle` chưa có** (phiên 2 message): fallback text user đầu tiên, cắt ngắn.
- **uuid bẩn từ client**: route chỉ nhận chuỗi khớp regex UUID, và mọi thao tác file vẫn
  chỉ trong `~/.claude/projects`.

## Trạng thái

Impl xong, `npm run check` pass (95 test, thêm 9 test cho parse transcript). Verify tay qua API
trên dữ liệu thật:

| Kiểm tra | Kết quả |
|---|---|
| `GET /cli-sessions` cho `claude_station` | **26 dòng** — 24 ở cwd repo + 2 ở thư mục con (`./web`, `./data/agents/…`), title khớp picker |
| `POST …/continue` một hội thoại 06/08 | row mới `kind=claude`, `claude_session_id` = đúng uuid CLI, tmux `cs-<id>` sinh ra và `claude.exe` chạy trong đó |
| `adopted` sau khi continue | `True` cho đúng dòng đó |
| Đóng tab test | row `exited`, **transcript vẫn còn** trên đĩa |
| `DELETE …/cli-sessions/<uuid>` (file giả) | 204, file mất; gọi lại → 404 |
| `DELETE …/cli-sessions/..%2F..%2Fsettings.json` | 400 |

Một chỗ phải sửa khi verify: route ban đầu dùng `z.string().uuid()`, mà Zod v4 kiểm cả bit
version/variant nên trả 400 cho id hợp lệ về mặt tên file. Đổi sang `z.string().regex(SESSION_ID)`
dùng chung regex với lib — cái ta cần là "không thoát khỏi thư mục transcript", còn chọn id là
việc của CLI.

## Verify

1. `npm run check` pass, có test mới cho parse head/tail/subagents.
2. Project `claude_station` → tab Claude → History: mục `From the CLI` phải ra **25 dòng**,
   title khớp picker `claude --resume` (dòng đầu là `Memory pin behavior across projects`).
3. Bấm **Continue** một dòng cũ → tab Claude mới mở, hội thoại cũ hiện lại, và row đó xuất
   hiện ở mục app với đúng uuid (`sqlite3 … select claude_session_id`).
4. Bấm thùng rác một dòng test → file `~/.claude/projects/*/<uuid>.jsonl` mất, `claude
   --resume` trong Terminal cũng không còn dòng đó.
5. Tab Terminals → History: không có mục CLI.
