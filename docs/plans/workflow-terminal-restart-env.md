# Fix: terminal-run workflow mất env báo tiến độ sau khi server restart

## Mục tiêu

Terminal của một workflow run mode `terminal` sau khi bị orphaned (server restart) và được restart lại vẫn có `CLAUDE_STATION_URL` / `CLAUDE_STATION_TOKEN`, để agent tiếp tục curl báo trạng thái step về stepper.

## Nguyên nhân

- `extraEnv` chỉ dùng lúc spawn PTY (`services/terminals.ts:46`), không persist vào DB.
- Endpoint restart (`routes/terminals.ts:84`) dựng lại env chỉ từ `envSetId` → 2 biến station biến mất sau reconnect → curl báo tiến độ fail âm thầm, stepper đứng yên.

## Các bước

1. `server/src/routes/terminals.ts` — trong endpoint `POST /api/terminals/:id/restart`: query `workflow_runs` theo `terminalId = id`; nếu terminal đang gắn với một run (chỉ terminal-mode run mới có `terminalId`) thì merge lại `CLAUDE_STATION_URL` (từ `env.port` hiện tại) + `CLAUDE_STATION_TOKEN` (từ `lib/auth`) vào env trước khi `pty.start`.

## File chạm

- `server/src/routes/terminals.ts`

## Edge case

- Re-derive thay vì persist: port/token có thể đổi giữa các lần boot → luôn lấy giá trị hiện tại.
- Terminal thường (không gắn run) → không inject gì, hành vi như cũ.
- Terminal gắn nhiều run cũ → chỉ cần tồn tại ít nhất 1 row là inject (giá trị env không phụ thuộc run).
