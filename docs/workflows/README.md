# Thư viện workflow — bảy nhóm, mỗi nhóm một workflow

Import cả thư mục ở **Workflows → Import folder**, hoặc từng file.

Trước đây ở đây có mười bốn workflow, phần lớn khác nhau ở **hình dạng** (song song, bỏ phiếu, vòng
lặp) chứ không ở **việc**. Mở ra phải chọn giữa ba cái đều tên là "review" thì không ai chọn được.
Giờ chia theo việc: mỗi nhóm một workflow, và những hình dạng kia nằm bên trong nó dưới dạng step.

| Nhóm | Workflow | Việc |
|---|---|---|
| `jira` | `specs-to-jira` | **Một hoặc nhiều** spec GitHub → chia task → tạo ticket vào sprint. Không đụng code |
| `fe` | `impl-fe-workflow` | Feature FE: plan → task Jira → impl → test → review → PR |
| `fe-be` | `fe-be-spec-to-pr` | Như trên, FE và BE **chạy song song**, mỗi bên một repo |
| `ios` | `impl-ios-workflow` | Feature iOS: như `fe` nhưng theo chuẩn Clean Architecture + MVVM |
| `ios-be` | `ios-be-spec-to-pr` | iOS và BE song song |
| `fixbug` | `bugfix-workflow` | Bug → **nguyên nhân gốc** → sửa + test chống tái phát → PR |
| `other` | `bulk-change-workflow` | Nhiều việc con cùng loại, không biết trước bao nhiêu |

Bốn workflow nhóm feature (fe · fe-be · ios · ios-be) gần như giống nhau — cùng một việc, khác repo
nào và có chạy song song hay không. Để riêng từng cái là cố ý: mở nhóm của mình ra là chạy được
ngay, không phải điền "làm ở đâu" mỗi lần.

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
