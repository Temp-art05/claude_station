# Thư viện workflow — và chọn hình dạng nào

Import cả thư mục này ở trang **Workflows → Import folder**, hoặc từng file một.

Viết một workflow không đắt. **Chọn nhầm hình dạng cho loại việc** mới đắt — nó chạy được, ra kết quả,
và bạn chỉ phát hiện sai sau vài lần chạy. Bảng dưới xếp theo câu hỏi "việc của tôi trông như thế nào",
chứ không theo tên mô hình.

| Việc của bạn trông như… | Dùng | Vì sao |
|---|---|---|
| Có thứ tự cứng, bước sau cần kết quả bước trước | `seq-feature-auto` | Tuần tự (prompt chaining). Đơn giản nhất, và phần lớn việc thật là loại này |
| Một tài liệu spec → ra task, ra PR | **`spec-doc-to-delivery`** | Đầu-cuối. Dán link docs, chọn Jira project, xong |
| Như trên nhưng muốn duyệt cách chia task trước | `spec-doc-to-tasks` | Chèn cổng người ngay trước bước tốn kém nhất |
| Ticket đã mô tả đủ rõ | `ticket-to-pr` | Không cần docs, nội dung ticket được nạp sẵn |
| Đầu vào có vài loại rõ rệt, mỗi loại một đường | `branch-by-answer` | Routing. Một prompt chung cho mọi loại thì loại nào cũng làm dở |
| Chia được thành phần độc lập, biết trước có mấy phần | `parallel-multi-repo` | Fan-out tĩnh. Rút thời gian thật vì chúng không chờ nhau |
| Nhiều việc con cùng loại, **không biết trước bao nhiêu** | `orchestrator-tasks` | Một con khảo sát rồi chia lô; ba thợ làm song song |
| Bỏ sót đắt hơn chạy thừa | `voting-review` | Chạy ba lượt giống hệt rồi lấy đồng thuận. Một lượt có thể sót, ba lượt cùng sót thì khó hơn |
| Cần nhiều góc nhìn khác nhau trên cùng một diff | `review-swarm` | Chia theo khía cạnh (lỗi · hiệu năng · chuẩn code), không phải chia theo số lượt |
| Có test/lint làm trọng tài | `gate-loop-impl-test` | Evaluator–optimizer với máy chấm. Vòng sửa do scheduler giữ, không do agent tự nhận định |
| Đầu ra là **chữ**, chất lượng đọc mới biết | `draft-critique-revise` | Con thứ hai chấm theo checklist. Bảo chính nó tự chấm thì lần nào cũng "đạt" |
| Đang dùng sẵn workflow FE/iOS của team | `impl-fe-workflow`, `impl-ios-workflow` | Bản đang chạy thật, thêm hai step Jira tự bỏ qua khi run không điền project/ticket |

Hai agent đi kèm nằm ở [`../agents/`](../agents/): `jira-pm` (chỉ đụng Jira, **không sửa code**) và
`spec-reader` (đọc spec, read-only trên code). Import ở trang Agents.

## Ba thứ quyết định hình dạng

**1. Các phần có chờ nhau không?** Không chờ nhau thì cho chạy song song — nhưng hai step song song
không bao giờ được ghi vào cùng một thư mục. Hoặc mỗi step một repo (`cwdLabel`), hoặc mỗi step một
worktree (`isolate: true`). Quên cả hai thì scheduler xếp chúng chạy lần lượt và bạn không được gì.

**2. Ai nói "xong"?** Nếu máy nói được — `gate` với một command, exit code quyết định. Nếu chỉ người
đọc mới biết — `manual`, hoặc một con khác chấm (`draft-critique-revise`). Thứ **không** nên làm là để
chính con vừa làm tự tuyên bố đã xong: đó là lúc "workflow chạy trót lọt" và "việc làm đúng" tách khỏi
nhau.

**3. Chỗ nào thật sự cần người?** Mỗi cổng người là một lần bạn phải quay lại bàn. Giữ cổng ở chỗ sai
thì lùi lại tốn kém: trước khi tạo hàng loạt ticket, trước khi merge. Bỏ cổng ở chỗ rẻ: xem lại một
bản plan có thể để tới cuối.

## Input và `@`

Workflow khai `inputs` thì màn Start hiện ô tương ứng, và mọi step đọc được bằng `{{key}}`.
Hai kiểu input được **server đọc hộ trước khi step đầu chạy**:

- `docs` — dán link file GitHub, nội dung file nằm sẵn trong ngữ cảnh step đầu (private repo vẫn đọc
  được, dùng `gh` login; không cần clone repo spec).
- `jira-ticket` — nội dung ticket, mô tả đã đổi sang markdown.

Trong ô Goal và ô instruction, gõ `@` để tag: `@jira:KEY` (project), `@ticket:KEY-123`,
`@repo:owner/name`, `@doc:owner/repo:path`. Tag được resolve cùng một đường với input — đích đến là
agent không phải tiêu một lượt chỉ để đi lấy tài liệu.

Ghim Jira project ở **Settings → Integrations → Jira** để ô `jira-project` thành dropdown thay vì ô gõ tay.
