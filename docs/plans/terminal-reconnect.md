# TerminalPane: clear error banner + auto-reconnect WebSocket

## Mục tiêu
Banner "Connection failed" trong `web/src/features/terminals/TerminalPane.tsx` hiện
dính vĩnh viễn (chỉ `setError`, không bao giờ clear), và WS đứt là chết luôn pane
(chỉ in `[disconnected]`). Sửa: tự reconnect với backoff, banner tự biến mất khi
nối lại thành công.

## Hành vi server (đã đối chiếu `server/src/ws/terminal-ws.ts`)
- PTY không còn chạy → server gửi `{t:"error", message:"Terminal is not running…"}` rồi close
  → client **không được** retry (fatal, retry chỉ spam).
- Process exit → `{t:"exit"}` rồi close → giữ nguyên: không reconnect.
- Đứt vì lý do khác (server restart, mạng) → reconnect.

## Thay đổi (`TerminalPane.tsx`, chỉ trong effect chính)
1. Bọc phần tạo socket vào hàm `connect()`; biến effect-scope: `socket` (mutable),
   `disposed`, `closedByServer`, `fatal`, `attempt`, `reconnectTimer`.
2. `onopen`: `setError(null)`, reset `attempt`, gửi resize; chỉ `focus()` ở lần nối đầu.
3. `onmessage` `{t:"error"}`: setError như cũ **+ đặt `fatal = true`** (server chỉ gửi
   error này khi PTY chết / message hỏng — không retry).
4. `onclose`: nếu `disposed || closedByServer || fatal` → như cũ; ngược lại in
   `[disconnected]` (1 lần), banner "Connection lost — reconnecting…", retry sau
   `min(1s·2^attempt, 10s)`, retry vô hạn (app local).
5. `term.onData` / ResizeObserver / seed: đọc socket hiện tại qua biến effect-scope;
   `seedSent` giữ nguyên qua các lần reconnect (không gửi seed lặp).
6. Cleanup: `disposed = true`, clear timer, close socket.

## File chạm
`web/src/features/terminals/TerminalPane.tsx` (1 file).

## Edge cases
- Reconnect vào PTY đã bị dọn sau khi server restart → nhận `{t:"error"}` → dừng retry,
  banner báo restart terminal.
- Unmount giữa lúc chờ retry → timer bị clear, không leak.
- Reconnect không được cướp focus của pane khác.

## Verify
`tsc`/build web pass; test tay: chạy station, kill server WS (restart server) → pane
hiện "reconnecting", server lên lại → banner biến mất, gõ phím hoạt động.
