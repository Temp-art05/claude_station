# Thư viện workflow — bảy nhóm, mỗi nhóm một workflow (nhóm `ios` có hai)

Import cả thư mục ở **Workflows → Import folder**, hoặc từng file.

Trước đây ở đây có mười bốn workflow, phần lớn khác nhau ở **hình dạng** (song song, bỏ phiếu, vòng
lặp) chứ không ở **việc**. Mở ra phải chọn giữa ba cái đều tên là "review" thì không ai chọn được.
Giờ chia theo việc: mỗi nhóm một workflow, và những hình dạng kia nằm bên trong nó dưới dạng step.

| Nhóm     | Workflow               | Việc                                                                                                                                    |
| -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `jira`   | `specs-to-jira`        | **Một hoặc nhiều** spec GitHub → chia task → tạo ticket vào sprint. Không đụng code                                                     |
| `fe`     | `impl-fe-workflow`     | Feature FE: plan → task Jira → impl → test → review → PR                                                                                |
| `fe-be`  | `fe-be-spec-to-pr`     | Như trên, FE và BE **chạy song song**, mỗi bên một repo                                                                                 |
| `ios`    | `impl-ios-workflow`    | Feature iOS: như `fe` nhưng theo chuẩn Clean Architecture + MVVM                                                                        |
| `ios`    | `impl-ios-ui-workflow` | **Dựng UI** iOS bám Figma: đọc design qua Figma MCP → impl → mở thẳng màn đó trên simulator, chụp, so với design, sửa tới khi khớp → PR |
| `ios-be` | `ios-be-spec-to-pr`    | iOS và BE song song                                                                                                                     |
| `fixbug` | `bugfix-workflow`      | Bug → **nguyên nhân gốc** → sửa + test chống tái phát → PR                                                                              |
| `other`  | `bulk-change-workflow` | Nhiều việc con cùng loại, không biết trước bao nhiêu                                                                                    |

Bốn workflow nhóm feature (fe · fe-be · ios · ios-be) gần như giống nhau — cùng một việc, khác repo
nào và có chạy song song hay không. Để riêng từng cái là cố ý: mở nhóm của mình ra là chạy được
ngay, không phải điền "làm ở đâu" mỗi lần.

`impl-ios-ui-workflow` là ngoại lệ duy nhất của luật "mỗi nhóm một workflow", và vì một lý do cụ
thể: nó không kết thúc bằng _đã impl xong_, mà bằng _đã giống design_. Nghiệm thu của nó là một tấm
ảnh chụp màn thật đặt cạnh ảnh Figma, nên nó có một vòng lặp mà `impl-ios-workflow` không có, và một
người chấm riêng cho vòng lặp đó. Nhét cả hai vào một workflow thì mọi task iOS đều phải đi qua
vòng so ảnh, kể cả task không đụng một pixel nào.

## Model rẻ cho vòng lặp — `model` ở cấp step

Một step khai được `model` riêng (`sonnet`, `haiku`, …); bỏ trống thì dùng model mặc định của máy.
Nó nằm ở cấp **step** chứ không phải cấp run vì chi phí của một workflow không trải đều: step viết
code chạy một lần, còn vòng build–chụp–so–chấm chạy bao nhiêu lần tuỳ design. `impl-ios-ui-workflow`
dùng nó cho đúng hai step của vòng lặp đó.

## Figma MCP trong một step

Step chạy với `--strict-mcp-config`, tức nó chỉ thấy đúng những gì mcp.json của run khai. Từ nay
mcp.json đó gồm cả các MCP server khai ở user scope trong `~/.claude.json` — đó là đường duy nhất để
một step dựng UI nói chuyện được với Figma. `station` luôn thắng khi trùng tên: tool của workflow
không phải thứ một server cài trên máy được ghi đè.

## Review không còn là workflow riêng

Nó là hai step ngay trước PR: `review` do **một agent khác** (`spec-reader`) đọc lại diff theo ba
nhóm — lỗi đúng/sai, hiệu năng, chuẩn repo — rồi `fix-review` sửa theo danh sách đó.

Lý do phải là agent khác: con vừa viết code chấm chính nó thì gần như lần nào cũng "đạt". Đó là cùng
một lý do `gate` tồn tại — một cái kiểm mà người bị kiểm tự chấm thì không phải là kiểm.

## Không tạo ticket trùng

Luật nằm ở agent `jira-pm`, một chỗ duy nhất, nên mọi workflow đều theo: **tra ticket đang mở trước
khi tạo**. Task nào đã có (tiêu đề nói cùng một việc, không cần giống từng chữ) thì dùng lại và ghi
`đã có: KEY`. Cuối step báo bằng số: tạo mới mấy cái, dùng lại mấy cái.

Nghĩa là chạy lại workflow trên cùng một spec **không** làm board đầy ticket trùng — chuyện chỉ phát
hiện ra sau khi đã phải dọn tay một lần.

## Sprint

Input kiểu `jira-sprint` liệt kê sprint đang mở của project đã chọn; gõ tên chưa có thì `jira-pm` tạo
sprint mới rồi đẩy ticket vào. Sprint đã đóng không được liệt kê — đó không phải chỗ để thêm việc.
Project không có scrum board thì ticket nằm ở backlog, và step nói rõ điều đó thay vì im lặng.

## Hình dạng của một workflow impl

`impl-ios-workflow` là bản mẫu, ba nhóm impl kia sao theo:

```
plan
 ├─ jira-tasks   (readOnly)       ┐
 └─ confirm-plan                  ┘ → impl → test → review (readOnly) → fix-review
                                                                          ├─ pr
                                                                          └─ jira-report (readOnly)
```

Hai chỗ rẽ nhánh, và cả hai đều là việc thật sự không chờ nhau: chia task trên Jira không cần biết
plan đã được duyệt chưa, và tổng kết lên ticket cha không cần link PR.

**`readOnly: true` là thứ khiến nhánh song song thành thật.** Hai step không bao giờ dùng chung một
working tree; thiếu cờ này thì step Jira vẫn phải đợi cả một lượt để lấy một thư mục nó không hề
chạm vào — song song trên giấy, nối tiếp trên thực tế.

**Trạng thái Jira đi theo công việc, không dồn về cuối:**

| Lúc nào                               | Ai làm                 | Trạng thái                   |
| ------------------------------------- | ---------------------- | ---------------------------- |
| Trước dòng code đầu tiên của một task | step impl              | **In Progress**              |
| Task đó xong và đã kiểm               | step impl              | **Resolved**                 |
| PR đã mở                              | step pr (nó biết link) | **Reviewing** + comment link |
| Merge                                 | **người**              | Done                         |

Bảng chỉ đúng ở phút cuối là bảng không ai tin được lúc đang chạy.

## Step tự bỏ qua khi không có việc

Điều kiện của step đọc được cả input, nên step nào không có gì để làm thì **bị skip, không chạy**:

```yaml
condition: inputs.jiraProject || inputs.jiraTicket
```

Đây là lý do có nó: run không điền Jira thì hai step `jira-tasks` và `jira-report` trước đây vẫn mở
terminal, khởi động CLI, và tốn vài phút chỉ để nói "run này không gắn Jira". Giờ chúng hiện `skipped`
ngay lập tức.

Ngôn ngữ điều kiện vẫn cố tình nhỏ — bốn dạng và đúng một toán tử `||`:

| Dạng                                        | Ý nghĩa                                |
| ------------------------------------------- | -------------------------------------- |
| `inputs.<key>`                              | ô đó có được điền không                |
| `inputs.<key> == "x"`                       | điền đúng giá trị đó                   |
| `answers.<key> == "x"`                      | câu trả lời của bạn cho `workflow_ask` |
| `steps.<key>.failed` / `.done` / `.skipped` | trạng thái step khác                   |

`||` có vì nhu cầu thật: step Jira cần **hoặc** project **hoặc** ticket cha. Không có `&&` — cần
"và" thì tách thành hai step, hoặc để chính agent quyết.

## Retry / Skip / Restart trong lúc step đang chạy

Một turn sống trong `await` hàng chục phút. Retry, Skip, Restart, Cancel đều viết lại hàng của step
trong khoảng đó, nên engine phải biết **kết quả trả về là của lần chạy nào**.

Mỗi lần dispatch nhận một số `generation` (cột `workflow_run_steps.generation`, migration `0024`).
`settleStep` chỉ ghi kết quả khi số đó còn khớp; lệch thì kết quả bị **loại**, và run view hiện
"Bỏ kết quả cũ của step ...". `attempt` không làm được việc này: `restartRun` đặt nó về 1, trùng
đúng cái attempt 1 có thể đang chạy dở.

Không có guard này thì: bấm Retry → turn cũ về đích → step bị đánh `done` → engine thấy dependency
đã settle và chạy tiếp các step sau, còn lần retry thì không bao giờ chạy. Nhìn từ ngoài đúng như
"workflow tự nhảy cóc qua step".

Kèm theo đó:

- **Skip một step đang chạy sẽ interrupt turn của nó**, giống `cancelRun`, chứ không chỉ đổi nhãn.
  Đổi nhãn suông để agent tiếp tục sửa repo thêm vài phút sau khi bạn đã bảo bỏ qua. Nút Skip vì thế
  có hộp xác nhận.
- **Yêu cầu advance gửi tới lúc scheduler đang bận không bị mất.** Trước đây `advanceRun` trả về ngay
  khi thấy run đang advance, nên mọi lần Retry/Skip/Continue bấm giữa turn đều rơi vào hư không.
- **Khởi động lại server chỉ park đúng run có step đang chạy.** `reconcileRunsOnBoot` từng dùng biến
  đếm cộng dồn làm cờ, nên một run dở dang kéo mọi run đứng sau nó sang `awaiting_input`.

## Input và `@`

Workflow khai `inputs` thì màn Start hiện đúng ô đó, mọi step đọc bằng `{{key}}`. Hai kiểu được
**server đọc hộ trước khi step đầu chạy**:

- `docs` — dán link file GitHub (nhiều link cũng được), nội dung nằm sẵn trong ngữ cảnh step đầu.
  Private repo vẫn đọc được qua `gh` login, không cần clone repo spec.
- `jira-ticket` — nội dung ticket, mô tả đã đổi sang markdown.

Trong ô Goal và ô instruction, gõ `@` để tag: `@jira:KEY`, `@ticket:KEY-123`, `@repo:owner/name`,
`@doc:owner/repo:path`. Ghim Jira project ở **Settings → Integrations** để ô chọn project thành dropdown.

## Cần gì để chạy

- Agent: `spec-reader` và `jira-pm` ở [`../agents/`](../agents/) (import ở trang Agents), cộng
  `fe-dev` / `ios-dev` của team.
- Project command: các step `gate` gọi command theo tên — `Test` (fe, be, fixbug, other) và `Build`
  (ios). Chưa khai trong tab Commands thì run **dừng ngay tại gate** với đúng lý do đó, không loop
  ba vòng rồi mới báo.

## Quyền của step: `bypassPermissions`

Mọi step agent chạy ở `bypassPermissions`. Lý do đơn giản: `acceptEdits` chỉ tự duyệt **sửa file**,
nên `git status` ở step đầu đã dừng hỏi — một run không người canh sẽ đứng ở đó tới hết giờ.

Đây là đánh đổi có thật, nói thẳng: **step chạy được mọi lệnh mà không hỏi**. Ba thứ giữ nó lại:

- Step làm trong **worktree riêng** khi workflow khai `isolate`, hoặc trong repo của run — không phải
  thư mục bạn đang gõ.
- **Merge vẫn là người bấm**, và đẩy store cũng vậy. Đó là ranh giới duy nhất không được nới.
- Cổng confirm: step nào khai `requiresConfirm` thì dừng lại cho bạn đọc và trao đổi trong terminal
  của chính nó trước khi đi tiếp.

Muốn chặt hơn cho một step cụ thể thì đổi `permissionMode` của step đó về `acceptEdits` — và chấp
nhận nó sẽ dừng hỏi ở lệnh shell đầu tiên.
