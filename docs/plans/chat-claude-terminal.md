# Chat tab → nhúng terminal chạy `claude` CLI

## Mục tiêu

UI tab Chat (SDK chat) bị đánh giá kém. Thay hẳn nội dung tab Chat bằng khung terminal thật
(xterm + PTY, như tab Terminals) tự chạy `claude` CLI trong repo được chọn — nhiều tab con,
scrollback, restart. Đã confirm với người dùng:

- **Thay hẳn**: tab Chat trở thành danh sách terminal `claude`. Component `ChatTab` giữ lại
  **chỉ** cho Agent workspace (`AgentWorkspace.tsx` render `<ChatTab pinnedSessionId>`),
  workflow runner không đổi.
- **Jira/GitHub "Work on this with Claude"**: mở terminal `claude` mới trong project, tự
  **gõ sẵn** seed context vào ô nhập của claude CLI (bracketed paste, KHÔNG tự submit).

## Phạm vi / thiết kế chốt

- **Spawn claude**: `spawn(userShell, ["-l", "-i", "-c", command])`; create → `command = "claude"`,
  restart (orphaned) → `"claude --continue || claude"`. Login+interactive shell để PATH
  (nvm/asdf/…) resolve được `claude`. Claude thoát → PTY thoát → pipeline exit sẵn có xử lý.
- **DB**: thêm cột `kind text NOT NULL DEFAULT 'shell'` (`shell|claude`) vào bảng `terminals`,
  migration drizzle-kit (`npm run db:generate` → `server/drizzle/0005_*.sql`). Row cũ tự thành
  `shell`.
- **API**: `terminalInputSchema` thêm `kind?`; `GET /api/projects/:id/terminals?kind=` filter;
  restart honor `kind`. Tách logic POST thành service `createTerminal()` để integrations dùng chung.
- **Seed**: client-side qua WS terminal sẵn có — sau binary frame đầu tiên + ~300ms, gửi
  `{t:'input'}` với `"\x1b[200~" + seed(\n-normalized) + "\x1b[201~"` (bracketed paste, không
  trailing `\r`).
- **Web**: parametrize `TerminalsTab` bằng prop `kind` (default `shell`) thay vì viết component
  mới; tab `chat` (giữ value `chat` để deep-link cũ sống) render `<TerminalsTab kind="claude">`,
  label đổi thành "Claude". `TerminalPane` thêm props `seedText?/onSeedSent?` (giữ qua ref để
  không recreate term).
- **Integrations**: 2 endpoint work-with-claude tạo terminal `kind:'claude'` (thay vì chat
  session), trả `{terminalId, seed}`; web navigate `?tab=chat&terminal=<id>&seed=…`, tab Claude
  đọc param 1 lần rồi strip khỏi URL.

## Các bước

1. `shared/src/types.ts`: `terminalSchema` + `kind` (default `shell`); `terminalInputSchema` + `kind?`.
2. `server/src/db/schema.ts`: cột `kind`; chạy `npm run db:generate` → commit migration 0005.
3. `server/src/services/pty-manager.ts`: `StartOptions.command?`; args `["-l","-i","-c",command]` khi có.
4. `server/src/services/terminals.ts` (mới): `createTerminal(projectId, input)` (chuyển `resolveCwd`
   + body POST sang đây; title `Claude N`/`Terminal N` đếm theo kind).
   `server/src/routes/terminals.ts`: GET filter `?kind=`, POST gọi service, restart truyền
   `command` theo kind.
5. `server/src/routes/integrations.ts`: Jira + GitHub work-with-claude → `createTerminal(kind:'claude')`
   (giữ worktree checkbox), trả `{terminalId, seed}`.
6. `web/src/features/terminals/hooks.ts`: `useTerminals(projectId, kind)` — key + query param.
7. `web/src/features/terminals/TerminalPane.tsx`: props `seedText/onSeedSent` qua ref; gửi seed
   sau first output + 300ms, guard `sentOnce`.
8. `web/src/features/terminals/TerminalsTab.tsx`: prop `kind`, label/copy theo kind, đọc
   `?terminal=&seed=` (chỉ kind claude) rồi strip URL.
9. `web/src/pages/ProjectDetailPage.tsx`: tab `chat` label "Claude" → `<TerminalsTab kind="claude">`;
   `web/src/features/integrations/WorkWithClaude.tsx`: navigate theo contract mới.
10. Docs cùng commit: `docs/plans/claude-station.md` (mục Chat, Jira flow, schema terminals),
    `README.md` (bảng "What it does").

## Edge case

- Row terminal cũ → `kind='shell'`, ở nguyên tab Terminals.
- Server restart → claude terminal thành `orphaned`; Restart chạy `claude --continue || claude`
  cùng cwd.
- Claude `/exit`/crash → PTY exit → row `exited`, tab biến khỏi list.
- Seed nhiều dòng: bracketed paste + normalize `\r\n?`→`\n`, không auto-submit; param strip sau
  mount + `onSeedSent` clear state → không gửi lại khi đổi tab/reconnect.
- Seed tới terminal orphaned: bỏ qua (chỉ gửi khi pane running có output).

## Đánh đổi chấp nhận (đã confirm)

- Hội thoại trong claude terminal **không** persist từng message vào DB → không vào search FTS
  (lịch sử chat SDK cũ vẫn còn trong DB/search).
- Không còn modal duyệt tool của app cho luồng này (CLI tự có TUI approve).
- Không có MCP tools `station` (jira_*/excel_*/knowledge_*) trong CLI session.
- Resume qua `claude --continue`/`--resume` của CLI thay cho `sdkSessionId`.

## Verify

1. `npm run check` pass; DB cũ + DB mới đều boot (migration 0005).
2. Tab Claude: "+ Claude" → claude CLI chạy trong xterm, gõ/resize/reload-scrollback OK.
3. Tab Terminals chỉ còn shell; tab Claude chỉ claude.
4. `/exit` → tab biến mất; restart server → orphaned → Restart resume được hội thoại.
5. Jira/GitHub "Work on this with Claude" → nhảy vào tab Claude, seed nằm sẵn trong composer
   (kể cả nhiều dòng), chưa gửi; URL sạch param. Worktree checkbox vẫn chạy.
6. Agent workspace vẫn render ChatTab SDK bình thường; workflows không ảnh hưởng.
7. Env set chọn lúc tạo thấy được trong claude (`!echo $VAR`).
