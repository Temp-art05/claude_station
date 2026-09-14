# Plan: Gom workflow còn 7, chia 7 nhóm, và tạo ticket vào sprint

> Nối tiếp [`workflow-inputs-and-jira-projects.md`](workflow-inputs-and-jira-projects.md).
> Mọi path tương đối theo `<repo>`. Trạng thái: **chưa impl**. Viết 2026-09-14.

## Vấn đề

14 workflow là quá nhiều, và phần lớn khác nhau ở **hình dạng** chứ không ở **việc**. Người dùng mở
danh sách ra phải chọn giữa `review-swarm`, `voting-review`, `draft-critique-revise` — ba cái đều là
"soát lại", không cái nào là một việc trong ngày. Còn việc thật thì chỉ có vài loại: làm feature FE,
làm feature iOS, có khi kèm BE, chia task từ spec, và fix bug.

Ba thứ phải sửa:

1. **Gom lại theo việc, không theo mô hình.** Review không phải một workflow — nó là một **step** nằm
   trong workflow làm feature.
2. **Tạo ticket phải vào được sprint**, chọn sprint đang có hoặc tạo sprint mới. Hôm nay `jira_create_issue`
   tạo ticket rơi vào backlog, và không có cách nào đẩy nó vào sprint.
3. **Tạo task phải biết cái gì đã có.** Chạy lại workflow trên cùng một spec hiện sẽ tạo lại y nguyên
   bộ ticket — một lần chạy nhầm là board đầy ticket trùng, và dọn tay.

## Nhóm (folder)

Bảy nhóm, đúng như đã chốt: `ios` · `ios-be` · `fe` · `fe-be` · `jira` · `fixbug` · `other`.

## Workflow giữ lại

| Nhóm | Workflow | Việc |
|---|---|---|
| `jira` | `specs-to-jira` | **Một hoặc nhiều** spec GitHub → chia task → tạo ticket vào sprint (chọn hoặc tạo mới). Không đụng code |
| `fe` | `impl-fe-workflow` | Của team, giữ nguyên tinh thần + input spec + Jira + review gộp vào |
| `fe-be` | `impl-fe-be-workflow` | Như trên, FE và BE chạy song song, mỗi bên một repo |
| `ios` | `impl-ios-workflow` | Của team, giữ nguyên + input spec + Jira + review gộp vào |
| `ios-be` | `impl-ios-be-workflow` | iOS và BE song song |
| `fixbug` | `bugfix-workflow` | Bug/ticket → nguyên nhân → sửa + test chống tái phát → PR → cập nhật ticket |
| `other` | `bulk-change-workflow` | Nhiều việc con cùng loại, không biết trước bao nhiêu (orchestrator) |

**Bỏ** (hình dạng của chúng đã nằm trong 7 cái trên dưới dạng step): `seq-feature-auto`,
`parallel-multi-repo`, `branch-by-answer`, `gate-loop-impl-test`, `review-swarm`, `voting-review`,
`draft-critique-revise`, `spec-doc-to-delivery`, `spec-doc-to-tasks`, `ticket-to-pr`,
`github-req-to-jira`, `orchestrator-tasks` (đổi tên thành `bulk-change-workflow`).

Review gộp vào đâu: mỗi workflow impl có một step `review` **trước** step PR — một agent khác đọc lại
diff theo checklist (lỗi · hiệu năng · chuẩn repo) và trả về danh sách phải sửa; sửa xong mới mở PR.
Không phải workflow riêng nữa.

## Sprint

`services/jira.ts` thêm bốn hàm, dùng Agile API (`/rest/agile/1.0`, chung cho Cloud và Server/DC):

- `listBoards(projectKey)` — board của project (sprint treo ở board, không treo ở project).
- `listSprints(boardId)` — sprint `active` + `future`; sprint đã đóng không phải chỗ để thêm việc.
- `createSprint(boardId, name)` — tạo sprint mới.
- `addIssuesToSprint(sprintId, keys)` — đẩy ticket vừa tạo vào sprint.

MCP: `jira_list_sprints`, `jira_create_sprint`, `jira_add_to_sprint`. Route cho picker:
`GET /api/jira/sprints?projectKey=`.

Input type mới `jira-sprint`: dropdown sprint đang mở của project đã chọn, cộng một ô "tạo sprint mới"
— giá trị gửi lên là tên sprint, và `jira-pm` tự quyết dùng lại hay tạo.

## Chống tạo trùng

Luật đặt vào `jira-pm` (agent) chứ không vào từng workflow, để một chỗ duy nhất:

> Trước khi tạo bất kỳ ticket nào, `jira_search` trong project (và dưới ticket cha nếu có) để lấy
> danh sách ticket đang có. Một task coi là **đã có** khi tiêu đề nói cùng một việc — không cần
> giống từng chữ. Task đã có thì **không tạo lại**: ghi vào bảng task là "đã có: KEY" và đi tiếp.
> Cuối step báo rõ: tạo mới mấy cái, dùng lại mấy cái.

## File dự kiến chạm

- `shared/src/types.ts` — `workflowInputTypeSchema` thêm `jira-sprint`.
- `server/src/services/jira.ts` — bốn hàm Agile API.
- `server/src/routes/integrations.ts` — route sprint.
- `server/src/mcp/server.ts` — ba tool sprint.
- `web/src/features/workflows/WorkflowsTab.tsx` — widget `jira-sprint`.
- `docs/agents/jira-pm.agent.md` — luật chống trùng + sprint.
- `docs/workflows/` — xoá 11 file, viết/sửa 7 file, viết lại README.

## Edge case

- Project không có board (không dùng Scrum) → không có sprint: nói rõ và tạo ticket vào backlog.
- Nhiều board cho một project → lấy board scrum đầu tiên, và nói rõ đã chọn board nào.
- Sprint trùng tên → dùng lại cái đang active thay vì tạo cái thứ hai.
- Ticket đã nằm trong sprint khác → không tự chuyển.
- Agile API tắt trên Jira Server → báo đúng lý do, đừng để agent đoán là không có sprint nào.
