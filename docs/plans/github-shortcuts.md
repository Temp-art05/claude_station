# GitHub tab: shortcut mở thẳng github.com

## Mục tiêu
Người dùng muốn "nhúng web GitHub" vào tab GitHub. Không nhúng được — github.com
gửi `X-Frame-Options: deny`, iframe bị chặn tuyệt đối. Thay bằng phương án gần nhất:
repo khai trong Settings hoạt động như shortcut — 1 click mở đúng trang github.com
(tab trình duyệt mới).

## Thay đổi (`web/src/pages/GitHubPage.tsx`, 1 file)
- Thêm hằng `GH_SHORTCUTS`: Code (`""`), Pull requests (`/pulls`), Issues (`/issues`),
  Actions (`/actions`), Branches (`/branches`), Releases (`/releases`).
- Dưới header (select repo): thanh nút — mỗi nút là `<a target="_blank">` tới
  `https://github.com/<owner>/<name><path>` của repo đang chọn, style như nút ghost
  hiện có (border-edge, text-xs).
- Giữ nguyên toàn bộ list PR/issue + Work with Claude bên dưới.

## Edge cases
- Chưa chọn repo / chưa config → không render thanh shortcut (đã có empty-state).
- Repo dạng sai (`abc` không có `/`) → `enabled=false` sẵn, shortcut cũng ẩn theo.

## Verify
`tsc --noEmit` web pass; mở tab GitHub thấy thanh shortcut, click mở đúng trang.
