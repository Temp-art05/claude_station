# Reach — kéo kho của station vào một terminal bất kỳ

> Plan con của [`claude-station.md`](claude-station.md). Mọi path tương đối theo `<repo>`.
> Trạng thái: **R0–R5 impl xong 2026-09-15**.

## Vấn đề

Tab Claude (Agent SDK) với tới mọi kho của station, vì `buildWorkspaceContext()` nhét repo index,
knowledge, memory, shared-memory vào `systemPrompt.append` mỗi turn.

Terminal thì **không**. Nó nhận đúng một file context lúc spawn (`--append-system-prompt-file`) rồi
thôi. Trong lúc chạy, một session terminal không biết: ai vừa sửa file này, vì sao chốt cách làm này,
ticket nói gì, plan đang chạy là plan nào, lệnh test của repo này gõ ra sao. Người dùng thành đường
truyền: mở tab khác, copy, dán lại.

Mà terminal mới là bề mặt dùng hằng ngày.

## Ràng buộc quyết định cả thiết kế

**Trong terminal, `@` không phải của mình.** PTY chạy `claude` thật; byte đi thẳng vào CLI, và CLI
đã dùng `@` cho đường dẫn file. Không có chỗ nào để resolve phía server như `mentions.ts` đang làm
cho workflow step — ở đó text là của mình cho tới lúc step chạy.

Nên Reach **không giành phím với CLI**. Nó dùng cơ chế CLI đã mở sẵn.

## Cơ chế: `` !`command` `` trong skill

Skill-as-command hỗ trợ chạy shell và **chèn output vào nội dung trước khi Claude đọc**. Cộng
`arguments:` có tên, `disable-model-invocation`, và `allowed-tools` để không bật modal duyệt.

```yaml
---
name: reach-ticket
description: Kéo một issue Jira vào hội thoại.
disable-model-invocation: true
arguments: [key]
allowed-tools: Bash(curl *)
---
!`curl -sS -H "x-cs-token: $CS_TOKEN" "$CS_URL/api/reach/resolve?kind=ticket&q=$0&cwd=$PWD"`
```

Ba hệ quả đáng giá:

1. **Không tốn turn.** Output nằm sẵn trong prompt; không phải chờ Claude quyết định gọi MCP rồi đợi
   vòng thứ hai.
2. **Sống khi detach.** Không phụ thuộc web UI — tmux hand-off sang Terminal.app vẫn gõ được.
3. **Agent khác cũng dùng được.** `SKILL.md` giờ là định dạng chung; B2a có ý nghĩa hơn.

## Ba cửa, làm cửa một trước

| Cửa                          | Là gì                                                                         | Khi nào       |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------- |
| **1. `/reach-*`**            | Lệnh sinh tự động, resolve ở server                                           | **Bây giờ**   |
| 2. `@` vào thư mục gương     | `<repo>/.station/` toàn symlink + file materialise, để `@` native tự complete | **Xong (R4)** |
| 3. Picker trong terminal web | Chặn một sigil **không đụng CLI** (`;;`), gõ hộ lệnh của cửa 1                | **Xong (R5)** |

Đặt tên theo **vấn đề** chứ không theo cơ chế: cả ba cửa là cùng một tính năng, khác phím. Gọi nó là
"Commands" hay "Slash" thì sai ngay khi làm cửa 2.

## Bộ lệnh

Tiền tố `reach-` để không đụng 22 skill người dùng đang có. Gõ `/re` là CLI tự complete.

| Lệnh                    | Trả về                                                                                                            | Claude tự gọi được? |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/reach`                | Định hướng: project, repo, command, env set (**chỉ tên biến**), số lượng từng kho, 5 quyết định gần nhất trên bus | ✗                   |
| `/reach-cmds`           | `path_commands` của repo kèm dòng lệnh chính xác và cwd                                                           | ✓                   |
| `/reach-file <path>`    | Turn nào sửa gần nhất, prompt sinh ra nó, commit kèm theo                                                         | ✓                   |
| `/reach-why <chủ đề>`   | Decision + fact khớp chủ đề, từ bus và memory                                                                     | ✓                   |
| `/reach-ticket <key>`   | Issue Jira dạng markdown                                                                                          | ✗                   |
| `/reach-fail`           | Mọi `failure` trên bus + note gotcha                                                                              | ✓                   |
| `/reach-plan`           | Plan đang active của project                                                                                      | ✗                   |
| `/reach-last`           | Đuôi phiên trước trong cùng project                                                                               | ✗                   |
| `/reach-kb <q>`         | FTS knowledge → đường dẫn + trích đoạn                                                                            | ✓                   |
| `/reach-note <text>`    | **Lệnh ghi duy nhất** — lưu một memory note                                                                       | ✓                   |
| `/reach-commit <sha>`   | Commit đó để làm gì: prompt phía sau, ai làm, đổi file nào                                                        | ✓                   |
| `/reach-prior <chủ đề>` | Việc kiểu này đã làm ở đây chưa, và kết thúc ra sao                                                               | ✓                   |
| `/reach-sprint`         | Issue Jira đang gán cho mày trong sprint mở                                                                       | ✗                   |
| `/reach-pr <n>`         | Pull request kèm review và comment                                                                                | ✗                   |

**Chia đôi model-invocable là điểm chính**, không phải chi tiết phụ. Lệnh _đổ ngữ cảnh_ (`/reach`,
`/reach-plan`, `/reach-last`) để `disable-model-invocation: true` — Claude tự gọi thì phí token. Lệnh
_tra cứu_ (`/reach-file`, `/reach-why`, `/reach-fail`, `/reach-kb`) thì **để Claude tự gọi**: nó nên
tự với tới khi sắp sửa một file lạ hoặc sắp lặp lại một cách đã hỏng. Đó là chỗ biến bộ lệnh từ phím
tắt cho người thành giác quan cho agent.

## Ba luật an toàn

1. **Không bao giờ chèn giá trị env.** `/reach` liệt kê tên biến, không bao giờ giá trị. Kho này có
   biến đánh dấu `secret` thật.
2. **Mọi output đi qua `redact()`** trước khi trả về — cùng đường mà ledger đang dùng.
3. **Cap byte mỗi lệnh.** Quá thì cắt và nói rõ là đã cắt. Tiền lệ: `prompt.knowledgeIndexBytes`.

Cộng một luật về token: `CS_TOKEN` chỉ vào env của PTY do station spawn. `childBaseEnv()` đang **lọc
bỏ** `CLAUDE_STATION_TOKEN`, và đúng như vậy — Reach dùng tên khác, đưa vào có chủ đích, không phải
rò rỉ qua kế thừa.

## Các bước

- **R0 — resolver.** `services/reach.ts`: `resolve({kind, q, cwd})` → `{text, truncated}`. Một
  endpoint `GET /api/reach/resolve` cho mọi lệnh. cwd → project bằng luật longest-prefix đã có.
- **R1 — sinh skill.** `services/reach-skills.ts`: viết `SKILL.md` cho từng lệnh vào `data/skills/`
  và symlink như mọi skill khác. Chạy lúc boot khi `reach.enabled`, ghi đè bản cũ theo version.
- **R2 — env cho PTY.** `CS_URL` + `CS_TOKEN` vào env của terminal `claude`.
- **R3 — mở rộng bộ lệnh** tới hết bảng trên.
- **R4 — cửa 2**: thư mục gương `<repo>/.station/` + gitignore + dọn symlink chết.
- **R5 — cửa 3**: picker `;;` trong TerminalPane.

**File dự kiến chạm:** `services/reach.ts` (mới), `services/reach-skills.ts` (mới),
`routes/reach.ts` (mới), `services/terminals.ts` (env), `lib/data-dir.ts`, `shared/src/types.ts`
(setting), `server/src/index.ts` (boot), web `SettingsPage.tsx` (toggle + nút cài lại).

## Edge case

- **Server chưa chạy.** Lệnh gõ trong terminal khi station tắt → `curl` fail → theo tài liệu, exit
  code khác 0 **huỷ luôn lần gọi skill**. Phải `curl -sS --max-time` và luôn exit 0, in ra một dòng
  người đọc hiểu được thay vì để CLI nuốt.
- **Terminal mở ngoài station** (Terminal.app tự bật) không có `CS_TOKEN`. Lệnh phải nói rõ lý do,
  không phải im lặng.
- **cwd không thuộc project nào** → nói thẳng, đừng đoán project gần nhất.
- **Tên skill đụng nhau**: `linkSkillTree` né bằng hậu tố `-2`, mà Reach thì phải ghi đè đúng bản của
  nó. Dùng đường ghi riêng có `overwrite: true`, không đi qua de-dup.
- **Token xoay** (xoá `data/.token`) làm mọi terminal đang mở hỏng lệnh — chấp nhận, nói rõ ở lỗi.
- **Quote trong đối số**: `$0` đi thẳng vào dòng `curl`; phải URL-encode phía skill hoặc nhận bằng
  POST body. Đây là chỗ dễ sinh lỗi shell injection nhất của cả tính năng.

## Cần confirm

1. **Tiền tố `reach-`** — dài hơn `st-` bốn ký tự, đổi lại không đụng skill có sẵn. Giữ chứ?
2. **Cài lệnh lúc boot** hay để một nút "Install Reach commands" trong Settings? Tao nghiêng về boot
   - toggle, vì bộ lệnh mà phải nhớ đi bật thì không ai bật.
3. **`/reach-note` có nên tồn tại không** — nó là lệnh ghi duy nhất, và `memory_write` qua MCP đã làm
   được việc đó cho tab Claude. Giữ vì terminal không có MCP modal, hay bỏ cho gọn?

## Changelog

- 2026-09-15: bản đầu; chốt tên **Reach**, chốt cơ chế `` !`command` `` thay vì giành phím `@`.
- 2026-09-15: **impl R0–R2.** `services/reach.ts` (resolver + `projectForCwd`), `services/reach-skills.ts`
  (sinh 9 `SKILL.md`, symlink, `reachEnv`), `routes/reach.ts`, env `CS_URL`/`CS_TOKEN` cho terminal
  `claude`, setting `reach.enabled` + toggle trong Settings, cài lúc boot.
  Đã chạy thật: `/reach`, `/reach-file`, `/reach-why`, `/reach-cmds` trả đúng dữ liệu của repo này.
  **Xác nhận được điều quan trọng nhất của thiết kế:** đúng 5 lệnh model-invocable hiện ra trong danh
  sách skill của một session Claude, 4 lệnh `disable-model-invocation` thì không — chia đôi hoạt động.
  Dùng `--data-urlencode` cho mọi đối số, nên khoảng trắng và `&` trong topic không thành lỗi shell.
- 2026-09-15: **impl R3** — thêm `/reach-commit`, `/reach-prior`, `/reach-note`, `/reach-sprint`,
  `/reach-pr`; đủ **14 lệnh**. `REACH_VERSION` lên 2 nên boot tự ghi đè bản cũ.
  Ba quyết định trong lúc làm:
  · **`/reach-note` được để model tự gọi.** Terminal `claude` **không có MCP** (`mcpConfigFile` chỉ
  truyền cho workflow step) nên `memory_write` không tồn tại ở đó; không có lệnh này thì mọi thứ một
  phiên terminal học được đều chết theo tab. Nhất quán với `MEMORY_TOOLS_NO_PROMPT` — app đã chốt
  rằng agent ghi memory thì không cần modal.
  · **`/reach-note` là POST**, và Fastify không parse `x-www-form-urlencoded` (không có
  `@fastify/formbody`). Thêm một `addContentTypeParser` 5 dòng thay vì thêm dependency — thuần cộng
  thêm, vì content-type này trước đó là 415.
  · **`/reach-pr` từ chối đoán repo** khi có nhiều repo cấu hình, bắt gõ `owner/name#123`.
  Đã chạy thật cả 5: `/reach-prior` tìm đúng turn cũ, `/reach-commit` đọc được checkpoint orphan và
  nói thẳng là orphan, `/reach-note` lưu được text có dấu nháy, `&` và xuống dòng mà không vỡ shell.
- 2026-09-15: **impl R4 + R5, đóng cả ba cửa.** Thêm `/reach-doc` (15 lệnh).
  · **R4** `services/reach-mirror.ts`: `<repo>/.station/` với `knowledge/` là **symlink** (file đã có
  thật, hai bản là thừa) còn `plans/`, `memory/`, `tickets/` là **materialise** (không trỏ vào một
  row SQLite được). `/reach-ticket` ghi luôn ra `tickets/` để lần sau nhắc tới nó là con trỏ chứ
  không phải dán lại cả issue. Dựng lại mỗi lần mở terminal `claude`.
  **Ignore đặt ở `.git/info/exclude`, không phải `.gitignore`** — cùng tác dụng mà không làm bẩn một
  file đang được track, và không xung đột lúc pull. Kiểm chứng trên chính repo này: `git status`
  trống, `.gitignore` nguyên vẹn.
  Dựng lại kiểu **rebuild chứ không reconcile**: chỉ có cách đó mới không bao giờ để sót symlink
  chết — mà một link chết vẫn complete dưới `@` rồi mới fail lúc đọc, đọc lên như app nói dối.
  · **R5** picker `;;` trong `TerminalPane`. Ký tự `;` đầu **đã được forward và echo** rồi mới biết có
  cái thứ hai (PTY không có lookahead), nên mở picker phải gửi kèm `\x7f` xoá nó đi. Chọn xong thì
  **gõ vào, không gửi** — cùng luật "never auto-sent" của cả app.
