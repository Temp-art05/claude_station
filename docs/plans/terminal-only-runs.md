# Plan: Chỉ còn một chế độ — mọi step chạy trong terminal, vẫn giữ bậc 3

> Nối tiếp [`workflows-l3-auto-and-parallel.md`](workflows-l3-auto-and-parallel.md) và
> [`workflow-consolidation-and-sprints.md`](workflow-consolidation-and-sprints.md).
> Mọi path tương đối theo `<repo>`. Trạng thái: **T1→T4 impl xong 2026-09-14, đã chạy thật một lần**.

## Mục tiêu

Bỏ thế lưỡng chế. Từ nay **mọi run chạy trong terminal Claude thật**, để nhìn được từng việc agent
làm — nhưng **không mất** những thứ khiến nó ở bậc 3: engine vẫn xếp lịch, gate vẫn đọc exit code,
trigger vẫn tự mở run, auto mode vẫn chạy không cần duyệt.

## Hai chế độ hôm nay, và vì sao không chế độ nào đủ

| | `engine` (Start run) | `terminal` (Run with Claude terminal) |
|---|---|---|
| Ai lái | Server: từng step một session Agent SDK headless | CLI: runbook dán vào PTY, CLI tự đi |
| Nhìn được không | Mở từng session ra xem, không phải một terminal | **Được** — terminal thật, thấy mọi thứ |
| DAG / song song | Có | Không |
| Gate đọc exit code | Có | Không — CLI tự báo "xong" |
| Auto mode, retry, condition | Có | Không |
| Trigger tự mở run | Có | Không |
| Tool của app (`workflow_ask`, `jira_*`…) | Có (MCP in-process) | **Không có** — chỉ curl báo tiến độ |

Nói gọn: chế độ nhìn được thì không có gì bắt buộc nó làm đúng; chế độ bắt buộc đúng thì không nhìn
được như một terminal.

## Hướng: engine vẫn lái, nhưng lái **vào PTY**

Giữ nguyên scheduler, gate, auto mode, trigger. Chỉ đổi **cách một step agent được thực thi**:
thay vì mở session Agent SDK headless, engine mở (hoặc dùng lại) một terminal `claude` thật, gõ prompt
của step vào đó, rồi **chờ lượt kết thúc**.

Ba mảnh:

### T1 — Biết khi nào lượt xong (mảnh khó nhất, đã có sẵn)

`transcript-follower` tail transcript của CLI và gọi `closeTurn` khi một lượt kết thúc. Thêm một
emitter nhỏ trong `session-ledger`: `onTurnClosed(claudeSessionId, cb)`. Engine `await` sự kiện đó
thay vì `await sendUserMessage`.

Không cần parse thêm gì. Đây là lý do A1 đáng giá hơn vẻ ngoài của nó.

**Edge case:** lượt không bao giờ kết thúc (agent treo) → deadline của run đã có; transcript bị xoá
giữa chừng → capture báo `stopped`, step chuyển `interrupted` chứ không treo vô hạn.

### T2 — Tool của app cho CLI (mảnh chặn)

CLI không chạy in-process nên không dùng được `createSdkMcpServer`. Cần một **cầu MCP stdio**:
`scripts/station-mcp-bridge.mjs`, khai qua `--mcp-config`, gọi ngược REST của app bằng token trong env
(`CLAUDE_STATION_URL`, `CLAUDE_STATION_TOKEN`, `CLAUDE_STATION_RUN_STEP`).

Tool cần bắc cầu, đúng bộ mà 7 workflow và 4 agent đang dùng:
`workflow_ask` · `workflow_emit_artifact` · `workflow_note` · `jira_*` (gồm sprint) ·
`run_project_command` · `read_command_log` · `knowledge_search` · `memory_*`.

REST cho `workflow_ask` và `workflow_emit_artifact` **chưa có** — phải thêm (đã có
`terminal-progress`, cùng hình dạng).

**Đây là phần lớn công của plan này.** Không có nó thì mọi instruction trong 7 workflow đều gãy.

### T3 — Một terminal cho mỗi step đang chạy

- Step tuần tự dùng lại terminal của run (xem một mạch, đúng ý "theo dõi").
- Step song song: mỗi nhánh một terminal, vì hai nhánh đã ở hai repo/worktree khác nhau rồi.
- Run view: tab terminal theo step, cái đang chạy được chọn sẵn.
- Permission: terminal mở kèm `--permission-mode` lấy theo `step.permissionMode` (`acceptEdits` cho
  step impl dài). Auto mode không đổi nghĩa: nó bỏ cổng duyệt **của workflow**, không nới quyền CLI.

### T4 — Bỏ chế độ cũ

- Bỏ đường `mode: "terminal"` kiểu runbook (dán một cục rồi để CLI tự đi) — nó chính là cái không
  bắt buộc được gì.
- Bỏ nút "Run with Claude terminal"; còn một nút **Run**.
- `workflow_runs.mode` giữ lại cho run cũ đọc được, nhưng run mới luôn là `engine`.

## Thứ mất đi, nói trước

- **Tốn PTY hơn**: mỗi step đang chạy là một process `claude`. Song song 2 nhánh = 2 process.
- **Chậm hơn một chút mỗi step**: CLI khởi động lại cho mỗi terminal mới (dùng lại terminal của run
  thì không).
- **Gate vẫn do server chạy** chứ không chạy trong terminal — đó là chủ ý: exit code phải do server
  đọc, không qua tay agent. Log lệnh vẫn xem được ở tab Commands.

## File dự kiến chạm

- `server/src/services/session-ledger.ts` — emitter `onTurnClosed`.
- `server/src/services/workflow-runner.ts` — `runAgentStep` chạy qua PTY.
- `server/src/services/terminals.ts`, `server/src/lib/claude-cli.ts` — `--mcp-config`,
  `--permission-mode`.
- `scripts/station-mcp-bridge.mjs` (mới) + `server/src/routes/workflows.ts` (REST cho ask/artifact).
- `web/src/features/workflows/RunView.tsx` — tab terminal theo step; bỏ nút chế độ cũ.

## Cần confirm

1. Chấp nhận **mỗi step đang chạy = một process `claude`** không? (song song 2 nhánh = 2 process)
2. Gate (chạy command, đọc exit code) **giữ ở server** — đồng ý chứ? Cho agent tự chạy test trong
   terminal rồi tự báo là quay lại đúng cái bệnh "nó tự khen".
3. Làm một lượt cả T1→T4, hay làm T1+T3 trước (chạy được, nhìn được, nhưng agent chưa có tool app
   trong terminal) rồi T2 sau?


## Đã impl khác plan ở đâu (2026-09-14)

1. **Cầu MCP không viết lại tool nào.** Plan định bắc cầu từng tool một. Thực tế: `/api/mcp/tools`
   và `/api/mcp/call` lấy thẳng registry của chính `stationMcpServer` (SDK giữ ở `_registeredTools`,
   schema zod đổi sang JSON Schema bằng `z.toJSONSchema`), nên cầu chỉ ~90 dòng và **một** bản cài
   đặt tool phục vụ cả hai bề mặt. Thêm tool cho session SDK là terminal có luôn.
2. **Bridge nhận `runId` chứ không nhận `runStepId`.** Terminal sống lâu hơn một step; truyền step id
   lúc spawn là ghim CLI vào step đầu tiên. Step hiện hành được resolve ở server.
3. **Phải chờ composer, không phải chờ 2.5 giây.** Đây là lỗi thật tìm được khi chạy: CLI hỏi
   *"Is this a project you created or one you trust?"* với mục sáng sẵn là **No, exit**, và cú Enter
   cuối prompt đã bấm đúng vào đó — terminal tự thoát, step treo `running` mãi. Giờ engine đọc
   output gần nhất, chỉ gõ khi thấy dòng composer, và **từ chối trả lời hộp thoại tin cậy thay người**.

## Đã chạy thật (2026-09-14)

Instance cô lập, repo scratch, workflow một step, `autoMode`:

- terminal `claude` mở đúng cho step, có `--mcp-config` + `--strict-mcp-config` + `--permission-mode`
- prompt của step được gõ vào PTY, nhìn thấy từng dòng
- agent đọc file, sửa `README.md`, nói HOÀN TẤT — 8 giây
- ledger đóng turn (2 tool call, 608 token out) → engine thấy và đánh step `done` → run `done`
- `session_files` ghi cả `tool` lẫn `tree` cho `README.md`
