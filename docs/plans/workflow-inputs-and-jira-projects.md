# Plan: Workflow nhận input — link docs, Jira project, và `@` tag

> Plan con của [`claude-station.md`](claude-station.md), nối tiếp
> [`workflows-l3-auto-and-parallel.md`](workflows-l3-auto-and-parallel.md) (W0→W5 đã xong).
> Mọi path tương đối theo `<repo>`. Trạng thái: **V1 → V6 impl xong 2026-09-14**. Viết 2026-09-14.

## Mục tiêu

Một câu của người dùng: *"chỉ định 1 docs trong spec repo GitHub, agent tự tạo task, kéo task, impl,
mở PR"*. Hôm nay muốn làm thế phải sửa `instruction` của workflow mỗi lần chạy cho một tài liệu khác —
tức là workflow không phải asset dùng lại được, mà là bản nháp phải viết lại.

Ba thứ phải có:

1. Workflow **khai báo input** (link docs, Jira project, ticket…), người nhập lúc Start run; step nội suy
   `{{key}}` vào instruction. Chạy tài liệu khác = điền ô khác, không sửa definition.
2. **Chọn được Jira project** — hôm nay app không biết có những project nào; agent phải đoán project key
   từ ticket cha, mà không có ticket cha thì không tạo nổi task.
3. **`@` tag** trong ô Goal (và ô instruction): gõ `@` ra danh sách Jira project / ticket / repo / file docs,
   chọn xong app **tự nạp nội dung** vào ngữ cảnh step — thay vì agent phải tự đi mò.

## Hiện trạng (đọc code)

| Thứ | Ở đâu | Trạng thái |
|---|---|---|
| Đọc file trong repo GitHub | `services/gh.ts:611` `getContents(repo, path, ref)` | **Đã có**, trả text đã giải base64, cắt theo `MAX_FILE_TEXT`, dùng `gh` login nên private repo vẫn đọc được — **không cần clone repo spec** |
| Repo đã cấu hình | `githubConfig().repos` | Đã có, dạng `owner/repo` |
| Jira project | `jiraConfigSchema` (`shared/src/types.ts:1309`) | **Không có** — chỉ baseUrl/email/token. Không có API list project |
| Tạo/sửa ticket | `jira_create_issue`, `jira_update_issue` | Vừa thêm ở W4 |
| Biến trong step | — | **Không có**. `stepContext()` ghép chuỗi tĩnh; không nội suy gì |
| Goal của run | `workflow_runs.goal`, mọi step đều thấy | Đã có — chỗ để nhét nội dung đã resolve |
| Trigger điền goal | `services/workflow-triggers.ts` | Đã có; sẽ điền luôn input khi có |

## Phạm vi

### V1 — Workflow khai báo input

`workflows` thêm bảng `workflow_inputs` (hoặc cột JSON trên workflow — chốt: **bảng riêng**, vì còn phải
sắp thứ tự và validate từng cái):

```
key · label · type · required · default · help
type: text | choice | docs | jira-project | jira-ticket | repo | path
```

- Start-run dialog sinh một ô cho mỗi input, đúng kiểu: `jira-project` là dropdown, `docs` là ô dán link
  kèm nút xem trước, `path` là dropdown path của project.
- `workflow_runs` lưu `inputs` (JSON) — snapshot như `definition`, để run cũ đọc lại được.
- Nội suy `{{key}}` trong `instruction` của step và trong `goal`. Không có key → để nguyên và ghi cảnh báo
  vào note của step, **không** im lặng thay bằng rỗng.

### V2 — Jira project

- `jiraConfigSchema` thêm `projects: string[]` (key đã ghim) — cùng hình dạng `githubConfig.repos`.
- `services/jira.ts` thêm `listProjects()`: Cloud `/project/search`, Server/DC `/project`. Trang Settings →
  Integrations hiện danh sách live, tick cái nào dùng thì ghim.
- MCP thêm `jira_list_projects` để agent tự tra khi cần.
- Input kiểu `jira-project` đọc danh sách đã ghim; ghim rỗng thì rơi về danh sách live.

### V3 — `@` tag

Ô Goal (Start run) và ô Instruction (editor) gõ `@` mở picker bốn nhóm:

| Gõ | Chọn ra | Token chèn vào |
|---|---|---|
| `@` rồi tên project | Jira project | `@jira:IIP707` |
| `@` rồi mã ticket | Jira ticket | `@ticket:IIP707-123` |
| `@` rồi tên repo | GitHub repo | `@repo:owner/name` |
| `@` rồi đường dẫn | File trong repo đã cấu hình | `@doc:owner/name:docs/spec.md` |

**Token được resolve ở server, trước khi step nhận ngữ cảnh** — đây là phần có giá trị, không phải cái
picker: `@doc:` được đọc bằng `getContents` và nội dung nhét thẳng vào ngữ cảnh (cắt theo cap, ghi rõ đã
cắt); `@ticket:` nhét `issueContext(key)`; `@jira:` nhét key + tên project để `jira_create_issue` dùng
ngay. Agent không phải đoán, và không tốn một lượt chỉ để đi lấy tài liệu.

Cap tổng cho phần resolve (đề xuất 60KB) — một spec dài không được đẩy mọi thứ khác ra khỏi context.

### V4 — Agent mới

Hai con, viết thành `.agent.md` trong `docs/agents/` để import lại được ở máy khác:

- **`jira-pm`** — con lo phần Jira: đọc plan, chia task, tạo issue/subtask, kéo trạng thái, comment
  ngược lại. Tách riêng vì nó cần bộ tool hẹp (`jira_*`, đọc file) và **không được sửa code** — trộn vào
  con dev thì sớm muộn nó "tiện tay" sửa code trong lúc cập nhật ticket.
- **`spec-reader`** — đọc tài liệu spec (đã được `@doc:` nạp sẵn), đối chiếu docs BE/code, trả về plan +
  danh sách câu hỏi chia hai loại chặn/đoán-được. Read-only trên code.

### V5 — Sửa `impl-fe-workflow` và `impl-ios-workflow` cho ăn Jira

Hai workflow đang chạy thật, hiện **tuần tự thuần và không biết Jira**. Sửa tại chỗ (export bản cũ ra
`docs/workflows/` trước khi đụng vào, để quay lại được):

- Thêm input `docs` + `jira-project` + `jira-ticket` (tuỳ chọn).
- Chèn step `jira-tasks` (agent `jira-pm`) sau bước plan: tạo task/subtask từ plan.
- Bước impl kéo ticket sang In Progress; bước PR comment link PR và kéo trạng thái.
- Đổi step test thành `gate` để vòng test→fix do scheduler điều khiển.
- Giữ nguyên `requiresConfirm` như cũ — ai muốn chạy thẳng thì bật *Run unattended*.

### V6 — Thư viện mô hình workflow, kèm "dùng khi nào"

Hôm nay mới có tuần tự. Bổ sung cho đủ các mô hình phổ biến, mỗi cái một file YAML **và một dòng nói rõ
dùng khi nào** — vì cái đắt nhất không phải viết workflow, mà là chọn nhầm hình dạng cho loại việc:

| Mô hình | File | Dùng khi |
|---|---|---|
| Prompt chaining (tuần tự) | `seq-feature-auto` (đã có) | Việc có thứ tự cứng, bước sau cần kết quả bước trước |
| Routing (phân nhánh) | `branch-by-answer` (đã có) | Đầu vào có vài loại rõ rệt, mỗi loại một đường; làm một prompt chung thì loại nào cũng làm dở |
| Parallel — sectioning | `parallel-multi-repo` (đã có) | Việc chia được thành phần độc lập: 3 repo, 3 màn hình. Rút thời gian thật |
| Parallel — voting | `voting-review` (mới) | Việc mà bỏ sót đắt hơn chạy thừa: soát bảo mật, soát regression. Chạy N lần rồi lấy đồng thuận |
| Orchestrator–workers | `orchestrator-tasks` (mới) | Không biết trước có bao nhiêu việc con — một con điều phối đọc spec rồi phát việc |
| Evaluator–optimizer | `gate-loop-impl-test` (đã có), `draft-critique-revise` (mới) | Có tiêu chí chấm rõ ràng và bản đầu hiếm khi đạt: test, hoặc một con chấm bài con kia |
| Human-in-the-loop | `spec-doc-to-tasks` (mới) | Bước sau tốn kém hoặc khó lùi — dừng cho người xem trước khi đi tiếp |

Cộng với `spec-doc-to-delivery` (đầu-cuối, đúng yêu cầu chính) và `ticket-to-pr`.

## File dự kiến chạm

- `shared/src/types.ts` — `workflowInputDefSchema`, workflow/run/trigger mang `inputs`, `jiraConfig.projects`.
- `server/src/db/schema.ts` + migration 0019 — `workflow_inputs`, `workflow_runs.inputs`.
- `server/src/services/workflows.ts` — CRUD input, export/import YAML.
- `server/src/services/workflow-runner.ts` — nội suy `{{key}}`, resolve token `@…` vào `stepContext`.
- `server/src/services/mentions.ts` (mới) — parse và resolve token; dùng chung cho goal, instruction, trigger.
- `server/src/services/jira.ts` + `routes/integrations.ts` — `listProjects`, ghim project.
- `server/src/mcp/server.ts` — `jira_list_projects`.
- `web/` — ô input trong Start-run dialog, editor input, `@` picker (component dùng lại được), Integrations.
- `docs/workflows/*.yaml` — 5 workflow mới.

## Edge case

- Link docs dạng `blob/` có `#L12-L30`, có `?plain=1`, hoặc trỏ vào thư mục → parse ra `repo/path/ref` cho đúng.
- File docs private, hoặc `gh` chưa login → báo đúng lý do, không để agent tự đi mò.
- Docs 2MB → cắt, và **nói rõ đã cắt** ở đầu phần chèn.
- `@ticket:` trỏ ticket không tồn tại / khác project đã chọn.
- Input `required` bỏ trống → chặn ở Start, không để run chết ở step 2.
- Trigger điền input tự động: thiếu input required thì trigger báo lỗi thay vì mở run hỏng.
- Nội suy `{{key}}` trong instruction của workflow import từ YAML cũ (không có input) → giữ nguyên chữ.

## Đã chốt (2026-09-14)

1. **Jira project**: kéo danh sách live từ Jira, ghim ở Settings → Integrations, workflow chọn trong list đã ghim.
2. **`@` tag**: dùng ở ô Goal *và* ô instruction của step — tag một lần trong workflow thì mọi run đều có.
3. **Docs**: đọc qua `gh api` từ link GitHub, không cần clone repo spec.
4. **Workflow**: `spec-doc-to-delivery` trước; đồng thời **sửa `impl-fe-workflow` và `impl-ios-workflow`**
   cho ăn Jira, và bổ sung các mô hình còn thiếu ở § V6.


## Đã impl khác plan ở đâu (2026-09-14)

1. **Key của input cho phép camelCase** (`{{jiraProject}}`), không bắt kebab như plan viết. Người ta gõ
   biến template theo kiểu camelCase, bắt kebab chỉ tạo ra lỗi validate lúc import.
2. **`cwdLabel` của step cũng được nội suy** — không có nó thì input "repo nào" vô dụng: step vẫn
   dính vào label viết cứng trong định nghĩa.
3. **Không đổi step test của `impl-fe-workflow` / `impl-ios-workflow` sang `gate`.** Gate cần một
   project command có thật; đổi mà project chưa khai command đó thì run hỏng giữa chừng — mà đây là
   hai workflow đang chạy thật. Hai step Jira thêm vào thì tự bỏ qua khi run không điền Jira, nên
   hành vi cũ giữ nguyên.
4. **Chưa cập nhật hai workflow đó trong DB đang chạy.** Server đang chạy là bản code cũ, chưa có cột
   `inputs`; cập nhật lúc này sẽ im lặng mất phần inputs. Sau khi restart server (migration 0019 tự
   chạy) thì import lại từ `docs/workflows/`.
