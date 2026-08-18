# PTY daemon: terminal sống sót qua server restart

> **Trạng thái (2026-08-18): chưa impl, và phần lợi ích chính đã được giải quyết theo cách
> khác.** `docs/plans/terminal-open-in-macos.md` cho mọi PTY chạy trong tmux, nên terminal
> đã sống qua server restart (row thành `orphaned` + `tmuxAlive`, bấm Reattach là về).
> Plan này chỉ còn cần nếu muốn bỏ hẳn phụ thuộc `tmux`.

## Mục tiêu

Terminal (kể cả tab Claude) **không chết khi server Fastify restart**. Hôm nay mỗi lần
Claude sửa file dưới `server/src/**`, `tsx watch` restart process → SIGTERM →
`killAllPtys()` → mọi PTY chết → pane hiện `[disconnected — reconnecting…]` rồi
`Terminal is not running (restart the terminal)` và phải bấm restart tay.

Cách sửa: PTY không sống trong process của server nữa, mà trong một **daemon riêng**.
Server restart bao nhiêu lần cũng được — daemon và các shell của nó không hề hay biết.

### Chuỗi nguyên nhân hiện tại (để đối chiếu khi verify)

1. `server/package.json:7` — `tsx watch src/index.ts`, ghi file dưới `server/src/**` là restart.
2. `server/src/index.ts:112-117` — SIGTERM → `killAllPtys()`.
3. `server/src/services/pty-manager.ts:20` — `sessions` là `Map` trong RAM, process mới = Map rỗng.
4. `server/src/ws/terminal-ws.ts:21-25` — reconnect vào id không còn → `{t:"error"}`.
5. `web/src/features/terminals/TerminalPane.tsx:119-120,133` — `{t:"error"}` đặt `fatal = true`
   → `onclose` return sớm → **retry dừng vĩnh viễn**.

## Phạm vi (đã chốt)

- **Chỉ PTY terminal.** `services/commands.ts` (build/test log) và Claude Agent SDK chat
  sessions **giữ nguyên** — vẫn chết theo server restart như hiện tại.
- Daemon **tự thoát khi idle**: 0 PTY liên tục trong N phút (mặc định 10) thì exit và
  xoá socket. Thêm `npm run pty:stop` để tắt tay kèm mọi shell.
- `killAllPtys()` khi server nhận SIGINT/SIGTERM **bị bỏ** — đó chính là thứ đang giết terminal.

## Kiến trúc

```
browser ──WS /ws/terminal/:id──> Fastify server ──WS unix:data/pty.sock──> pty-daemon
                                  (proxy thuần)                             (node-pty)
```

- Daemon là process Node riêng, `detached: true` + `unref()`, **không** nằm trong process
  group của server → tsx watch restart không đụng tới nó.
- Giao tiếp qua **Unix domain socket** `data/pty.sock` (perm 0600 — local, không mở port).
- Daemon chạy Fastify + `@fastify/websocket` `listen({ path: PTY_SOCK })`, nói **đúng
  protocol terminal WS hiện có** trong `@claude-station/shared` → `terminal-ws.ts` phía
  server thành ống dẫn thuần, không parse gì.

### API của daemon

HTTP (control):

| Route | Việc |
|---|---|
| `GET /health` | `{ ok, protocol, pid, sessions }` |
| `GET /sessions` | `string[]` — thay cho `runningIds()` |
| `POST /sessions` | body = `StartOptions` → `{ pid }` |
| `DELETE /sessions/:id` | kill |
| `POST /shutdown` | killAll + exit (dùng bởi `npm run pty:stop`) |

WS (stream): `GET /ws/pty/:id?since=<bytes>` — attach, replay scrollback từ offset,
output binary, input/resize/kill là JSON y như protocol hiện tại.

### Vì sao cần `since`

Hôm nay `attach()` replay **toàn bộ** scrollback mỗi lần nối (`pty-manager.ts:90`). Chuyện
đó vô hại vì sau server restart PTY đã chết nên chẳng bao giờ replay. Khi PTY sống sót,
mỗi lần restart server = một lần replay đầy đủ → **nội dung nhân đôi trong xterm**. Nên
daemon phải đếm `totalBytes` mỗi session và chỉ replay phần sau `since`.

- `since` nằm trong ring → replay đuôi, FE không cần làm gì.
- `since` quá cũ / attach mới → daemon gửi `{t:"reset", offset}` trước, FE `term.reset()`
  và set bộ đếm = `offset`, rồi nhận full ring.

## Các bước

1. **`shared/src/ws-protocol.ts`** — thêm vào `terminalServerMsgSchema`:
   `{t:"reset", offset:number}`; và `retryable?: boolean` cho `{t:"error"}`.
   Thêm `ptyStartOptionsSchema` (id/cwd/env/shell/command/cols/rows) dùng chung
   server ↔ daemon, và hằng `PTY_PROTOCOL = 1`.

2. **`server/src/lib/data-dir.ts`** — thêm `PTY_SOCK = join(DATA_DIR, "pty.sock")` và
   `PTY_LOG = join(LOGS_DIR, "pty-daemon.log")`.

3. **`server/src/pty-daemon/sessions.ts`** (mới) — bê nguyên logic `pty-manager.ts` hiện
   tại sang: `sessions` Map, scrollback ring, `start/attach/write/resize/kill/killAll`.
   Thêm: `totalBytes` mỗi session, `attach(id, listener, since)` chỉ replay phần thiếu,
   và event `exited` để daemon dọn.

4. **`server/src/pty-daemon/index.ts`** (mới) — Fastify trên `PTY_SOCK`:
   - unlink socket cũ trước khi listen, `chmod 0600` sau khi listen;
   - các route ở bảng trên + `/ws/pty/:id`;
   - idle timer: mỗi 60s, nếu `sessions.size === 0` liên tục quá `PTY_IDLE_MS`
     (env, mặc định 600000) → `killAll()`, unlink socket, exit 0;
   - SIGTERM/SIGINT → killAll + unlink + exit (cho `pty:stop`).

5. **`server/src/lib/pty-daemon-spawn.ts`** (mới) — `ensureDaemon()`:
   - ping `GET /health` qua socket; ok → xong;
   - `ECONNREFUSED`/`ENOENT` mà file socket còn → unlink (socket mồ côi) rồi spawn;
   - spawn `tsx server/src/pty-daemon/index.ts`, `detached:true`,
     `stdio:["ignore", ptyLogFd, ptyLogFd]`, `unref()`;
   - ping lại với backoff tới ~5s; thất bại → throw để route trả lỗi rõ ràng.
   - Nếu `health.protocol !== PTY_PROTOCOL`: `sessions === 0` → `POST /shutdown` rồi
     spawn lại; còn session → log warn, chạy tiếp (không giết terminal của người dùng).

6. **`server/src/services/pty-manager.ts`** — viết lại thành **client facade**, giữ nguyên
   tên hàm để nơi gọi khỏi đổi nhiều:
   - `start()` → `POST /sessions`, thành **async**;
   - `kill()` → `DELETE /sessions/:id`, **async**;
   - `isRunning()` / `runningIds()` giữ **đồng bộ**, đọc từ **mirror cache** trong RAM
     (Set các id) — cache được cập nhật bởi một WS `/ws/events` tới daemon (
     `session_started` / `session_exited`) và seed một lần lúc boot bằng `GET /sessions`.
     Giữ đồng bộ là bắt buộc vì `routes/agents.ts:119` gọi `pty.isRunning` bên trong một
     predicate `.find()`, và `routes/terminals.ts:34` gọi trong `.map()`.
   - `write()` / `resize()` **xoá khỏi facade** — sau bước 7 chỉ còn proxy dùng, mà proxy
     nối thẳng tới daemon.
   - `killAll()` chỉ còn dùng cho `pty:stop`, không gắn vào signal handler của server nữa.

7. **`server/src/ws/terminal-ws.ts`** — thành proxy:
   - `assertWsAuthorized` giữ nguyên;
   - `await ensureDaemon()`; daemon không lên → `{t:"error", retryable:true}`;
   - mở WS tới `unix:PTY_SOCK` path `/ws/pty/:id?since=<query>`;
   - daemon đóng vì không có session → forward `{t:"error", retryable:false,
     message:"Terminal is not running (restart the terminal)"}`;
   - pipe hai chiều nguyên frame (binary giữ binary), đóng bên nào thì đóng bên kia;
   - `{t:"exit"}` vẫn do server ghi DB (`status:"exited"`) như hiện tại.

8. **`server/src/index.ts`** — bỏ `killAllPtys()` khỏi signal handler (giữ `killAllRuns()`);
   gọi `ensureDaemon()` lúc boot (không chặn listen — log lỗi rồi để route tự retry).

9. **Đổi callers sang async** (do `start`/`kill` thành async):
   - `services/terminals.ts:32` `createTerminal` → `async` (đang `pty.start` ở dòng 47);
   - callers: `routes/terminals.ts:48`, `routes/agents.ts:122`, `routes/workflows.ts:192`,
     `routes/integrations.ts:166,366` — tất cả đã nằm trong handler async, chỉ thêm `await`;
   - `routes/terminals.ts:65` (`pty.kill`), `:105` (`pty.start` trong restart),
     `services/projects.ts:25` (`pty.kill` trong vòng lặp → `await` tuần tự).

10. **`web/src/features/terminals/TerminalPane.tsx`**:
    - đếm `receivedBytes` trong ref **sống qua các lần reconnect**, gửi kèm
      `?since=` khi `connect()`;
    - xử lý `{t:"reset", offset}` → `term.reset()`, `receivedBytes = offset`;
    - `{t:"error"}` chỉ đặt `fatal = true` khi `retryable !== true`; `retryable` thì
      vẫn backoff như cũ (che được cửa sổ server vừa lên nhưng daemon chưa ping xong).

11. **Scripts** — `server/package.json` + root `package.json`:
    `pty:stop` (POST /shutdown), `pty:restart`, `pty:log` (tail `data/logs/pty-daemon.log`).

12. **Docs** — cùng commit:
    - `README.md:77` đang viết "restart after a server restart resumes via `claude --continue`"
      → không còn đúng, terminal sống sót thẳng;
    - `server/src/services/workflow-runner.ts:930` — comment "pty-manager restores it"
      hiện là mô tả sai (chưa hề có restore); sau thay đổi này nó mới thành đúng, sửa lại
      cho khớp cơ chế thật;
    - `docs/plans/terminal-reconnect.md` — thêm dòng trỏ sang plan này vì giả định
      "PTY chết sau server restart → fatal, không retry" đã thay đổi.

## File chạm

Mới: `server/src/pty-daemon/{index,sessions}.ts`, `server/src/lib/pty-daemon-spawn.ts`.
Sửa: `shared/src/ws-protocol.ts`, `server/src/lib/data-dir.ts`,
`server/src/services/pty-manager.ts`, `server/src/ws/terminal-ws.ts`,
`server/src/index.ts`, `server/src/services/terminals.ts`, `server/src/services/projects.ts`,
`server/src/routes/{terminals,agents,workflows,integrations}.ts`,
`web/src/features/terminals/TerminalPane.tsx`, `server/package.json`, `package.json`,
`README.md`, `docs/plans/terminal-reconnect.md`.

## Edge cases

- **Socket mồ côi** (daemon bị `kill -9`, file `.sock` còn): connect ra ECONNREFUSED →
  unlink → spawn lại. Không được nhầm với daemon đang bận.
- **Hai server cùng boot** (dev + prod): cả hai `ensureDaemon()` → một cái listen thắng,
  cái kia nhận `EADDRINUSE` → ping lại thay vì spawn tiếp.
- **Daemon chết giữa chừng**: mirror cache bẩn → khi WS events đứt, đánh dấu cache stale
  và seed lại bằng `GET /sessions` sau khi `ensureDaemon()` thành công.
- **Version skew**: server code mới + daemon cũ đang giữ session của người dùng → chạy
  tiếp và log warn, tuyệt đối không tự giết session để "nâng cấp".
- **Idle-exit đúng lúc người dùng mở tab**: đóng cửa sổ đua bằng cách reset idle timer
  ngay tại `POST /sessions` **và** tại lúc accept WS attach.
- **`data/` nằm trên path dài** — Unix socket giới hạn ~104 ký tự trên macOS. Nếu
  `PTY_SOCK` vượt ngưỡng → fallback sang `/tmp/claude-station-<hash>.sock` và log.
- **Worktree terminal**: cwd `data/worktrees/<id>` do server tạo trước khi gọi
  `POST /sessions` — thứ tự này giữ nguyên, daemon không đụng git.
- **Env set / extraEnv**: vẫn resolve ở server rồi gửi kèm body; daemon chỉ áp
  `childBaseEnv()` của **chính nó** — nên daemon phải được spawn với env đã sạch
  `STATION_ONLY`, nếu không `PORT=3789` rò vào mọi shell con.

## Verify

- `npm run check` (typecheck + lint + test) pass.
- Test tay đúng triệu chứng gốc: mở tab Claude, cho nó chạy, rồi `touch server/src/index.ts`
  vài lần → pane chỉ chớp "reconnecting" rồi trở lại, **không** có banner "Terminal is not
  running", **không** có nội dung bị nhân đôi trong scrollback.
- Ctrl+C server rồi `npm run dev -w server` lại → terminal cũ vẫn gõ được.
- `npm run pty:stop` → mọi terminal thành `orphaned`, không còn process node/shell mồ côi
  (`ps aux | grep pty-daemon`).
- Để 0 terminal trong >10 phút → daemon tự thoát, `data/pty.sock` biến mất.

## Cần confirm trước khi code

1. `PTY_IDLE_MS` mặc định **10 phút** — ok hay muốn dài/ngắn hơn?
2. Có muốn hiện trạng thái daemon (pid, uptime, số session) trong **Settings → Doctor**
   không? Chưa nằm trong các bước trên; nếu cần mình thêm 1 bước và 1 route.
