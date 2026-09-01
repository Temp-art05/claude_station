# Terminal: chữ bị chèn sai cột sau khi reconnect

## Hiện tượng

Tab Terminal render lẫn lộn: chữ đúng nhưng sai cột, đuôi của nhiều dòng khác nhau
dồn lên một dòng.

```
cdạ/Users/temp/DATA/AREA/AI_Knowledge/claude_station chạy chưa đọc STATION_HOST)
! sudo -S bashpscriptu/-etup-host.sh
n backup ni2efime.env.bak*:        ng 12      t              ng
```

Phần prompt đang gõ thì sạch — chỉ **history** bị hỏng. Đó là dấu hiệu của replay,
không phải của live output.

## Nguyên nhân

`server/src/services/pty-manager.ts` giữ ring buffer **byte thô** (`scrollback`),
cap 200KB (`terminal.scrollbackBytes`, `shared/src/types.ts:1104`), và mỗi lần
`attach()` (dòng 130) replay nguyên xi vào một xterm mới. Hai tính chất giết nó:

1. **`trimScrollback` cắt giữa escape sequence.** Nó `shift()` cả chunk khỏi đầu
   buffer (`:27-30`), nên replay thường bắt đầu giữa một CSI dở dang — và mất luôn
   toàn bộ state (alt-screen, scroll region, cursor pos) làm cho các byte sau đó có
   nghĩa. xterm đọc byte tham số còn lại thành text và ghi vào sai cột.
2. **Claude Code vẽ bằng absolute cursor positioning.** Một stream redraw ghi ở
   width A, replay vào terminal width B là rác, kể cả khi không bị cắt.

Terminal trong ảnh là tmux-backed, và ở đó replay còn **vô nghĩa**: tmux giữ screen
thật, nó tự repaint. App đẩy rác vào trước rồi tmux vẽ đè lên một phần — phần sót
lại chính là cái thấy trong ảnh.

## Phạm vi (đã chốt)

### 1. tmux-backed: bỏ replay, bảo tmux repaint

PTY của app là một tmux **client** sống dai qua các lần WS reconnect, nên nó không
tự re-attach → không có repaint nào tự xảy ra. Thêm `tmux refresh-client` và gọi nó
thay cho replay.

**Đánh đổi đã chốt:** tab reconnect giờ thấy **screen hiện tại sạch**, không còn thấy
history phía trên nữa (trước đây thấy nhưng hỏng). History thật vẫn nằm trong
copy-mode của tmux. Đổi rác lấy đúng.

Repaint phải xảy ra **sau** khi client gửi resize, không thì vẽ ở size cũ rồi mới
reflow. Nên gọi `refreshClient` ở lần resize đầu sau attach, trong `terminal-ws.ts`,
chứ không phải trong `attach()`.

### 2. non-tmux: reset trước khi replay

Không có tmux để repaint thì byte log là tất cả những gì có. Prefix `\x1bc` (RIS) để
emulator bắt đầu từ state biết trước. **Không** khắc phục được việc cắt giữa sequence —
muốn đúng hẳn phải giữ `@xterm/headless` + addon-serialize ở server. Ghi nhận, không
làm trong lần này.

### 3. Hai defect client kèm theo

- `TerminalPane.tsx:102` — `socket.onopen` gọi `fit.fit()` rồi gửi resize **không có
  guard 0×0**, trong khi ResizeObserver (`:155`) có. Reconnect lúc pane đang bị ẩn sẽ
  đẩy geometry rác vào PTY. Gom thành một `sendResize()` dùng chung.
- `TerminalPane.tsx:49` — xin font `JetBrains Mono`, nhưng `@font-face` duy nhất tên
  `JetBrains Mono Variable` (`index.css:110` viết đúng). Terminal đang âm thầm render
  bằng fallback SF Mono/Menlo. Không gây lệch cột (fallback là font hệ thống, đo ổn
  định) nhưng lệch so với cả app.

## Đã làm (2026-08-18)

Cả 4 mục trên, kèm một chỗ plan nói chưa đủ chính xác:
`refresh-client -t` nhận **client** (`/dev/ttys003`), không phải session, nên bản
`refreshClient()` đầu tiên (`-t "=<session>"`) trả `can't find client` và bị `catch`
nuốt — một no-op im lặng. Giờ resolve client qua `list-clients -t "=<session>" -F
"#{client_name}"` rồi refresh từng cái. Kiểm chứng trên tmux 3.7a: một client thật
attach vào session alt-screen nhận đúng một full repaint cho mỗi lần gọi.

Arg building tách thành `listClientsArgs` / `refreshClientArgs` (đúng như phần đầu
`tmux.ts` đã nói) và có test — đây chính là loại lỗi mà test arg bắt được.

Nhánh non-tmux giờ không còn buffer gì cho PTY tmux-backed nữa: 200KB/terminal đó
chỉ để replay ra rác.

## File sửa

| File | Sửa |
| --- | --- |
| `server/src/lib/tmux.ts` | thêm `sessionClients()` + `refreshClients()`, arg builders `listClientsArgs` / `refreshClientArgs` |
| `server/src/lib/__tests__/tmux.test.ts` | test arg building: `client_*` chứ không `window_*`, target là tty chứ không session |
| `server/src/services/pty-manager.ts` | tmux-backed thì không buffer và không replay; non-tmux prefix RIS; thêm `resizeAndPaint()` |
| `server/src/ws/terminal-ws.ts` | `resizeAndPaint()` ở lần resize đầu sau attach, các lần sau `resize()` như cũ |
| `web/src/features/terminals/TerminalPane.tsx` | `sendResize()` dùng chung có guard 0×0; repaint renderer khi frame về; WebGL context-loss fallback; re-measure khi font tới; status ra banner thay vì ghi vào buffer |
| `web/src/features/commands/LogPane.tsx` | sửa tên font |
