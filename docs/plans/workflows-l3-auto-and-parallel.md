# Plan: Workflows v2 — auto mode, song song, và tự nhận việc (đích: bậc 3)

> Plan con của [`claude-station.md`](claude-station.md). Mọi path tương đối theo `<repo>`.
> Trạng thái: **W0 → W5 impl xong 2026-09-14**. Viết 2026-09-14.
> Đây là **Track C** của [`atlas-parity-roadmap.md`](atlas-parity-roadmap.md) (Workflows v2), không phải Track A/B —
> phần provenance (A3/A4/A5) và hệ sinh thái (B1/B2) cố tình gác lại theo quyết định 2026-09-14.

## Mục tiêu

Đưa **luồng feature** từ bậc 2 lên bậc 3 theo thang trong `data/knowledge/…/agent-team-yeu-cau.md`:
*cả hai luồng chạy được, tự nhận việc từ store và CI.* Luồng fix bug đã ở bậc 3 (jira-ai-fixer tự nhận việc
từ Jira); luồng feature thì vẫn phải có người mở app, chọn workflow, bấm Run, rồi duyệt từng step một.

Bốn thứ phải có, theo đúng thứ tự phụ thuộc:

1. Chạy được **không cần duyệt từng step** (auto mode).
2. Có **máy kiểm** thay chỗ người vừa rời đi — nếu không, auto mode chỉ là bỏ người ra khỏi vòng lặp.
3. Chạy được **song song** và **phân nhánh**, không chỉ tuyến tính.
4. **Tự nhận việc**: requirement trên GitHub → tự chia task → làm → tự cập nhật Jira.

## Hiện trạng (đọc code, không phỏng đoán)

| Thứ | Ở đâu | Trạng thái thật |
|---|---|---|
| Step types | `shared/src/types.ts:661` | `agent` · `command` · `confirm` · `manual`. Không có `gate` |
| Thứ tự chạy | `services/workflow-runner.ts:622` | `findIndex` step chưa xong **đầu tiên** rồi `await` nó → **tuyệt đối tuần tự**, không có `dependsOn` |
| Phân nhánh | `services/workflow-condition.ts` | **Đã có**: `answers.<key> == "x"`, `steps.<key>.failed/done/skipped`. Đủ để viết workflow phân nhánh hôm nay |
| Dừng chờ người | `workflow-runner.ts:688`, `:725` | Ba chỗ: step `confirm`/`manual`, cờ `requiresConfirm` (tự sinh câu hỏi sau khi step xong), và `workflow_ask` do agent gọi |
| Retry | `workflow-runner.ts:751` | `maxRetries` ≤ 3, retry **chính step đó**. Không loop lại được step trước |
| Phục hồi khi fail | `workflow-runner.ts:767` | Step sau khai `steps.<key>.failed` thì run không chết — đây là cách duy nhất hiện có để làm vòng test → fix |
| Import/export | `services/workflows.ts:273`, `:366` | **Có sẵn YAML** (`exportWorkflowYaml` / `importWorkflowYaml` qua `workflowInputSchema`) → workflow mới viết thành file, import vào |
| Jira tools của Claude | `mcp/server.ts:88-134` | `jira_search`, `jira_get_issue`, `jira_list_transitions`, `jira_comment`, `jira_transition`, `jira_worklog`. **Không có create/update issue** |
| GitHub | `services/gh.ts:154`, `:196` | `listIssues`, `issueDetail` đã có → đủ để làm nguồn việc |
| Kết nối | bảng `integrations` | Jira `jira.apero.vn` (deployment `server`, PAT đã lưu) và GitHub repos **đã cấu hình sẵn** |
| Workflow đang có | DB | `impl-fe-workflow`, `impl-ios-workflow` — 5 step, đều `type=agent`, `permissionMode=acceptEdits`, 4/5 step `requiresConfirm=1` |

**Kết luận đo được:** phân nhánh làm được ngay hôm nay; **song song thì không** — phải đổi scheduler.

## Phạm vi

```
W0 auto mode ──┬── W1 gate step (máy kiểm) ──┬── W3 thư viện workflow mẫu
               └── W2 DAG + song song ───────┘        │
                                                      ├── W4 Jira create/update
                                                      └── W5 trigger tự nhận việc → bậc 3
```

### W0 — Auto mode: chạy không cần duyệt

Cờ ở **mức run** (chọn lúc bấm Run), không phải sửa definition:

- `autoMode` bật → bỏ qua gate `requiresConfirm`; step `confirm` tự đi qua, ghi note `auto-approved`.
- Step `manual` **vẫn dừng** — bản chất nó là việc người phải làm tay, tự đi qua là nói dối.
- `workflow_ask` (câu hỏi thật của agent) theo `askPolicy`:
  - `stop` (mặc định) — dừng chờ, đúng "câu hỏi chặn" trong yêu cầu.
  - `assume` — agent tự chọn phương án hợp lý, **ghi giả định vào artifact của run** và chạy tiếp; giả định
    được chèn vào mô tả PR ở step cuối. Đúng "câu hỏi đoán được thì chạy tiếp nhưng ghi giả định vào PR".
- `permissionMode` override mức run (mặc định giữ theo từng step).
- **Ba cái chặn bắt buộc** (yêu cầu mục 4): ngân sách thời gian cho cả run (`deadlineAt`), cap tổng số lần
  retry, và dừng khi hai vòng liên tiếp ra kết quả y hệt (so hash output của step).

Schema: `workflow_runs` thêm `auto_mode`, `ask_policy`, `deadline_at`, `assumptions`.

### W1 — Gate step: "xong" phải do máy trả lời

Step type mới `gate`: chạy một project command, đọc **exit code thật**.

- exit 0 → done.
- khác 0 → quay lại step khai trong `onFail` (ví dụ `impl`), **đưa log lỗi vào làm context**, tối đa `maxLoops`
  vòng (mặc định 3, trần cứng 3 theo yêu cầu).
- Hết vòng mà vẫn đỏ → run dừng, notify, không đi tiếp.

Không có W1 thì auto mode là thả agent chạy mà không ai kiểm — "nó tự khen thì không tính".

### W2 — DAG + song song

- Step thêm `dependsOn: string[]`. Không khai → mặc định phụ thuộc step liền trước (giữ nguyên hành vi cũ,
  không phá 2 workflow đang chạy).
- Scheduler: lấy **tất cả** step sẵn sàng (mọi dependency đã `done`/`skipped`), chạy đồng thời tối đa
  `maxParallel` (mặc định 2). Join = step khai nhiều `dependsOn`.
- **Ràng buộc working tree:** hai step song song chạm cùng repo thì phải ép worktree riêng cho mỗi nhánh,
  hoặc serialize qua repo lock đang có. Mặc định: ép worktree riêng khi có >1 step cùng repo chạy song song.
- Phát hiện cycle lúc lưu definition, không phải lúc chạy.

### W3 — Thư viện workflow mẫu (viết bằng YAML rồi import)

Sáu file trong `docs/workflows/`, import qua đường import sẵn có:

| File | Mô hình | Dùng khi |
|---|---|---|
| `seq-feature-auto.workflow.yaml` | Tuần tự + auto | plan → impl → gate(test) → PR, không dừng giữa chừng |
| `parallel-multi-repo.workflow.yaml` | Fan-out / join | FE + BE + iOS build & test song song rồi gộp một PR set |
| `branch-by-answer.workflow.yaml` | Phân nhánh | hỏi một câu ở đầu → hotfix đi nhánh ngắn, feature đi nhánh đầy đủ |
| `gate-loop-impl-test.workflow.yaml` | Vòng lặp có máy kiểm | implement → test → fix, thoát khi xanh hoặc quá 3 vòng |
| `review-swarm.workflow.yaml` | Song song nhiều góc | 3 agent review (bug · hiệu năng · chuẩn code) chạy song song rồi join thành một báo cáo |
| `github-req-to-jira.workflow.yaml` | Đầu-cuối | requirement GitHub → chia task → làm → PR → cập nhật Jira |

### W4 — Jira: tạo và cập nhật issue

Thêm vào `services/jira.ts` + `mcp/server.ts`: `jira_create_issue` (kèm parent để tạo subtask) và
`jira_update_issue` (summary, description, assignee, labels). Có hai thứ này thì "tự chia task rồi tự cập nhật
Jira" mới làm được thật; hiện chỉ comment và transition được.

Mọi call tạo/sửa ticket **vẫn qua modal duyệt** như các call mutating khác — trừ khi run đang ở auto mode, và
đó là lý do phải chốt câu hỏi ở § Cần confirm.

### W5 — Trigger: tự nhận việc (điều kiện của bậc 3)

Một service nhỏ trong server, cùng kiểu `git-watch`:

- Nguồn 1: GitHub issue có label (ví dụ `ai-feature`) trong các repo đã cấu hình.
- Nguồn 2: Jira JQL (dùng lại kết nối sẵn).
- Thấy việc mới → tạo run ở **auto mode** với goal là nội dung requirement.
- **Guard chống lặp** (bài học từ jira-ai-fixer): lưu khoá `(nguồn, id, updatedAt)` đã xử lý; một việc đang chạy
  thì không nhận lại; không siết JQL/label quá tay đến mức không bao giờ khớp.

## File dự kiến chạm

- `shared/src/types.ts` — `workflowStepTypeSchema` thêm `gate`; step thêm `dependsOn`, `onFail`, `maxLoops`;
  run input thêm `autoMode`, `askPolicy`.
- `server/src/db/schema.ts` + migration — cột mới cho `workflow_steps` và `workflow_runs`.
- `server/src/services/workflow-runner.ts` — phần lớn công nằm ở đây: scheduler song song (W2), gate (W1),
  bỏ gate người khi auto (W0), ba cái chặn.
- `server/src/services/workflows.ts` — validate DAG, export/import `dependsOn`.
- `server/src/services/jira.ts`, `server/src/mcp/server.ts` — W4.
- `server/src/services/workflow-triggers.ts` (mới) + `server/src/index.ts` — W5.
- `web/src/features/workflows/*` — nút Run có lựa chọn auto; run view hiện nhánh song song; badge auto-approved.
- `docs/workflows/*.workflow.yaml` — W3.

## Edge case

- Hai step song song commit cùng repo → phải worktree riêng, nếu không sẽ trộn thay đổi vào một commit.
- Auto mode + `workflow_ask` với `askPolicy=stop` → run đứng im không ai biết: phải notify ra ngoài (Discord/app).
- Gate loop và `maxRetries` chồng nhau → tổng số lần chạy một step phải có trần chung, không nhân lên.
- Trigger nổ chồng: cùng một issue được sửa 3 lần trong 1 phút → chỉ một run.
- Run auto mode lúc server tắt giữa chừng → step dở đánh dấu `interrupted`, **không** tự chạy lại khi boot.
- DAG có cycle, hoặc `dependsOn` trỏ step không tồn tại → chặn ngay lúc lưu.
- Hai run auto cùng project tranh nhau env set và repo lock.

## Đã chốt (2026-09-14)

1. **Phạm vi đợt này: full W0 → W5**, đích là chạm bậc 3.
2. **Quyền của auto mode:** được sửa code, commit, push branch, mở PR, comment/transition Jira.
   **Không merge PR, không đẩy store** — đúng luật "merge thì chưa nới quyền" trong file yêu cầu.
3. **`askPolicy` mặc định `stop`:** agent hỏi thì run dừng đúng step đó **và bắn notify ra ngoài** (app +
   Discord) để nó không đứng im mà không ai biết. `assume` vẫn impl nhưng không phải mặc định.
4. **Jira: tạo subtask + cập nhật.** Thêm `jira_create_issue` (kèm parent) và `jira_update_issue`.
   Project lấy theo ticket cha; issue type subtask dò từ `createmeta`, cho phép override bằng setting —
   không hardcode.
5. **Trigger mặc định TẮT.** Label GitHub / JQL là setting; không cấu hình thì không có gì tự nổ.
6. **`maxParallel` mặc định 2**, và **ép worktree riêng** khi >1 step cùng repo chạy song song.

## Đã impl khác plan ở đâu (2026-09-14)

Ba chỗ đi khác plan ban đầu, sửa plan trước rồi mới sửa code theo đúng luật:

1. **Thêm `cwdLabel` và `isolate` cho step** — plan không có. Không có chúng thì "song song" là nói dối:
   mọi step đều nhận `cwd` của run, nên hai step cạnh nhau luôn trỏ vào cùng một repo và repo lock ở
   `claude-session.ts:353` sẽ chặn con thứ hai — hiện ra như một step hỏng chứ không phải một quyết định
   xếp lịch. `cwdLabel` đẩy step sang repo khác; `isolate` cho step worktree riêng khi bắt buộc phải
   cùng repo (review swarm).
2. **Scheduler tự giữ chỗ theo repo** thay vì để repo lock ném lỗi: mỗi vòng, một repo chỉ được một
   step nhận; step còn lại chờ vòng sau. `maxParallel` là trần của fan-out, không phải giấy phép ghi
   hai lần vào một working tree.
3. **Cái chặn thứ ba của loop** ("hai vòng ra kết quả y hệt thì dừng") làm được thật, không phải bỏ:
   `startCommandRun` đã trả về `tail` của log nên gate so 2000 ký tự cuối giữa hai vòng. Không cần
   đọc lại file log.

Phần logic đồ thị nằm ở `server/src/lib/workflow-graph.ts` — hàm thuần, không chạm DB — nên
"step nào chạy được", "retry thì phải làm lại những gì" test bằng cách hỏi thẳng, không phải bằng cách
chạy một run rồi ngồi nhìn.
