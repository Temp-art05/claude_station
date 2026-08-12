# Plan — Sửa download/export cho Knowledge, Agents, Workflows

## Mục tiêu

Mọi item trong Library đều tải về được bằng 1 cú click, kể cả item là thư mục
(skill bundle, folder import), và tên file đính kèm luôn an toàn trong header.

## Hiện trạng (đã kiểm chứng trong code)

| Chỗ | Trạng thái | Chi tiết |
|---|---|---|
| Knowledge — file thường | OK | `/api/knowledge/:id/file` stream file |
| Knowledge — `kind: "skill"` | **Hỏng** | `storedPath` là thư mục → route trả 400 (`routes/knowledge.ts:156`), nhưng UI vẫn hiện nút (`KnowledgePanel.tsx:357` chỉ ẩn khi `kind === "folder"`) |
| Knowledge — `kind: "folder"` | **Thiếu** | Nút Download bị ẩn, không có cách tải |
| Knowledge — header | Yếu | `inline` + `originalFilename` thô (chứa `/`, non-ASCII) |
| Agents | OK | zip bundle / `.agent.md`, đã dùng `attachmentName` |
| Agents — tooltip | Cosmetic | luôn ghi "Export as .agent.md" dù trả `.zip` |
| Workflows | Yếu | `filename="${workflow.name}.workflow.yaml"` không sanitize (`routes/workflows.ts:132`) |

`server/src/lib/zip.ts` đã có sẵn `dirEntries()`, `zipEntries()`, `attachmentName()` —
viết cho agents, chỉ cần dùng lại, không thêm dependency mới.

## Phạm vi

Chỉ sửa đường download/export. Không đụng import, không đổi schema, không đổi
cách lưu trữ.

## Các bước

### 1. `server/src/routes/knowledge.ts` — cho phép tải thư mục

Trong `GET /api/knowledge/:id/file`:

- Bỏ nhánh trả 400 khi `statSync(safe).isDirectory()`.
- Thay bằng: `zipEntries(dirEntries(safe))` → trả `application/zip`, header
  `attachment; filename="${attachmentName(row.name, ".zip")}"`.
- Nhánh file thường: đổi `inline` → `attachment`, và dùng
  `attachmentName(row.originalFilename, "")` để bỏ `/` và ký tự lạ.
  - Giữ `inline` cho nhánh `?sheet=` (preview xlsx trong UI đang dựa vào nó) —
    kiểm tra lại chỗ gọi trước khi đổi, nếu preview không phụ thuộc thì thống nhất
    `attachment` cho cả hai.
- Import thêm `dirEntries`, `zipEntries`, `attachmentName` từ `../lib/zip`.

Edge case: thư mục rỗng → zip rỗng vẫn hợp lệ, trả bình thường (không 500).
Thư mục lớn: `dirEntries` đọc hết vào RAM. Chấp nhận ở quy mô skill/folder
(hàng trăm KB); nếu muốn chặn thì thêm ngưỡng — **cần confirm** (xem dưới).

### 2. `web/src/features/knowledge/KnowledgePanel.tsx` — hiện nút cho mọi kind

- Bỏ điều kiện `row.kind !== "folder"` ở dòng 357, luôn render nút Download.
- Tooltip theo kind: `"Download"` cho file, `"Download as .zip"` cho
  `folder`/`skill`.
- Thêm `download` attr vào thẻ `<a>` để browser tải thay vì điều hướng.

### 3. `server/src/routes/workflows.ts` — sanitize tên file

- Dòng 132: `attachmentName(workflow.name, ".workflow.yaml")` thay cho nội suy thô.
- Import `attachmentName` từ `../lib/zip`.

### 4. `web/src/features/agents/AgentList.tsx` — sửa tooltip

- Dòng 118: đổi title thành `"Export agent"` (không hứa đuôi file cụ thể vì
  server trả `.zip` khi có bundle).

### 5. Kiểm chứng — ĐÃ CHẠY

Unit test mới: `server/src/lib/__tests__/zip.test.ts` (7 case — walk cây, chặn
budget, zip hợp lệ, giữ dấu ở `filename*`, chống inject header/path, fallback).
Toàn bộ suite: 48/48 pass, typecheck sạch.

End-to-end trên một instance server tạm (data dir riêng), kết quả thật:

| Thao tác | Kết quả |
|---|---|
| Skill bundle | `200 application/zip`, giải nén ra `SKILL.md`, `notes.txt`, `scripts/run.sh` |
| Folder "tài liệu" | `200 application/zip`, `filename*=UTF-8''t%C3%A0i%20li%E1%BB%87u.zip` |
| File "báo cáo.txt" | `attachment`, tên giữ nguyên dấu, nội dung đúng |
| Agent có bundle | `application/zip` chứa `dong-goi.md` + `tpl/a.txt` |
| Agent không bundle | `text/markdown`, `tro-ly.agent.md` |
| Workflow | `bao-cao-tuan.workflow.yaml` |

Ghi chú: tên agent và workflow bị `^[a-z0-9][a-z0-9-]*$` chặn ngay từ schema nên
`filename*` ở hai chỗ đó luôn trùng dạng ASCII — dùng `contentDisposition` là để
đồng nhất và phòng đường import về sau, không phải vì đang vỡ. Tên skill cũng bị
`safeName` cắt dấu lúc import (`Kỹ năng Việt` → `K-n-ng-Vi-t`) — đó là tầng lưu
trữ, ngoài phạm vi lần này. Riêng folder và file thường thì giữ được dấu.

### Kiểm chứng ban đầu (checklist)

- Import 1 skill bundle → bấm Download → nhận `.zip` giải nén ra đúng cây file.
- Import 1 folder → bấm Download → nhận `.zip`.
- Tải 1 file thường (pdf/xlsx) → vẫn tải đúng như cũ, tên file giữ nguyên nghĩa.
- Export 1 agent có `bundleDir` và 1 agent không có → `.zip` / `.agent.md`.
- Export 1 workflow tên có dấu tiếng Việt → tải được, tên file không vỡ.
- Chạy test suite hiện có của server.

## File dự kiến chạm

- `server/src/routes/knowledge.ts`
- `server/src/routes/workflows.ts`
- `web/src/features/knowledge/KnowledgePanel.tsx`
- `web/src/features/agents/AgentList.tsx`

## Đã chốt

1. **Ngưỡng dung lượng zip**: chặn ở **100 MB**. `dirEntries` cộng dồn size khi
   duyệt cây, vượt thì ném lỗi `statusCode: 413` với thông báo rõ ràng thay vì
   ngốn RAM.
2. **Tên file non-ASCII**: **giữ nguyên dấu** theo RFC 5987. Thêm
   `contentDisposition(name, ext)` vào `lib/zip.ts`, trả cả `filename="<ascii>"`
   (fallback) lẫn `filename*=UTF-8''<percent-encoded>`. Dùng chung cho knowledge,
   agents và workflows nên tên tiếng Việt đúng ở cả ba chỗ.
3. **`inline` cho preview xlsx**: file thường và thư mục dùng `attachment`; giữ
   `inline` riêng cho nhánh `?sheet=` để preview xlsx trong UI không vỡ.
