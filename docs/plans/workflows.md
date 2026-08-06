# Plan: Workflows — nhóm asset thứ tư

> Plan con của [`claude-station.md`](claude-station.md). Mọi path tương đối theo `<repo>`.
> Trạng thái: **đã impl xong W1→W5** (2026-08-06). Mỗi step khai `permissionMode` riêng theo quyết định của user.

## Bài toán

Hiện có 3 nhóm asset: **doc/excel**, **skill**, **agent**. Thiếu nhóm thứ tư: **workflow** — trình tự làm việc lặp lại của một loại dự án.

Ví dụ user đưa ra (dự án app iOS):

1. `docs-planner` đọc docs → lên plan impl FE/BE
2. Trong plan có **câu hỏi cần confirm** → user trả lời
3. Update lại project docs nếu cần
4. Impl
5. Auto test

Yêu cầu: có UI thêm được nhiều workflow khác nhau, và **import 1 hoặc nhiều workflow vào project** (giống cách attach asset folder hiện tại).

## Quyết định thiết kế (và lý do)

### 1. Workflow là asset có version + folder, run là instance trong project

Workflow nằm ở library (folder `ios`, `fe`, `be`… dùng chung cơ chế folder của asset), import vào project qua bảng nối `project_workflows`. Mỗi lần chạy tạo một **run** thuộc project.

**Run snapshot định nghĩa workflow vào chính nó** (`workflow_runs.definition` JSON). Lý do: sửa workflow tuần sau không được viết lại lịch sử run tuần trước — nếu run đọc live từ bảng `workflow_steps` thì một run đang dở sẽ đổi hành vi giữa đường, và run đã xong sẽ hiển thị sai những gì thực sự đã chạy.

### 2. Step tái dùng nguyên machinery đang có, không xây engine mới

Đây là điều giữ cho subsystem này nhỏ:

| Step type | Chạy bằng | Được miễn phí |
|---|---|---|
| `agent` | `createChatSession({agentName, kind:'workflow'})` + `sendUserMessage` | stream, persist từng message, resume qua restart, modal duyệt tool, interrupt |
| `command` | `startRun()` của command runner | log ra file, timeout, kill process group, exit code |
| `confirm` | bảng `workflow_questions` + form trên UI | — (mới, nhưng nhỏ) |
| `manual` | checkbox user tự tick | — |

Không có runtime script, không có DSL. Một step `agent` **là** một session — nên user bấm vào step là mở đúng tab hội thoại đó và thấy Claude đang làm gì.

### 3. Câu hỏi confirm đến từ tool, không phải parse markdown

Cách sai: cho agent viết plan rồi regex tìm "Question:". Agent đổi format một chút là vỡ, và không biết câu hỏi nào đã trả lời.

Cách làm: MCP tool **`workflow_ask`**. Agent gọi tool với danh sách câu hỏi có cấu trúc → server ghi `workflow_questions`, đưa run sang `awaiting_input`, **tool call block lại** (đúng như `canUseTool` đang block chờ modal duyệt — hạ tầng pause-chờ-user đã có ở `claude-session.ts:209`). User trả lời trên UI → answers trả về làm tool result → agent tiếp tục với câu trả lời trong context.

```ts
workflow_ask({
  questions: [
    { key: "auth", question: "Login dùng Firebase Auth hay tự ký JWT?",
      kind: "choice", options: ["firebase", "custom-jwt"] },
    { key: "offline", question: "Có cần offline cache cho feed không?", kind: "bool" },
  ],
})
```

Kèm hai tool nữa cho step agent:
- `workflow_emit_artifact({ kind, title, path | content })` — lưu plan.md / report.md thành artifact của run, hiện link trên stepper.
- `workflow_note({ text })` — dòng tiến độ ngắn cho UI, không phải log dài.

Nếu agent **không** gọi `workflow_ask` mà step khai `requiresConfirm: true` → sau khi step xong, engine tự tạo một câu hỏi free-text ("Xem plan rồi xác nhận / ghi chú cần sửa") thay vì đi tiếp im lặng.

### 4. Truyền context giữa các step: artifact path + answers, không nhồi output

Step sau nhận một block ngắn:

```
## Workflow: ios-feature (run #12) — step 3/7 "Update docs"
Đã xong: 1) Read docs, 2) Plan  → artifacts:
- plan: `data/workflows/<runId>/plan.md`
Câu trả lời của user:
- auth = custom-jwt
- offline = false
```

Chỉ path + answers. Nội dung plan để agent tự Read — cùng lý do memory chia pinned/on-demand: nhồi hết output các step trước vào prompt sẽ ăn hết context ở step thứ 4 trở đi.

### 5. Crash-safe: không tự resume ngầm

Boot lên, run đang `running` mà step agent không còn session sống → đánh step `interrupted`, run `awaiting_input`, hiện nút **Resume step / Skip / Cancel run**. Không tự chạy lại: một step có thể đã sửa file hoặc comment Jira, chạy lại mù là nguy hiểm. Đây cũng là cách terminal orphaned đang xử lý.

### 6. Concurrency dùng lại luật hiện có

Run không giữ lock giữa các step. Step nào chạy thì tuân `concurrency.maxTurns` + repo lock như session thường. Hai run cùng project cùng repo → step sau bị queue với message rõ ràng, hoặc bật worktree cho run.

## Schema (delta)

```sql
workflows(id pk, name UNIQUE, description, folder, source /*manual|imported*/,
          created_at, updated_at)
workflow_steps(id pk, workflow_id fk, sort_order, key, type /*agent|command|confirm|manual*/,
               title, agent_name NULL, instruction NULL, command_name NULL,
               requires_confirm, permission_mode NULL, max_retries DEFAULT 0,
               condition NULL /*expr trên answers, v1: "answers.offline == true"*/,
               config JSON NULL)
project_workflows(id pk, project_id fk, workflow_id fk)        -- UNIQUE(project_id, workflow_id)

workflow_runs(id pk, project_id fk, workflow_id fk, title,
              definition JSON /*snapshot toàn bộ step lúc start*/,
              status /*pending|running|awaiting_input|done|failed|cancelled*/,
              current_step_key NULL, cwd, env_set_id NULL, use_worktree,
              started_at, finished_at NULL)
workflow_run_steps(id pk, run_id fk, step_key, status /*pending|running|awaiting_input|
                   done|skipped|failed|interrupted*/, attempt DEFAULT 1,
                   session_id NULL, command_run_id NULL, error NULL,
                   started_at NULL, finished_at NULL)
workflow_questions(id pk, run_id fk, run_step_id fk, key, question,
                   kind /*text|choice|bool*/, options JSON NULL,
                   answer NULL, answered_at NULL)
workflow_artifacts(id pk, run_id fk, run_step_id fk, kind /*plan|doc|report|patch|other*/,
                   title, path, created_at)
```

Sửa bảng cũ: `chat_sessions.kind` thêm giá trị `workflow`; thêm `chat_sessions.workflow_run_step_id NULL` để tab session biết nó thuộc step nào.

Artifact ghi vào `data/workflows/<runId>/`. Xoá run → xoá thư mục.

## API

```
GET    /api/workflows                          ?folder=
POST   /api/workflows                          tạo (kèm steps)
GET    /api/workflows/:id
PATCH  /api/workflows/:id                      sửa meta + full-replace steps
DELETE /api/workflows/:id
PUT    /api/workflows/:id/folder
POST   /api/workflows/import                   multipart .workflow.yaml (hoặc .json)
GET    /api/workflows/:id/export                → .workflow.yaml

GET    /api/projects/:id/workflows             đã import + có thể import
POST   /api/projects/:id/workflows/import      { workflowIds[] | folder }   ← import 1 hoặc nhiều
DELETE /api/projects/:id/workflows/:workflowId

POST   /api/projects/:id/workflow-runs         { workflowId, cwdPathId?, envSetId?, useWorktree?, inputs? }
GET    /api/projects/:id/workflow-runs         ?status=
GET    /api/workflow-runs/:id                  run + steps + questions + artifacts
POST   /api/workflow-runs/:id/answer           { answers: {key: value} }  → mở lại step
POST   /api/workflow-runs/:id/advance          chạy step kế (idempotent theo step_key)
POST   /api/workflow-runs/:id/steps/:key/retry
POST   /api/workflow-runs/:id/steps/:key/skip
POST   /api/workflow-runs/:id/cancel
WS     /ws/workflow-run/:id                    status/step/question/artifact events
```

## Engine

`server/src/services/workflow-runner.ts` — một orchestrator nhỏ, **không** phải cron/queue:

```
advance(runId):
  step = next pending step theo sort_order, bỏ qua step có condition false
  nếu hết step → run.status = done
  theo step.type:
    agent   → tạo session (kind=workflow, agentName, permissionMode của step)
              sendUserMessage(instruction + workflow context block)
              chờ result → nếu is_error và attempt < max_retries → retry
    command → startRun(commandName) → chờ done → exit != 0 và còn retry → retry
    confirm → tạo question (nếu step trước chưa tạo qua workflow_ask) → awaiting_input
    manual  → awaiting_input (chờ user tick)
  ghi run_step, phát WS, gọi advance tiếp (trừ khi awaiting_input)
```

Tool `workflow_ask` được thêm vào MCP server **chỉ khi session thuộc một run** (`stationMcpServer` nhận thêm `workflowRunStepId`) — session chat thường không thấy tool này, tránh Claude gọi lung tung.

## UI

**`/workflows`** — library, cùng ngôn ngữ với Agents/Knowledge:
- chip folder + đếm, import/export `.workflow.yaml`
- editor: danh sách step dạng card kéo thả thứ tự; mỗi card chọn `type`, agent (dropdown từ agents đã có), command (dropdown từ path_commands của project khi run), instruction (textarea), toggle `requiresConfirm`, `maxRetries`, `condition`
- preset **ios-feature** (mục 1 của user) + **fe-feature**, **bugfix-from-jira**

**Project → tab Workflows**:
- danh sách workflow đã import + nút **Import from library** (chọn nhiều, hoặc cả folder — giống AttachFromLibrary)
- nút **Run** → dialog chọn path/env/worktree → tạo run → mở run view

**Run view (stepper dọc)** — mỗi step một dòng:
- trạng thái (pending/running amber pulse/done emerald/failed rose/skipped/awaiting amber)
- step agent: link "mở session" → nhảy sang tab session đó (tái dùng `AgentWorkspace`)
- step command: link tới log (`LogPane`)
- artifact: chip tải về / mở
- `awaiting_input`: **form câu hỏi ngay tại chỗ** (text/choice/bool), nút Submit → `advance`
- nút per-step: Retry / Skip; nút run: Cancel

Run list hiện trong tab Workflows với progress `3/7`.

## Preset `ios-feature` (đúng flow user mô tả)

| # | key | type | agent/command | ghi chú |
|---|---|---|---|---|
| 1 | `read-docs` | agent | `docs-planner` | đọc docs trong knowledge + repo, tools read-only + `knowledge_search`, `memory_get` |
| 2 | `plan` | agent | `docs-planner` | viết `plan.md` qua `workflow_emit_artifact`, hỏi qua `workflow_ask`; `requiresConfirm: true` |
| 3 | `confirm-plan` | confirm | — | form câu hỏi từ step 2 |
| 4 | `update-docs` | agent | `docs-writer` | cập nhật project docs/memory theo answers (`memory_write`, Write vào knowledge) |
| 5 | `impl-be` | agent | `impl` | `condition: answers.scope != "fe-only"` |
| 6 | `impl-fe` | agent | `impl` | |
| 7 | `test` | command | `Test` | `maxRetries: 1` |
| 8 | `fix-tests` | agent | `build-fixer` | `condition: steps.test.failed` |
| 9 | `review` | agent | `reviewer` | read-only |
| 10 | `report` | agent | `jira-scribe` | comment Jira + `workflow_emit_artifact` report |

Agent `docs-planner`, `docs-writer`, `impl` là preset mới cần thêm ở trang Agents (đã có `build-fixer`, `reviewer`, `jira-scribe`).

## Milestones

| # | Nội dung | Testable |
|---|---|---|
| W1 | Schema + migration, CRUD workflow/steps, import/export yaml, `project_workflows` | Tạo workflow 3 step qua API, import vào project, export ra file rồi import lại giống hệt |
| W2 | Engine: advance/agent/command step, run + run_steps, WS event, snapshot definition | Run workflow 2 step (agent → command), restart server giữa đường → step thành `interrupted`, resume được |
| W3 | `workflow_ask` + questions + answer API, step `confirm`, context block | Agent hỏi 2 câu → run `awaiting_input` → trả lời trên API → agent nhận đúng answers và tiếp tục |
| W4 | UI: library + editor kéo thả, project tab + import nhiều, run view stepper + form câu hỏi | Chạy `ios-feature` end-to-end trên repo thật, confirm giữa đường, artifact tải được |
| W5 | condition/retry, preset ios-feature + 2 preset khác, agent preset mới, artifact cleanup | Step có condition bị skip đúng; test fail → `fix-tests` chạy; xoá run là sạch thư mục |

## Risks

- **Agent phớt lờ `workflow_ask`** → step `requiresConfirm` tự sinh câu hỏi free-text; description tool viết rõ "gọi trước khi kết thúc nếu có điều chưa chắc".
- **Run treo vì step agent chờ duyệt tool mà user đóng tab** → policy `canUseTool` hiện tại (deny khi không có UI) áp luôn: step fail rõ ràng thay vì treo. Cân nhắc cho step khai `permissionMode: acceptEdits` để chạy dài không cần ngồi canh.
- **Workflow sửa giữa run** → snapshot đã chặn; UI hiện badge "definition v.snapshot" nếu workflow đã đổi.
- **Vòng lặp retry vô hạn** → `maxRetries` mặc định 0, cap 3; `fix-tests → test` chỉ quay lại đúng 1 lần.
- **Artifact phình** → artifact là file trong `data/workflows/<runId>/`, prompt chỉ nhận path; xoá run xoá thư mục.
- **`condition` thành mini-language** → v1 chỉ cho phép 3 dạng: `answers.<key> == "value"`, `answers.<key> == true/false`, `steps.<key>.failed`. Không eval JS.

## Phát sinh khi impl (khác/bổ sung so với thiết kế)

1. **`workflow_ask` bị `canUseTool` từ chối.** Policy "không có UI attach → deny" (đúng cho Write/Bash) giết luôn chính cơ chế xin ý kiến: step chạy headless, câu hỏi hiện ở **run view** chứ không ở tab session, nên không có listener nào để duyệt. Kết quả ban đầu: agent gọi `workflow_ask` → tool trả `is_error: No UI attached` → agent đi tiếp → run "done" mà không hỏi gì. Fix: tool `mcp__station__workflow_*` **luôn allow** trong `requestPermission` (chúng không chạm file/service ngoài; `workflow_ask` *là* kênh consent). Tool khác trong session workflow không có UI vẫn deny, nhưng message giờ nói rõ cách sửa: đặt step sang `acceptEdits`.
2. **Crash recovery bỏ sót run `awaiting_input`.** Reconcile ban đầu chỉ quét run `running|pending`, nhưng run đang park ở `workflow_ask` có status `awaiting_input` với step `running` — restart xong thì promise đã chết, trả lời câu hỏi không resolve được gì → treo vĩnh viễn. Fix: quét mọi run chưa terminal; step `running` **hoặc** `awaiting_input` mà có `sessionId` (tức đang park trong tool) → `interrupted`. Gate `confirm`/`manual` không có session nên vẫn chờ bình thường.
3. **`interrupted` phải chặn run.** Bộ tìm step kế ban đầu chỉ nhận `pending|awaiting_input`, nên step `interrupted` bị nhảy qua âm thầm. Giờ `interrupted` cũng tính là chưa xong, và `advance` dừng tại đó chờ Retry/Skip.
4. **Retry step `interrupted` phải xoá câu hỏi treo + mở session mới.** Không xoá thì turn mới gọi `workflow_ask` sẽ nằm sau câu hỏi chết và park ngay; không mở session mới thì resume vào một session không còn sống.
5. **`workflow_ask` chạy trong lúc `sendUserMessage` đang await** → runner tự nhiên có luôn cơ chế park/resume, không cần state machine riêng: answer resolve promise → turn tiếp → `sendUserMessage` return → vòng `advanceRun` đi tiếp. Cờ `advancing` chặn double-POST `/advance` chạy trùng step.
6. **Step type `command` khớp theo tên**, không theo id — vì workflow là asset dùng chung nhiều project, mà `path_commands.id` là của riêng từng project. Không tìm thấy tên thì step fail với message chỉ đúng chỗ thêm command.

## Ngoài scope v1

Step song song, workflow lồng workflow, schedule/cron, template biến trong instruction ngoài answers/artifacts, chia sẻ run cho người khác.
