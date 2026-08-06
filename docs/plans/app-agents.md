# App agents — agent dạng ứng dụng chạy độc lập (jira-ai-fixer)

## Mục tiêu
Ngoài agent dạng prompt (.md), hỗ trợ **app agent**: một folder ứng dụng tự chạy (server + UI web riêng, ví dụ `jira-ai-fixer`: webhook server port 4747 + ngrok + `public/chat.html`). Yêu cầu người dùng đã chốt:
1. **Upload copy** cả folder vào `data/agents/<tên>` (qua Import folder sẵn có).
2. Workspace tab của agent có **nút Start** → mở 1 terminal Station (PTY thật — confirm prompt stdin của app hoạt động) tại bundle dir, chạy `startCommand`.
3. UI của app **embed thẳng bằng iframe** qua `viewUrl`; token truyền qua `?token=` trên URL (sửa `chat.html` tự đọc và lưu localStorage).
4. **Xem đồng thời terminal + web UI trong workspace tab**: iframe ở trên, `TerminalPane` (xterm attach vào terminal đang chạy) ở dưới; reattach khi mở lại tab (terminal đặt title `agent:<tên>` để tìm lại, /start idempotent — có terminal đang chạy thì trả về cái cũ).
5. **Env riêng theo project**: dùng env sets sẵn có (per-project). Workspace header có dropdown chọn env set truyền vào terminal khi Start; lựa chọn nhớ theo (project, agent) trong localStorage. Đã verify: `node --env-file=.env` KHÔNG đè biến có sẵn từ parent env → env set thắng, `.env` trong bundle chỉ là default.

## Thay đổi Claude Station
- **Schema** (`server/src/db/schema.ts` + migration 0005): agents thêm `view_url` (iframe URL của app đang chạy — ưu tiên hơn `view_path`) và `start_command` (chạy trong terminal tại `bundle_dir`).
- **Shared** (`shared/src/types.ts`): `agentSchema`/`agentInputSchema` thêm `viewUrl`, `startCommand`.
- **Agents service** (`server/src/services/agents.ts`): to/create/update/parse/export mang 2 field mới (frontmatter keys `viewUrl`, `startCommand`).
- **Multipart** (`server/src/lib/multipart.ts`): `sanitizeRelPath` **giữ dotfiles** (`.env`, `.gitignore`) — trước đây strip dấu chấm đầu segment làm `.env` thành `env`, app hỏng; vẫn chặn `.`/`..`/absolute.
- **Terminals** (`server/src/services/terminals.ts`): `createTerminal` nhận thêm `command?` truyền xuống `pty.start` (zsh -lic).
- **Route mới** `POST /api/agents/:id/start` `{ projectId, envSetId? }`: agent phải có `bundleDir` + `startCommand`; nếu đã có terminal `agent:<tên>` đang chạy trong project → trả về cái đó (idempotent), không thì mở terminal mới (kind shell, cwd = bundleDir, command = startCommand, envSetId), trả terminal row.
- **Web**: `AgentWorkspace.tsx` — nếu `agent.viewUrl`: header có dropdown env set + nút **Start/Stop** + Open standalone; body chia đôi: iframe `viewUrl` (trên) + `TerminalPane` attach terminal `agent:<tên>` (dưới, ẩn/hiện được). Ưu tiên `viewUrl` > `viewPath` > chat. `AgentEditor.tsx` thêm input `viewUrl`, `startCommand`.

## Custom jira-ai-fixer (repo `/Users/dinhngocthe/IOS/jira-ai-fixer`)
- `AGENT.md`: thêm frontmatter `name/description/startCommand: ./start.sh/viewUrl: http://127.0.0.1:4747/` (KHÔNG hardcode token vào repo; token thật set vào agent sau khi import).
- `public/chat.html`: đọc `?token=` từ URL → lưu `localStorage` như cũ → iframe từ Station tự đăng nhập.

## Import thật cho người dùng
Upload qua endpoint `POST /api/agents/import-folder` (curl multipart, loại `run/`, `.git`, `.idea`, `.DS_Store`) vào instance Station đang chạy; sau đó PATCH agent set `viewUrl` kèm token thật (đọc từ `.env` WEBHOOK_TOKEN — chỉ nằm trong DB local).

## Edge case
- Xoá agent = xoá `data/agents/<tên>` (cả `.env`/`state/` bản copy) — bản gốc ở `/Users/dinhngocthe/IOS/jira-ai-fixer` không bị đụng.
- App không chạy → iframe trắng/lỗi kết nối; bấm Start rồi reload (v1 không health-check).
- `run/` artifacts không upload — app tự tạo lại khi chạy.

## Verify
- Unit: sanitizeRelPath giữ `.env`; typecheck + test + build.
- Smoke: import folder qua curl → bundle đủ file (kể cả `.env`), agent có viewUrl/startCommand; POST /start mở terminal chạy start.sh; GET viewUrl trả chat.html; chat.html?token=... tự lưu token.
