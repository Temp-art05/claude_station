# Lịch sử session Claude / Terminal: xem, tiếp tục, xoá

## Mục tiêu

Trong tab **Claude** và **Terminals**: một danh sách các session đã đóng — bấm là **tiếp tục
đúng hội thoại đó**, bấm thùng rác là **xoá ngay, không popup confirm**.

Hôm nay dữ liệu đã có mà không ai thấy: `DELETE /api/terminals/:id` chỉ set
`status = "exited"` (`server/src/routes/terminals.ts:63`), row vẫn nằm trong DB, còn FE thì
lọc thẳng nó ra (`web/src/features/terminals/TerminalsTab.tsx:88` —
`terminals.filter((t) => t.status !== "exited")`). Đóng một tab Claude là mất dấu vĩnh viễn.

## Vấn đề thật: "tiếp tục" hiện nay đang đoán

`claudeCommand(restart = true)` sinh `claude --continue` (`server/src/lib/claude-cli.ts:31`),
mà `--continue` là **"hội thoại gần nhất trong cwd này"** — không phải hội thoại của tab đó.
Hai tab Claude trên cùng repo là đủ để restart nối vào sai hội thoại. Với một danh sách
lịch sử thì lỗi này thành hiển nhiên: 5 dòng khác nhau đều resume về cùng một chỗ.

CLI có sẵn đường đúng (đã kiểm tra trên máy):

```
--session-id <uuid>   Use a specific session ID for the conversation
-r, --resume [value]  Resume a conversation by session ID
```

Nên: mỗi terminal Claude tự sinh UUID lúc mở, chạy `claude --session-id <uuid>`; tiếp tục là
`claude --resume <uuid>`. Cùng lúc đó UUID cho ta **đường dẫn transcript chính xác** để xoá —
file là `~/.claude/projects/<slug-cwd>/<uuid>.jsonl`, và vì UUID là duy nhất, chỉ cần tìm theo
tên file, không phải suy ra `slug` (quy tắc slug của CLI không có tài liệu, đoán là sai sót).

## Phạm vi (đã chốt)

- Lịch sử = **row terminal đã đóng**, cả `kind=claude` và `kind=shell`. Không đụng Agent SDK
  chat (`chat_sessions`) và không liệt kê transcript CLI chạy ngoài app.
- UI **inline trong tab Claude / Terminals**, giống mục "Recent runs" của tab Commands.
- **Xoá không confirm**, và xoá **cả transcript jsonl của claude CLI** — không hoàn tác được.
  Nút vẫn đặt chế độ hiện-khi-hover như nút xoá command (`CommandsTab.tsx:213`) để giảm bấm
  nhầm, nhưng bấm là xoá thật, không hỏi lại.
- Tab **History** hiện tại (work_history) không đổi.

## Kiến trúc

| Hành động | Việc thực sự làm |
|---|---|
| Mở tab Claude | sinh UUID → lưu `terminals.claude_session_id` → `claude --session-id <uuid>` |
| Tiếp tục (session tmux còn) | `POST /api/terminals/:id/restart` → attach lại session đang sống (đã có từ plan tmux) |
| Tiếp tục (đã đóng hẳn) | cùng route → `claude --resume <uuid>` trong đúng cwd, fallback `claude --session-id <uuid>` nếu transcript mất |
| Tiếp tục shell | shell mới ở đúng cwd + env set cũ (không có state để nối, giống hôm nay) |
| Xoá một dòng | hard-delete row + `data/terminal-context/<id>.md` + `~/.claude/projects/*/<uuid>.jsonl` |

Row cũ (không có UUID) vẫn tiếp tục được bằng đường `--continue` như hôm nay, và xoá thì chỉ
xoá row — không có gì để trỏ tới transcript nào, và **đoán để xoá file là điều tuyệt đối không
làm**.

## Các bước

1. **`server/src/db/schema.ts`** — `terminals` thêm
   `claudeSessionId: text("claude_session_id")` (nullable, row cũ để NULL). Sinh migration
   bằng `npm run db:generate` (`migrate()` chạy sẵn lúc boot, `db/index.ts:24`).

2. **`shared/src/types.ts`** — `terminalSchema` thêm `claudeSessionId: z.string().nullable()`.
   Thêm `terminalHistoryItemSchema` = `terminalSchema` + `transcript: z.boolean()` (transcript
   còn hay không, để UI nói trước là "tiếp tục" có nối lại được thật hay chỉ mở mới).

3. **`server/src/lib/claude-cli.ts`** — `ClaudeCliContext` thêm `sessionId?: string`;
   `buildClaudeCommand`:
   - có `sessionId`, `restart = false` → `claude --session-id <uuid> <flags>`
   - có `sessionId`, `restart = true` → `claude --resume <uuid> <flags> || claude --session-id <uuid> <flags>`
   - không có `sessionId` → giữ nguyên `claude --continue <flags> || claude <flags>` (row cũ)
   Test bổ sung vào `server/src/lib/__tests__/claude-cli.test.ts`.

4. **`server/src/lib/claude-transcript.ts`** (mới) —
   - `transcriptPath(sessionId)`: đọc `~/.claude/projects/*/`, trả file `<uuid>.jsonl` đầu tiên
     tìm thấy (`null` nếu không có). Không tự suy ra slug từ cwd.
   - `removeTranscript(sessionId)`: xoá file đó nếu có, trả `boolean`.
   - Chỉ thao tác trong `~/.claude/projects`, và chỉ với tên file khớp regex UUID — chặn
     đường một `claudeSessionId` bẩn trong DB biến thành path traversal.

5. **`server/src/services/terminals.ts`** — `createTerminal`: `kind === "claude"` thì
   `claudeSessionId = randomUUID()`, ghi vào row và truyền xuống `claudeCommand()`;
   `claudeCommand(restart, opts)` nhận thêm `sessionId` và chuyển vào `buildClaudeCommand`.

6. **`server/src/routes/terminals.ts`**
   - `restart` (dòng ~88): đọc `existing.claudeSessionId` và truyền vào `claudeCommand(true, …)`.
     Bỏ được câu "resumes the last conversation in this directory" — giờ nó resume đúng session.
   - `GET /api/projects/:id/terminal-history?kind=&limit=50` (mới): row `status = "exited"`,
     `ORDER BY closedAt DESC`, kèm `transcript`. Endpoint riêng vì list terminal đang sống được
     poll liên tục và một project lâu ngày có thể có hàng trăm row đã đóng.
   - `DELETE /api/terminals/:id/record` (mới): 409 nếu row đang `running`, hoặc `orphaned` mà
     `tmuxAlive` (đóng nó trước đã — xoá lịch sử không phải là cách giết một session đang chạy);
     ngược lại `removeTerminalContext(id)`, `removeTranscript(claudeSessionId)`, xoá row, ghi
     `workHistory` kind `terminal_record_deleted`.

7. **`web/src/features/terminals/hooks.ts`** — `useTerminalHistory(projectId, kind)`,
   `useDeleteTerminalRecord(projectId)` (invalidate cả `terminals` và `terminal-history`).
   "Tiếp tục" dùng lại `useRestartTerminal` sẵn có.

8. **`web/src/features/terminals/TerminalsTab.tsx`**
   - Toolbar: nút toggle `History`; bật thì vùng pane hiển thị danh sách thay cho terminal
     (giữ `TerminalPane` mounted như hiện tại, chỉ ẩn — kill pane là mất scrollback). Không đếm
     số trên nhãn: query lịch sử chỉ chạy khi panel mở, có số thì phải fetch cả lúc đóng.
   - Mỗi dòng: badge kind, title, `cwd`, thời điểm đóng, dấu "no transcript" khi
     `transcript === false`; bấm dòng → `restart.mutate(id)` rồi chọn tab đó và tắt panel;
     icon thùng rác (hover) → `deleteRecord.mutate(id)`, không confirm.
   - Empty state hiện có thêm một câu trỏ sang History (câu tĩnh, không phụ thuộc số dòng).

9. **Docs** — `README.md` mục "Claude, in a real terminal": nói rõ mỗi tab Claude có session id
   riêng, tiếp tục là `--resume` đúng hội thoại đó, và xoá một dòng lịch sử là xoá luôn
   transcript của CLI.

## File chạm

Mới: `server/src/lib/claude-transcript.ts`, `server/drizzle/0014_*.sql` (generate).
Sửa: `server/src/db/schema.ts`, `shared/src/types.ts`, `server/src/lib/claude-cli.ts`,
`server/src/services/terminals.ts`, `server/src/routes/terminals.ts`,
`server/src/lib/__tests__/claude-cli.test.ts`,
`web/src/features/terminals/{TerminalsTab.tsx,hooks.ts}`, `README.md`.

## Edge cases

- **Row cũ không có UUID**: tiếp tục = `--continue` (như hôm nay), xoá = chỉ xoá row. Không
  đoán transcript.
- **Transcript đã bị prune bởi CLI**: `--resume` fail → fallback `--session-id <uuid>` mở mới
  trong cùng cwd. UI đã báo trước bằng "no transcript".
- **Xoá row đang chạy / đang detach còn sống**: 409, không cho — nút trong danh sách lịch sử
  chỉ hiện với row `exited` nên đây là hàng rào phía server.
- **UUID bẩn trong DB**: `removeTranscript` chỉ nhận UUID khớp regex và chỉ xoá trong
  `~/.claude/projects`.
- **Hai tab Claude cùng repo**: đây là ca mà `--continue` đang sai; sau thay đổi mỗi tab có id
  riêng nên resume không lẫn nhau nữa.
- **`--session-id` với id đã tồn tại**: chỉ xảy ra ở nhánh fallback sau khi `--resume` fail,
  tức transcript không còn — không đụng session đang sống.
- **`workflowRuns.terminalId`** là text thuần, không FK (`schema.ts:401`), nên hard-delete row
  không vỡ ràng buộc; run cũ chỉ trỏ vào một id không còn.
- **Danh sách phình**: `limit` mặc định 50, sắp theo `closedAt` giảm dần.

## Verify

1. `npm run check` pass (có test mới cho `buildClaudeCommand` với `sessionId`).
2. Mở 2 tab Claude trên **cùng một repo**, nói mỗi tab một câu khác nhau, đóng cả hai → History
   hiện 2 dòng → tiếp tục dòng thứ nhất: hội thoại đúng của tab đó quay lại (đây là ca
   `--continue` hôm nay làm sai).
3. `ls ~/.claude/projects/<slug>/` trước và sau khi bấm xoá một dòng → file `<uuid>.jsonl`
   biến mất, không có popup nào, dòng rời khỏi danh sách ngay.
4. Xoá một dòng shell → row biến mất, không có file nào bị đụng.
5. Tab Terminals: tiếp tục một shell đã đóng → shell mới đúng cwd, "env applied" đúng như cũ.
6. Row tạo trước thay đổi này (không có UUID) → vẫn tiếp tục được, xoá chỉ mất dòng.

## Trạng thái

Impl xong. `npm run check` pass (86 test, thêm 4 test cho `buildClaudeCommand` với `sessionId`).
Migration `server/drizzle/0014_productive_tarantula.sql` = `ALTER TABLE terminals ADD claude_session_id text`,
tự chạy lúc boot. Còn lại là verify tay theo mục trên.

## Đã chốt

1. Xoá là **hard-delete row + transcript, không confirm**, không có Undo.
2. Danh sách là **panel bật/tắt bằng nút `History` trên toolbar**; bật thì terminal chỉ bị ẩn
   (`display:none`) chứ không unmount, nên scrollback không mất.
