# Projects — board 2 cột Active / Backlog, kéo thả

## Mục tiêu

Trang Projects (`web/src/pages/ProjectsPage.tsx`) đổi từ grid 2 cột phẳng sang **board 2 cột**:

- **Active** — project đang làm việc.
- **Backlog** — project để dành, không muốn thấy lẫn với việc đang chạy.

Kéo thả card project: chuyển qua lại giữa 2 cột **và** đổi thứ tự trong cùng một cột. Trạng thái + thứ tự **lưu vào DB**, không phải state tạm của UI.

## Đã chốt với người dùng

- Tên cột: **Working on** / **Backlog**.
- Ngoài kéo thả, mỗi card có thêm nút chuyển cột (hiện khi hover) để dùng được trên touch.
- Backlog **chỉ là cách group ở trang Projects**. Không ẩn project khỏi sidebar recents, không ẩn khỏi các dropdown chọn project (env set scope, knowledge, workflows…).
- Kéo thả **có reorder trong cột**, nên cần cột `sort_order` chứ không chỉ `status`.

## Phạm vi

- `shared/src/types.ts` — thêm `status` + `sortOrder` vào `projectSchema`, thêm `projectBoardInputSchema`.
- `shared/src/project-board.ts` (mới) — hàm thuần `moveOnBoard(board, id, status, index)`: toán "kéo card vào slot nào", trả `null` khi không có gì đổi. Tách ra đây để test được mà không cần drag event.
- `server/src/services/__tests__/project-board.test.ts` (mới) — test `moveOnBoard` (repo chưa có harness test cho route HTTP, nên test phần logic thuần).
- `server/src/db/schema.ts` + migration mới trong `server/drizzle/` — 2 cột `status`, `sort_order` trên bảng `projects`.
- `server/src/routes/projects.ts` — order theo cột mới; endpoint sắp xếp board; project mới vào đầu Active.
- `web/src/features/projects/hooks.ts` — hook mutation cho board.
- `web/src/pages/ProjectsPage.tsx` — layout 2 cột + kéo thả.
- `README.md` — mô tả lại phần Projects (kèm ảnh cũ, không đổi ảnh).

Không đổi: ProjectDetailPage, ProjectFormDialog, DeleteProjectDialog, AppShell.

## DB

`projects` thêm:

- `status TEXT NOT NULL DEFAULT 'active'` — `'active' | 'backlog'`.
- `sort_order INTEGER NOT NULL DEFAULT 0`.

Không backfill: list order là `sort_order ASC, updated_at DESC`, nên khi tất cả `sort_order = 0` thứ tự hiện tại (mới sửa lên trước) giữ nguyên cho tới lần kéo đầu tiên.

Migration sinh bằng `npx drizzle-kit generate --name=projects-board` → `server/drizzle/0015_projects-board.sql` (2 câu `ALTER TABLE ... ADD`), chạy tự động khi server boot (`server/src/db/index.ts` gọi `migrate`).

## API

- `GET /api/projects` — trả thêm `status`, order `sort_order ASC, updated_at DESC`.
- `POST /api/projects` — project mới: `status = 'active'`, `sort_order = min(sort_order của Active) - 1` → nằm đầu cột Active.
- **Mới**: `PATCH /api/projects/board`, body `{ active: string[], backlog: string[] }` — FE gửi thứ tự nó đang thấy của **cả hai cột**; server ghi `status` + `sort_order = index` trong 1 transaction, bỏ qua id không tồn tại, trả về list project như `GET`. Idempotent, không cần lo race (app local 1 người dùng).
  - Đặt route này **trước** `PATCH /api/projects/:id` để `board` không bị bắt như một id.
  - Không đụng `updated_at` khi chỉ sắp xếp — sắp lại board không phải là "sửa project".

## FE — layout

- Container rộng hơn: `max-w-6xl`.
- Grid `sm:grid-cols-2`, mỗi cột là một vùng drop: header (tên cột + số project) + stack card dọc.
- Card giữ nguyên nội dung hiện có (tên, badge số repo, description clamp 2 dòng, badge label repo, nút xoá hiện khi hover).
- Vùng thả ở cuối cột: cột có card thì vùng này **vô hình hoàn toàn** (không viền, không chữ) — nó chỉ để hứng drop ở khoảng trống dưới card cuối, còn feedback đã do đường kẻ chèn phía trên nó lo. Chỉ cột **trống** mới vẽ ô dashed kèm mô tả cột, vì lúc đó không có card nào để làm mốc thả.
- Mỗi card có thêm icon button chuyển cột (hiện khi hover, cạnh nút xoá): ở Working on thì "Move to Backlog", ở Backlog thì "Move to Working on" — đẩy card xuống cuối cột đích. Đây là đường dùng được trên touch, nơi native DnD không chạy.
- Dưới `sm`: 2 cột xếp dọc, Active trên.

## FE — kéo thả

Native HTML5 DnD, theo đúng precedent trong `web/src/features/git/DiffTab.tsx` (không thêm dependency):

- Wrapper card `draggable`, `<Link draggable={false}>` bên trong để anchor không chiếm quyền drag (nếu không, browser drag URL thay vì card). Click vẫn navigate như cũ.
- `onDragStart` set `dataTransfer` với MIME riêng (`application/x-claude-station-project`) = project id, `effectAllowed = "move"`.
- Drop lên **card**: nửa trên → chèn trước card đó, nửa dưới → chèn sau. Drop vào **vùng trống của cột**: đẩy xuống cuối cột.
- Highlight: card đang được nhắm tới có đường kẻ chèn; cột đang hover đổi nền nhẹ.
- Sau khi thả: `moveOnBoard` tính board mới; `null` thì bỏ qua, không gọi API. Hook `useSaveProjectBoard` cập nhật **optimistic** cache `["projects"]` trong `onMutate`, lỗi thì restore snapshot cũ.

## Edge cases

- Thả vào đúng vị trí cũ → không gọi API.
- Kéo card ra ngoài board / thả vào chỗ không phải drop zone → không đổi gì.
- Xoá project khi đang kéo → id không còn, server bỏ qua id lạ.
- Project mới tạo khi đang có `sort_order` âm → vẫn `min - 1`, không đụng các project khác.
- Danh sách rỗng hoàn toàn → giữ `EmptyState` như hiện tại (không hiện 2 cột trống).
- Touch/mobile: native DnD không chạy trên touch → dùng nút chuyển cột trên card. Reorder _trong_ cột vẫn cần chuột (ghi rõ trong README).

## Kiểm tra

- `npm run typecheck`, `npx eslint`, `npx prettier --check`, `npm run test`, `npm run build`.
- Test server cho route board (theo pattern test hiện có trong `server/src/**/__tests__`) nếu chỗ đó có harness cho route; nếu không, test hàm sắp xếp thuần.
- Chạy `npm run dev` kiểm tra tay: kéo qua cột, kéo trong cột, reload xem thứ tự có giữ.

## Cần confirm

Không còn — hai điểm mở (tên cột, touch) đã chốt ở mục "Đã chốt với người dùng".
