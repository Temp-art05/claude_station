# Mở terminal của app ra Terminal.app (tmux-backed)

## Mục tiêu

Một nút trên tab **Claude** và tab **Terminals** để đưa session đang chạy trong app ra
**một cửa sổ Terminal.app thật** — cùng một process, cùng một hội thoại `claude`, không
phải bắt đầu lại. Tab **Commands** có nút hand-off riêng: chạy đúng command đó trong
Terminal.app của bạn.

Vấn đề hôm nay: PTY do server sở hữu (`node-pty` trong process Fastify,
`server/src/services/pty-manager.ts:47`). Không có cách nào attach một PTY của process
khác, nên "kéo tab ra ngoài" là bất khả thi với kiến trúc hiện tại.

Cách sửa (đã chốt): **mọi PTY chạy bên trong một tmux session**. App attach vào nó,
Terminal.app cũng attach vào chính nó. Export = mở Terminal attach vào cùng session rồi
detach client của app.

```
hôm nay   browser ──WS──> server ──node-pty──> zsh -l -i -c 'claude …'

sau đây   browser ──WS──> server ──node-pty──> tmux attach -t cs-<id> ─┐
                                                                       ├─> zsh -l -i -c 'claude …'
          Terminal.app ─────────────────────── tmux attach -d -t cs-<id> ┘
```

## Phạm vi (đã chốt)

- **Dual-mode**: setting `terminal.tmux` (default on) + tự dò binary. Không có tmux →
  spawn trực tiếp như hôm nay, nút export disabled kèm tooltip `brew install tmux`.
- **Nút X đóng tab = `kill-session`** — process chết thật, giữ đúng ý nghĩa hiện tại.
  Chỉ nút Export mới detach mà không giết.
- **Server SIGINT/SIGTERM chỉ detach**, không giết session → terminal sống qua mọi lần
  `tsx watch` reload. Đây là phần lợi ích chính của `docs/plans/pty-daemon.md`, đạt được
  mà không cần daemon; plan đó cần được ghi chú lại.
- **`mouse on`** trong tmux: lăn chuột = cuộn lịch sử tmux (history-limit 100000).
- **Commands là hand-off, không tmux**: một command run không phải session tương tác;
  điểm của nút là "chạy đúng thứ này trong terminal của tôi".
- Không đụng: Agent SDK chat (`services/claude-session.ts`), `services/commands.ts` runner.

## Kiến trúc

### tmux server riêng, config riêng

- Socket riêng `-L claude-station` → không bao giờ đụng tmux server của người dùng.
- Config riêng `data/tmux.conf`, app tự ghi lúc boot (ghi đè mỗi lần, đây là file của app):

  ```tmux
  set -g prefix C-]          ; unbind C-b   # C-b là backward-char của readline
  set -g status off
  set -g mouse on
  set -g history-limit 100000
  set -g escape-time 10
  set -g focus-events on
  set -g default-terminal "screen-256color"
  set -as terminal-features ",*:RGB"        # claude TUI dùng truecolor
  set -g allow-passthrough on
  set -g window-size latest                 # client mới nhất quyết định size
  setw -g aggressive-resize on
  set -g set-titles off ; set -g bell-action none
  ```

  Không set `destroy-unattached` (phải là off) và giữ `remain-on-exit off` để
  `claude` thoát là session chết → row thành `exited` như hôm nay.

- tmux server được start bằng env đã sạch: `childBaseEnv()` (`server/src/lib/child-env.ts`).
  Env của từng session truyền tường minh bằng `new-session -e K=V` (tmux ≥ 3.2), **không**
  dựa vào env thừa hưởng của server.

### Vòng đời một terminal

| Hành động | Việc thực sự làm |
|---|---|
| Tạo terminal | `tmux new-session -d -s cs-<id> -c <cwd> -x 200 -y 50 -e K=V … "<shell> -l -i -c <cmd>"` rồi node-pty spawn `tmux -L claude-station attach -t cs-<id>` |
| Browser reload | pty còn sống → không đổi gì: ring buffer replay như hôm nay |
| Restart (orphaned) | session còn → chỉ attach lại, `command` bị bỏ qua; session mất → tạo mới bằng `claude --continue` như hôm nay |
| Export | ghi launcher `.command`, `open -a <terminal.app>`, launcher chạy `tmux attach -d` (tự đá client của app), server `pty.kill` cho chắc |
| X (đóng tab) | `tmux kill-session -t cs-<id>` + DELETE route như cũ |
| Server dừng | chỉ kill client attach, session sống |

`pty.isRunning(id)` giữ nguyên nghĩa "app đang attach". Thêm `tmuxHasSession(id)` cho
nghĩa "việc vẫn đang chạy" — dùng để banner orphaned nói đúng chuyện.

### Mở cửa sổ Terminal

Dùng **launcher script** thay vì `osascript … do script "…"`: tránh sạch chuyện escape
command nhiều lớp qua AppleScript, và `open -a` chạy được với cả iTerm2/Ghostty.

`data/launchers/<id>.command`, mode `0700`:

```sh
#!/bin/zsh
cd '<cwd>'
exec tmux -L claude-station attach -d -t 'cs-<id>'
```

Rồi `execFile("open", ["-a", setting("terminal.app"), launcherPath])` — đúng pattern
`POST /api/open-in-ide` đang dùng (`server/src/routes/attachments.ts:70-85`).

## Lệch so với plan ban đầu (đã impl theo bản này)

1. **Bỏ `refresh-client`, giữ nguyên ring-buffer replay.** Plan ban đầu định bỏ replay cho
   session tmux để tránh nhân đôi. Không cần: ring buffer thuộc từng `Managed`, mà `Managed`
   được tạo mới mỗi lần `pty.start` → lúc tmux vẽ full screen (attach mới) ring đang rỗng.
   Còn lúc browser reload thì pty vẫn sống, tmux không vẽ lại, nên replay vẫn là thứ duy nhất
   dựng lại màn hình. Thêm nữa `refresh-client -t` nhận *client tty*, không nhận session name,
   nên sẽ phải list-clients trước — thêm phức tạp mà không giải quyết vấn đề gì thật.
2. **Thêm bước không có trong plan: `ws/terminal-ws.ts` phân biệt detach vs exit.** Thiếu nó,
   `pty.kill` lúc export sẽ làm row thành `exited` (biến mất khỏi UI, mất đường Reattach).
   Giờ `onExit` hỏi `pty.sessionAlive(id)`: session còn → `orphaned`, session mất → `exited`.
   Cùng lúc xử lý luôn `prefix d` gõ trong app và client khác giành session.
3. **Route của Commands là `POST /api/projects/:id/commands/open-in-terminal`** (không phải
   `/api/paths/:pathId/...`) để đối xứng với `POST /api/projects/:id/commands/run` sẵn có.
4. **Prune là `server/src/tools/tmux-cli.ts`** (chạy qua `npm run tmux:ls` / `tmux:prune`) —
   cần đọc DB mới biết session nào không còn row nào trỏ tới; giữ lại session của row
   `orphaned` vì đó chính là trạng thái Reattach được.

## Các bước

1. **`shared/src/types.ts`** (`appSettingsSchema`, dòng 1070):
   - `"terminal.app": z.string().default("Terminal")`
   - `"terminal.tmux": z.boolean().default(true)`
   - `terminalSchema`: thêm `tmuxAlive: z.boolean().optional()` (field tính lúc đọc, giống
     `attached` của `knowledgeItemSchema`).

2. **`server/src/lib/data-dir.ts`**: `TMUX_CONF = join(DATA_DIR, "tmux.conf")`,
   `LAUNCHERS_DIR = join(DATA_DIR, "launchers")`; thêm vào danh sách dir được tạo lúc boot.

3. **`server/src/lib/tmux.ts`** (mới, pure + testable như `lib/claude-cli.ts`):
   - `sessionName(id)` → `cs-<id>`; `TMUX_BIN`, `SOCKET = "claude-station"`.
   - `newSessionArgs({id, cwd, env, command, shell, cols, rows})` → `string[]`
   - `attachArgs(id, {steal})` → `["-L", …, "attach", …]`
   - `available()`: probe `tmux -V` một lần rồi cache (kèm parse version, cảnh báo < 3.2 vì
     `-e` không có → fallback `set-environment` từng biến).
   - `hasSession(id)`, `killSession(id)`, `listSessions()`, `liveTerminalIds()`,
     `launcherLine(id)` — bọc `execFileSync` ngắn.
   - `writeConfig()`: ghi `data/tmux.conf` (nội dung ở trên) lúc boot.

4. **`server/src/services/pty-manager.ts`**:
   - `start()`: nếu tmux bật + có sẵn → `ensureSession()` (tạo nếu chưa có, bỏ qua
     `command` nếu đã có) rồi spawn `tmux attach` trực tiếp (không bọc `zsh -c`);
     ngược lại giữ nguyên nhánh cũ. Ghi `tmuxBacked: boolean` vào `Managed`.
   - `attach()`: **không đổi** — replay ring buffer như cũ (xem mục "Lệch so với plan").
   - `kill(id)` giữ nghĩa "kill client attach". Thêm `killSession(id)` = detach + `kill-session`.
   - `killAll()` chỉ kill client (session sống) — xem bước 8.
   - Thêm `tmuxEnabled()`, `sessionAlive(id)`, `sessionAliveIds()`, `isTmuxBacked(id)`.

5. **`server/src/routes/terminals.ts`**:
   - `GET …/terminals` (dòng 28-36): row `running` mà không có pty → `orphaned` **+**
     `tmuxAlive: tmuxHasSession(t.id)`.
   - `DELETE /api/terminals/:id` (dòng 63): `pty.killSession(id)` thay `pty.kill(id)`.
   - `POST /api/terminals/:id/export` (mới): 400 nếu tmux tắt/không có, 409 nếu row không
     `running` hoặc PTY này được tạo trước khi bật tmux (không có session) kèm message
     "restart terminal này trước"; ghi launcher, `open -a`, `pty.kill(id)`, ghi
     `workHistory` kind `terminal_exported`, trả `{ opened, session }`.
   - `restart` (dòng 88-125): không đổi logic, chỉ thêm comment — `ensureSession` đã lo
     việc "session còn thì attach lại".

6. **`server/src/lib/open-terminal.ts`** (mới): `writeLauncher(name, lines[])` (0700,
   dọn launcher cũ > 1 giờ) + `openWith(app, file)`. Dùng chung cho terminals và commands.

7. **`server/src/services/commands.ts` + `routes/commands.ts`**:
   - Tách `resolveCommandTarget(pathCommandId, projectId)` từ đầu `startRun()` (dòng 58-74)
     → trả `{ cmd, path, cwd }`; `startRun` gọi lại nó (không nhân đôi lookup).
   - `POST /api/paths/:pathId/commands/:commandId/open-in-terminal` (mới): launcher gồm
     `cd`, `export` env của env-set, chính `cmd.command`, rồi `exec $SHELL -l` để cửa sổ
     không tự đóng. Trả `{ opened }`.

8. **`server/src/index.ts:137`**: `killAllPtys()` → chỉ detach khi tmux bật (giữ
   `killAll()` nguyên nghĩa cũ cho nhánh non-tmux). Boot: `tmux.writeConfig()`.
   Thêm script `tmux:ls` / `tmux:prune` (`server/package.json` + root) để dọn session
   không còn row nào trỏ tới.

9. **`server/src/routes/settings.ts`**: doctor thêm `probe("tmux", ["-V"])` →
   `{ tmux: {ok, detail} }` (dòng 33-37).

10. **Web**:
    - `web/src/features/terminals/hooks.ts`: `useExportTerminal(projectId)`.
    - `web/src/features/terminals/TerminalsTab.tsx`: nút `ExternalLink` "Open in Terminal"
      trước nút `+ Claude` (dòng 141), disabled khi không có tab running hoặc doctor báo
      thiếu tmux; banner orphaned (dòng 178-192) đọc `tmuxAlive` → "Đang chạy trong
      Terminal.app — Reattach" thay vì "output đã mất".
    - `web/src/features/commands/{hooks,CommandsTab}.tsx`: icon button mỗi command,
      tooltip nói rõ **run này app không ghi log / không kill / không timeout được**.
    - `web/src/pages/SettingsPage.tsx`: Input `terminal.app` cạnh "Open files with"
      (dòng 113-122) + dòng tmux trong Doctor.

11. **Docs (cùng commit)**:
    - `README.md:77` — "restart after a server restart resumes with `claude --continue`"
      không còn đúng: terminal sống qua restart, restart là attach lại. Thêm mục tmux
      (yêu cầu `brew install tmux`, prefix `C-]`, cách detach).
    - `docs/plans/pty-daemon.md` — ghi chú: phần "sống sót qua server restart" đã được
      giải quyết bằng tmux, daemon chỉ còn cần nếu muốn bỏ hẳn phụ thuộc tmux.
    - `docs/plans/terminal-reconnect.md` — giả định "PTY chết sau server restart" đã đổi.

12. **Test** (`server/src/lib/__tests__/tmux.test.ts`, theo mẫu `claude-cli.test.ts`):
    args của `new-session`/`attach` (quoting, `-e`, `-c`, thứ tự), nội dung launcher
    (escape path có dấu nháy), parse version cho nhánh `< 3.2`.

## File chạm

Mới: `server/src/lib/tmux.ts`, `server/src/lib/open-terminal.ts`,
`server/src/tools/tmux-cli.ts`, `server/src/lib/__tests__/tmux.test.ts`.
Sửa: `shared/src/types.ts`, `server/src/lib/data-dir.ts`,
`server/src/services/pty-manager.ts`, `server/src/services/commands.ts`,
`server/src/routes/{terminals,commands,settings}.ts`, `server/src/services/projects.ts`,
`server/src/ws/terminal-ws.ts`, `server/src/index.ts`,
`server/package.json`, `package.json`,
`web/src/features/terminals/{TerminalsTab.tsx,hooks.ts}`,
`web/src/features/commands/{CommandsTab.tsx,hooks.ts}`, `web/src/pages/SettingsPage.tsx`,
`README.md`, `docs/plans/{pty-daemon,terminal-reconnect}.md`.

## Edge cases

- **Không có tmux / version < 3.2**: dò một lần, cache; PTY spawn như hôm nay, nút export
  disabled. Version < 3.2 vẫn dùng được nhưng env phải set qua `set-environment`.
- **Terminal tạo trước khi bật tmux**: không có session → export trả 409 "restart trước".
- **Export hai lần / export khi đã có client khác**: `attach -d` đá client cũ, vô hại.
- **Đóng cửa sổ Terminal**: client chết, session sống, row vẫn `orphaned` + `tmuxAlive`
  → bấm Restart là quay về trong app. Không tự động giết bất cứ gì.
- **Session mồ côi tích dần** (row đã xoá mà session còn): `npm run tmux:prune`.
- **Scrollback**: tmux chiếm alternate screen nên scrollback của xterm đóng băng —
  `mouse on` bù lại (lăn chuột = copy-mode tmux). Đổi lại: claude TUI không nhận mouse
  event, bôi đen copy phải giữ Option/Shift. Phải ghi vào README.
- **Nhân đôi output khi reload**: đã chặn bằng "không replay ring cho session tmux, dùng
  `refresh-client`" — đúng cái bẫy `docs/plans/pty-daemon.md` đã chỉ ra.
- **Resize**: `window-size latest` + `aggressive-resize` để size theo client mới nhất,
  không bị khoá 80x24 của lần tạo detached.
- **Env secret trong launcher của Commands**: file 0700 dưới `data/` (đã gitignore), dọn
  file > 1 giờ mỗi lần export. Launcher của terminal **không** chứa env (đã nằm trong
  session tmux).
- **`assertPathAllowed`**: export không nhận path từ client, mọi thứ derive từ row —
  cwd vẫn đi qua `assertPathAllowed` như `restart` đang làm.
- **Worktree cwd**: `createWorktree` vẫn chạy trước `pty.start`, tmux chỉ nhận `-c`.
- **Prefix `C-]`**: chọn vì readline/claude TUI không dùng; `C-b`, `C-a` thì có.

## Verify

1. `brew install tmux` (máy hiện chưa có) → `npm run check` (typecheck + lint + test) pass.
2. Mở tab Claude, chạy vài lượt hội thoại → bấm **Open in Terminal**: cửa sổ Terminal.app
   hiện **đúng màn hình đó**, gõ tiếp vào chính hội thoại cũ; tab trong app thành
   orphaned với nút Reattach.
3. Bấm Reattach → session quay về trong app, cửa sổ Terminal bị detach.
4. `touch server/src/index.ts` vài lần (tsx watch reload) → terminal không chết, Reattach
   là có lại; `ps aux | grep tmux` không sinh session rác.
5. Bấm X đóng tab → `tmux -L claude-station ls` không còn `cs-<id>`, process `claude` chết.
6. Tab Terminals: export một shell, kiểm tra history và cwd đúng.
7. Tab Commands: bấm nút → Terminal.app chạy đúng command, xong thì còn shell ở lại cwd;
   app **không** hiện run này trong log (đúng như tooltip nói).
8. Tắt `terminal.tmux` trong Settings (hoặc `brew uninstall tmux`) → tạo terminal mới vẫn
   chạy, nút export disabled với tooltip.

## Đã chốt khi impl

1. "Luôn kill tab trong app" = kill **client attach**; row giữ lại ở `orphaned` + `tmuxAlive`
   với nút **Reattach**. Xoá hẳn row sẽ mất đường quay về và biến session thành rác.
2. Prefix tmux `C-]`, `unbind C-b`.
3. `terminal.app` default `"Terminal"`, đổi được trong Settings → Open terminals with.

## Trạng thái

Impl xong: `npm run typecheck`, `npm run lint`, `npm test` (82 test, gồm
`lib/__tests__/tmux.test.ts`) đều pass. Còn lại là verify tay theo mục trên — cần
`brew install tmux` trước, máy hiện chưa có.
