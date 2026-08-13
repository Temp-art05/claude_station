# Plan — Viết lại README (ngắn gọn + screenshot theo tính năng)

## Mục tiêu

README hiện tại dài, dày đặc bảng chữ, người mới đọc không hình dung được app trông ra sao.
Viết lại theo hướng **ngắn — nhìn là hiểu**: mỗi tính năng quan trọng có 1 ảnh chụp màn hình
kèm 2–3 câu mô tả, thay cho bảng 20 dòng như hiện nay.

## Phạm vi

- Chạm: `README.md`, thêm thư mục `docs/images/`.
- **Không** đụng code, không đổi tính năng, không sửa `docs/plans/*` khác.

## Trạng thái git (kiểm tra trước khi làm)

Local `main` đang **behind origin/main 3 commit**, ahead 0:

```
d6859c3 Merge pull request #2 from thedn-art/feat/ui-state-persistence
b54f872 Fix bug back github
5073481 feat(ui): keep tabs, selections, drafts and panels across navigation
```

→ **Không force push.** Bước 0 bắt buộc: `git pull --ff-only` để bắt kịp remote,
rồi mới commit README lên trên. Force push sẽ xoá 3 commit trên (gồm PR #2 đã merge).

## Cấu trúc README mới

| # | Mục | Nội dung | Ảnh |
|---|---|---|---|
| 1 | Tiêu đề + pitch | 2 câu: dashboard local điều khiển Claude Code trên nhiều repo | hero |
| 2 | Quick start | `npm install` → `.env` → `npm run dev`, kèm ghi chú token | — |
| 3 | Tính năng | mỗi mục 1 ảnh + 2–3 câu (bảng bên dưới) | 8 ảnh |
| 4 | Cấu hình | rút gọn còn 1 bảng 3 dòng (`.env` / Settings / per-project) | — |
| 5 | Dữ liệu nằm đâu | giữ block `data/` hiện tại, rút bớt chữ | — |
| 6 | Scripts | giữ nguyên | — |
| 7 | Troubleshooting | giữ nguyên 3 mục (hữu ích, đang có thật) | — |

Phần bị cắt/gộp so với bản cũ: "Why the token" (gộp 2 câu vào Quick start),
bảng "What it does" 20 dòng (thay bằng mục Tính năng có ảnh), các mục nhỏ
(Search, History, Doctor, Memory) gộp vào 1 đoạn "Còn lại".

## Danh sách ảnh cần chụp

Đặt tại `docs/images/`, PNG, chụp cửa sổ browser (không full màn hình), width ~1600px.

| File | Trang / thao tác để chụp | Mô tả đi kèm |
|---|---|---|
| `hero.png` | Project detail, tab Claude đang chạy | ảnh mở đầu README |
| `projects.png` | `/projects` — list project | Gom nhiều repo (FE/BE/iOS) thành 1 project, mỗi path có label + mô tả |
| `claude.png` | Project → tab Claude (terminal claude CLI) | Terminal `claude` nhúng theo từng repo, approve ngay trong TUI, restart resume bằng `--continue` |
| `git-diff.png` | Project → tab Diff, đang xem 1 file thay đổi | git status/diff theo path, discard từng file, worktree riêng cho mỗi session |
| `workflows.png` | `/workflows` → 1 run đang chạy, thấy các step | Chuỗi bước lặp lại: agent → command → stop hỏi ý bạn; artifact tải được theo step |
| `env.png` | `/env` — env set với preview 2 dòng | Env set global/per-project, inject vào terminal + build + chat |
| `terminals-commands.png` | Project → tab Terminals hoặc Commands đang chạy build | PTY thật + runner build/test có log trực tiếp, timeout, kill cả process group |
| `knowledge-agents.png` | `/knowledge` hoặc `/agents` | Docs/spreadsheet per project + thư viện global; subagent có allowlist tool riêng |

**Lưu ý riêng tư:** ảnh sẽ lộ tên project/repo/ticket Jira thật. Trước khi commit cần
xem lại và che (hoặc dùng project demo) nếu repo này public.

## Cách lấy ảnh — ĐÃ CHỐT: B (headless Chrome)

Máy không có Playwright/Puppeteer/chromedriver. Dùng Chrome sẵn có:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome \
  --headless --screenshot=<out.png> --window-size=1600,1000 \
  --virtual-time-budget=8000 "http://127.0.0.1:<port>/<route>?t=<token>"
```

Điều kiện & rủi ro đã biết:

- Phải chạy `npm run build && npm start` (1 port duy nhất) để URL và API cùng origin.
- Token lấy từ `.env` (`CLAUDE_STATION_TOKEN`) hoặc `data/.token`; truyền qua `?t=`.
- Headless **không click được** → chỉ chụp được state mà URL tự mở ra. Tab nào chỉ đổi bằng
  click và lưu ở `localStorage` (ui-state-persistence) sẽ về default → ảnh có thể không đúng
  tab mong muốn. Cần kiểm tra router trước, ảnh nào không ra thì bỏ khỏi README (không để
  ảnh rỗng) và báo lại danh sách ảnh thiếu.
- Sau khi chụp: **đọc lại từng ảnh** để kiểm tra render đủ chưa và có lộ dữ liệu gì không.

## Riêng tư — repo PUBLIC (đã chốt)

Repo sẽ public → ảnh chụp từ DB thật sẽ lộ tên project, path máy (`/Users/dinhngocthe/…`),
tên repo nội bộ, ticket Jira, email. Bắt buộc:

- Xem lại từng ảnh trước khi commit; ảnh nào lộ thì loại hoặc thay bằng state trung tính.
- Không để token lọt vào ảnh (app tự xoá `?t=` khỏi address bar, nhưng vẫn phải kiểm tra).
- Nếu quá nhiều ảnh dính dữ liệu thật → báo lại, chuyển sang phương án bạn tự chụp bằng
  project demo.

## Ngôn ngữ — ĐÃ CHỐT: tiếng Anh

Giữ tiếng Anh như bản hiện tại, đồng bộ với comment trong code.

## Edge case

- README hiện có link `docs/plans/claude-station.md` → giữ lại.
- Ảnh không được vào `data/` (đang gitignore); `docs/images/` không bị ignore — đã kiểm tra.
- Giữ nguyên các cảnh báo bảo mật về token (RCE by design) — chỉ rút gọn, không bỏ.
- Nếu chọn A, README sẽ có link ảnh hỏng cho tới khi bạn bỏ file vào. Chấp nhận được,
  hoặc tôi commit ảnh placeholder xám để không vỡ layout.

## Kết quả thử nghiệm chụp trên instance THẬT (đã làm — thất bại một phần)

Headless Chrome hoạt động (phải dùng `http://localhost:5173`, vite chỉ bind IPv6;
phải hard-kill vì WebSocket giữ virtual-time không kết thúc). Nhưng nội dung không dùng được:

| Trang | Kết quả |
|---|---|
| `/projects` | ❌ Lộ tên project nội bộ `aip555-…`, `iip555-…`, `wis555-…` + mô tả sản phẩm |
| `/env` | ❌ Lộ nặng: Jira code AIP555/IIP555, path `/Users/dinhngocthe/IOS/…`, repo `AperoVN/…`, Discord `TheDN` |
| `/workflows` | ⚠️ Lộ nhẹ: "ReelMe IIP555" trong mô tả |
| Project detail → Diff | ✅ Sạch (chính repo này), render đẹp |
| Project detail → Claude | ❌ "Connection failed" — PTY của session cũ đã chết (orphan) |
| Project detail → Terminals | ❌ Empty state — headless không click được "+ Terminal" |

→ **Đổi hướng: dựng instance DEMO riêng.**

## Hướng mới — instance demo (data dir riêng)

- Chạy bản production build với `CLAUDE_STATION_DATA=<scratch>/demo-data` + `PORT` riêng.
  Data thật của người dùng **không bị đụng tới**.
- Seed qua REST API bằng token của demo dir: 1–2 project demo (trỏ vào chính repo
  claude_station để git/diff/commands có dữ liệu thật), 1 env set demo, workflow từ preset.
- Terminal/Claude: tạo session qua API để PTY sống thật, rồi chụp — đây là cách duy nhất
  vượt được giới hạn "headless không click".
- Ảnh nào vẫn không ra được thì bỏ khỏi README và báo rõ, không nhét ảnh rỗng.

## Các bước thực hiện

0. `git pull --ff-only` (bắt kịp 3 commit remote). **Không force push.**
1. Đọc router `web/src` để biết route nào chụp được, chốt lại danh sách ảnh khả thi.
2. `npm run build && npm start`, lấy token.
3. Chụp từng ảnh bằng headless Chrome vào `docs/images/`.
4. Đọc lại từng ảnh: render đủ chưa, có lộ dữ liệu thật không → loại ảnh hỏng/nhạy cảm.
5. Viết lại `README.md` theo cấu trúc trên, chỉ nhúng những ảnh thực sự đạt.
6. Commit + push thường lên `main`; báo lại ảnh nào thiếu và vì sao.
