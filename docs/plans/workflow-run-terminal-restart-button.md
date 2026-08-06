# RunView — nút Restart cho Claude terminal của workflow run

## Mục tiêu
Tab Workflows, view run terminal-mode (`web/src/features/workflows/RunView.tsx`): khi terminal chết ("Terminal is not running…"), user có nút **Restart** ngay tại chỗ giống tab Claude, không phải mò sang tab khác.

## Hiện trạng
- Tab Claude (`TerminalsTab`, kind="claude") có nút Restart gọi `useRestartTerminal` → `POST /api/terminals/:id/restart`.
- Server route restart đã hỗ trợ terminal của workflow run (re-derive `CLAUDE_STATION_URL`/`CLAUDE_STATION_TOKEN`, claude-kind resume bằng `claude --continue`) — không cần sửa server.
- `TerminalPane` khi PTY chết nhận `{t:"error"}` → set `fatal`, ngừng reconnect vĩnh viễn → sau restart phải **remount** pane (đổi `key`).

## Phạm vi
Chỉ `web/src/features/workflows/RunView.tsx`.

## Các bước
1. Import `RotateCw` (lucide) + `useRestartTerminal` từ `@/features/terminals/hooks`.
2. Thêm state `terminalEpoch` (số lần restart) để remount `TerminalPane`.
3. Đổi header khu terminal thành hàng flex: label bên trái, nút ghost `Restart` bên phải. Click → `restartTerminal.mutate(run.terminalId)`; onSuccess → `terminalEpoch + 1`.
4. `TerminalPane` thêm `key={terminalEpoch}`.

## Edge cases
- Terminal đang chạy mà bấm Restart: server no-op (`pty.isRunning` → trả existing), pane remount lại attach bình thường — vô hại.
- `useRestartTerminal(projectId)` invalidate query `["terminals", projectId]` — không ảnh hưởng gì ở đây.
