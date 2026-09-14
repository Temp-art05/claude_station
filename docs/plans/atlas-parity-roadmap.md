# Plan tổng: bù khoảng cách với Atlas + nâng Workflows

> Plan **tổng quát** (roadmap). Mỗi phase dưới đây sẽ có plan con riêng trong `docs/plans/` trước khi impl —
> file này chỉ chốt *làm gì, theo thứ tự nào, vì sao*. Plan con của [`claude-station.md`](claude-station.md).
> Mọi path tương đối theo `<repo>`.
> Trạng thái: **A1 + A2 đã impl xong (2026-09-03)**. Các track còn lại chưa bắt đầu.

## Bối cảnh

Đối chiếu với [pacifio/atlas](https://github.com/pacifio/atlas) (Tauri + Rust, "source control for agents"),
claude-station đang mạnh hơn ở **điều phối công việc** (workflows, commands runner, Jira/GitHub, app agents,
env sets, tmux hand-off) và yếu hơn ở **ghi lại và tái dùng những gì agent đã làm**:

| Atlas có | Mình đang có gì | Khoảng cách thật |
|---|---|---|
| Checkpoint commit↔session | `work_history` (audit feed rời), `chat_messages` (raw JSON) | Không biết commit nào do session nào tạo ra |
| Shared semantic memory | `project_memories` (pinned full + title on-demand) | Không retrieve theo nội dung câu hỏi |
| Session handoff | Không có | Mỗi session bắt đầu từ 0 |
| Mission control usage | Cost chỉ stream ra UI rồi mất | Không có dashboard tiêu thụ |
| Packs từ GitHub | Skills/agents/workflows import thủ công từng cái | Không install được cả bộ |
| Multi-agent qua ACP | Khoá Claude Code (CLI + Agent SDK) | Không chạy được Codex/OpenCode |
| Editor / browser / research / spaces | — | **Cố tình không làm** (§ Không làm) |

Nhận xét quan trọng để định hướng: **mình có một lợi thế Atlas không có.** Atlas phải *đoán* commit thuộc session nào
(observe rồi reconcile). Mình **spawn chính `claude` CLI với `--session-id` do mình cấp**
(`server/src/services/terminals.ts:48`) và mình sở hữu luôn Agent SDK session — nên attribution của mình
có thể chính xác hơn, không phải heuristic.

## Mục tiêu

1. Mọi thứ agent làm đều **truy vấn lại được**: commit nào, session nào, prompt nào, vì sao.
2. Context **tự chảy** giữa các session thay vì user phải nhắc lại.
3. Workflows từ "chuỗi step tuyến tính" thành **cái chạy được không cần ngồi canh**.
4. Không phá kiến trúc hiện tại: không viết engine mới, tái dùng PTY / Agent SDK / MCP / command runner đang có.

## Phạm vi

Ba track chạy song song được, phụ thuộc chéo tối thiểu:

```
Track A — Provenance & context (xương sống, làm trước)
  A1 Session ledger ──┬── A2 Checkpoints ─── A3 Mission control
                      ├── A4 Session handoff
                      └── A5 Memory retrieval

Track B — Ecosystem
  B1 Packs
  B2 Multi-agent (B2a terminal preset → B2b ACP)

Track C — Workflows v2
  C1 DAG + parallel   C2 Gate step   C3 Triggers
  C4 Run → checkpoint (cần A2)   C5 Template + biến   C6 Learn-from-history
```

**Thứ tự đề xuất:** A1 → A2 → (A4 ‖ C1 ‖ B1) → A3 → A5 → C2/C3 → B2 → C4/C5/C6.
Lý do: A1 là nền của 4 feature khác, làm sau thì phải sửa lại cả 4. B1 và C1 độc lập hoàn toàn nên chèn vào
lúc đợi review A2 được.

---

## Track A — Provenance & context

### A1. Session ledger — nền của mọi thứ còn lại ✅ **XONG**

> **Plan chi tiết: [`session-ledger.md`](session-ledger.md)** — L0→L6 xong 2026-09-03.

**Vấn đề.** Hôm nay dữ liệu một session nằm ở hai chỗ khác nhau và không chỗ nào query được theo *file* hay
theo *thời điểm*: SDK session ghi `chat_messages.content` (raw `SDKMessage` JSON, phải parse mới biết nó sửa file gì),
CLI terminal session không ghi gì vào DB cả — transcript nằm ở `~/.claude/projects/` và
`server/src/lib/claude-transcript.ts` hiện chỉ đọc **head + tail** để hiện danh sách.

**Làm gì.** Một *ledger* chung cho cả hai bề mặt, ghi ở mức **turn**:

- `session_turns` — sessionId, seq, thời điểm bắt đầu/kết thúc, prompt preview, model, tokens in/out/cache, costUsd, kết quả.
- `session_files` — turnId, path (tuyệt đối + relative theo repo path), thao tác (read/write/delete), nguồn (`tool` hay `tree`).
- `session_capture` — transcript path, byte offset đã đọc, trạng thái capture (ok/degraded/stopped).

(Tên bảng và cột chốt theo [`session-ledger.md`](session-ledger.md) § Schema.)

Nguồn ghi:
- **SDK session:** hook ngay trong `claude-session.ts` — đã có chỗ đọc `tool_use` (`:122`) và `total_cost_usd` (`:418`),
  chỉ cần ghi xuống thay vì chỉ stream ra UI.
- **CLI terminal:** một *transcript follower* — mỗi terminal `claude` mở ra thì tail file JSONL tương ứng
  (biết được session id vì mình cấp nó). Parse incremental theo dòng, không đọc lại cả file.
- **Backfill:** import transcript CLI cũ (kể cả conversation chạy ngoài app) — tab History đã liệt kê được chúng rồi,
  giờ nạp thêm vào ledger.

**Redaction là bắt buộc, không phải nice-to-have.** Ledger sẽ chứa prompt + tool input, mà env sets của mình có
biến `secret`. Scrub **trước khi ghi disk** (như Atlas): masking theo giá trị secret đã biết
(từ `env_vars` đã mark secret) + pattern chung (token GitHub/Jira, private key, `Bearer …`).

**File dự kiến chạm:** `server/src/db/schema.ts` (3 bảng mới), `server/src/services/session-ledger.ts` (mới),
`server/src/lib/redact.ts` (mới), `server/src/lib/claude-transcript.ts` (thêm parse full/incremental),
`server/src/services/claude-session.ts`, `server/src/services/terminals.ts`, `server/src/services/pty-manager.ts`.

**Edge case:** transcript bị xoá giữa lúc đang follow (tab History có nút xoá thật); một repo mở 2 session cùng lúc;
transcript vài chục MB vì paste ảnh (không được load hết vào RAM); server restart giữa turn → turn dở phải mark
`interrupted` chứ không treo `running`; session tmux detached vẫn ghi tiếp khi server chết → lúc reattach phải
catch-up từ offset đã lưu.

### A2. Checkpoints — commit ↔ session ✅ **XONG**

> **Plan chi tiết: [`checkpoints.md`](checkpoints.md)** — M0→M6 xong 2026-09-03.

**Làm gì.** Bảng `checkpoints`: commitSha, projectPathId, sessionId, turnId, patchId, confidence, orphan flag.

**Observe chứ không intercept.** `git-watch.ts` **đã** watch `.git/HEAD`, `refs`, `packed-refs`
(`server/src/services/git-watch.ts:34`) — nên commit tạo từ terminal thật, từ Xcode, hay lúc app đang đóng vẫn bắt được.
Refs đổi → `git log` các sha mới → attribute.

**Attribution, 3 mức, khai báo rõ độ tin cậy trên UI:**
1. `exact` — commit do MCP/agent trong app tạo, hoặc session đang chạy trong đúng worktree đó vào đúng lúc đó.
2. `inferred` — giao tập file của commit với `session_files` trong cửa sổ thời gian trước commit; chấm điểm theo tỉ lệ trùng.
3. `orphan` — không đủ căn cứ. **Ghi là orphan, không đoán** (đúng cách Atlas làm với squash).

**Sống qua rebase/amend:** lưu `git patch-id` lúc tạo checkpoint. Khi thấy sha lạ, so patch-id với checkpoint có sha
đã biến mất → re-point. Squash làm patch-id đổi hẳn → orphan, không gán bừa.

**"Chat với checkpoint":** mở session mới seed bằng (diff của commit + tóm tắt turn đã sinh ra nó + prompt gốc).
Không cần machinery mới — `createChatSession` + một block context, giống cách workflow step đang truyền context.

**File dự kiến chạm:** `schema.ts`, `services/checkpoints.ts` (mới), `services/git-watch.ts` (bắn event commit),
`services/git.ts` (patch-id, log range), `routes/git.ts`, web: git/diff panel + view Checkpoints mới.

**Edge case:** worktree riêng của session (`data/worktrees/`) — commit trong worktree thuộc cùng repo, không được
tính trùng; monorepo nhiều `project_paths` trong một repo; commit merge; `git commit --amend` liên tiếp;
repo shallow/không có upstream; file rename (`git log --follow` không dùng được ở mức batch).

### A3. Mission control — usage & capture health

Có A1 rồi thì cái này gần như chỉ là màn hình đọc: usage theo thời gian, chia theo project/session/model/agent,
timeline, bảng log filter được, và **capture health** một tín hiệu mỗi project (OK / Degraded / Stopped + lý do +
việc cần làm) — Atlas làm đúng thế và nó là thứ khiến provenance đáng tin. Ghép vào Settings → Doctor đang có.

**File:** `routes/insights.ts` (mới), `services/session-ledger.ts` (query aggregate), web: page mới.

**Edge case:** cost của session resume tính trùng; cache-read token không nên cộng như input; transcript backfill
làm thống kê nhảy ngược về quá khứ.

### A4. Session handoff — fact pack ở message đầu

**Làm gì.** Message đầu của một session nhận thêm: plan đang active, quyết định gần đây, file vừa đổi,
tail của session trước **trong cùng project** (kể cả session đó là terminal và session này là SDK, hoặc ngược lại).

**Chỗ khó — và khác Atlas.** Atlas làm chủ mọi agent qua ACP nên inject lúc nào cũng được. Mình có bề mặt chính là
**PTY chạy `claude` CLI** — không tiêm được vào giữa hội thoại của nó. Hai lối ra, phải chốt:
- `--append-system-prompt` khi spawn terminal (chỉ tác dụng lúc mở tab, không phải mỗi turn), hoặc
- ghi fact pack thành file trong `data/` rồi pre-type một dòng `@<path>` — nhất quán với triết lý "never auto-sent"
  đang có ở nút *Work on this with Claude*.

SDK session thì tiêm thoải mái (`buildWorkspaceContext` đang làm việc này ở `services/workspace-context.ts`).

**File:** `services/handoff.ts` (mới), `services/workspace-context.ts`, `claude-session.ts`, `terminals.ts`.

**Edge case:** session trước là của project khác nhưng cùng repo path; pack quá dài → phải cap như
`prompt.knowledgeIndexBytes` đang cap; session trước fail giữa đường (đưa thất bại vào pack là *có ích*, đừng lọc bỏ).

### A5. Memory retrieval — theo nội dung, không theo pin

**Hôm nay:** pinned → nhồi full, còn lại → chỉ đưa title cho Claude tự gọi tool
(`memory.ts:306 memoryPromptSection`). Nghĩa là note hữu ích mà không pin thì gần như không bao giờ được đọc.

**Làm 2 bước, đừng nhảy thẳng vào vector:**
- **A5a — hybrid lexical (rẻ, làm trước):** FTS5 đã có sẵn (`services/search.ts`) — index thêm memory,
  rank BM25 theo message của user, đưa top-k vào prompt cạnh pinned. Có thể đã đủ 80% giá trị.
- **A5b — vector (nếu A5a chưa đủ):** `sqlite-vec` + embedding **chạy local** (bge-small / MiniLM qua
  `transformers.js` hoặc `node-llama-cpp`). Không gọi API bên ngoài — local-first là điểm bán của cả app này.
  Cần đo: thời gian index lần đầu, RAM, kích thước model tải về.

Thêm: **memory tự viết từ ledger** — Atlas thắng ở chỗ shared memory phần lớn do agent tự ghi. Mình đã có
`memory_*` MCP tool và note `source=claude`; bổ sung đề xuất note tự động khi phát hiện quyết định lặp lại,
nhưng **luôn qua review** ở tab Memory (không ghi ngầm).

**File:** `services/memory.ts`, `services/search.ts`, `services/embed.ts` (mới, chỉ A5b),
`services/workspace-context.ts`, `mcp/server.ts`.

**Edge case:** retrieval phải deterministic đủ để debug được "vì sao Claude không biết cái note này";
note global vs project cạnh tranh chỗ; xoá note phải xoá cả index.

---

## Track B — Ecosystem

### B1. Packs — install một repo skills/agents/workflows/commands

Mình đã có đủ 4 loại asset (skill symlink `services/skills.ts`, agent `.agent.md` import/export,
workflow library asset, path command). Pack chỉ là: `git clone` vào `data/packs/<name>` → đọc manifest →
đăng ký từng asset (dạng **reference**, không copy — giống `project_knowledge` đang làm) → update/uninstall theo pack.

**Bảo mật là phần chính, không phải phần phụ.** Một pack chứa hook/script là **RCE**. Nên: hiện diff những gì
sẽ được đăng ký *trước khi* cài, script/hook mặc định **tắt** và phải bật từng cái, pin commit sha chứ không theo branch.

**File:** `schema.ts` (`packs`, `pack_assets`), `services/packs.ts` (mới), `routes/knowledge.ts` hoặc route mới, web: page Packs.

**Edge case:** tên asset trùng cái đang có; pack update làm mất bản user đã sửa tay; symlink skill trỏ vào repo đã xoá.

### B2. Multi-agent

**B2a — rẻ, làm trước:** preset terminal cho agent CLI khác (`codex`, `opencode`, `cursor-agent`). Hạ tầng PTY +
tmux + env set + History đã có; thêm preset gần như miễn phí. Cộng: viết `AGENTS.md` cạnh `CLAUDE.md` từ cùng
nguồn context để agent khác cũng đọc được.
**Nói thẳng giới hạn:** MCP tool của mình (`jira_*`, `run_project_command`, `memory_*`) và modal duyệt tool
**chỉ Claude dùng được**. Agent khác chạy được nhưng không có tay chân của app.

**B2b — đắt, chỉ khi thật cần:** ACP client (`agent-client-protocol`, có lib TS) → session trở thành
transport-agnostic, workflow step chọn được agent, tool/approval đi qua một đường chung.
Đây là refactor `claude-session.ts` ở mức kiến trúc — **không nên làm trước khi Track A xong**.

**File:** B2a `services/terminals.ts`, `lib/claude-cli.ts`, settings. B2b: `services/agent-transport.ts` (mới) + `claude-session.ts`.

---

## Track C — Workflows v2

Cái đang có (xem [`workflows.md`](workflows.md)) đã đúng nền: step = session/command/confirm/manual, run snapshot
definition, `workflow_ask` block tool call, artifact, condition, retry. Thiếu những thứ sau — xếp theo giá trị/công:

| ID | Việc | Vì sao cần |
|---|---|---|
| **C1** | **DAG + parallel step** — step khai `dependsOn` thay vì `sortOrder`; fan-out một step ra nhiều path/nhiều repo rồi join | Hôm nay chuỗi tuyến tính: build iOS + build Android phải chờ nhau vô nghĩa. `workflow_run_steps` đã unique theo `(runId, stepKey)` nên đổi sang DAG là đổi scheduler, không đổi storage nhiều |
| **C2** | **Gate step** — step kiểu `verify`: chạy command, parse exit code/output, **fail thì loop lại step trước** với error làm context | Hiện `maxRetries` chỉ retry chính step đó. Vòng "implement → test → fix" là vòng người ta chạy thật nhất, giờ vẫn phải ngồi ghép tay |
| **C3** | **Trigger** — cron, webhook, git push, Jira label. Chạy workflow không cần ai bấm | `app-agents.md` (`jira-ai-fixer`) chứng minh nhu cầu; nhưng nó là app riêng, còn workflow thì chưa trigger được |
| **C4** | **Run → checkpoint** — run hiện đúng những commit nó tạo ra; step hiện diff của chính nó (cần **A2**) | Hôm nay xong run không biết nó đã đổi gì trong repo |
| **C5** | **Template + biến** — workflow nhận input khai báo trước (`{{ticket}}`, `{{targetPath}}`), step nội suy; import/export `.workflow.md` | Đang phải sửa definition mỗi lần chạy cho việc khác |
| **C6** | **Learn-from-history** — từ ledger (A1) đề xuất workflow từ chuỗi việc user vừa làm thật | Cái này Atlas không có; là chỗ mình đi trước được |

Thêm hai cái nhỏ nhưng đau hằng ngày: **resume-from-step** (run fail ở step 5 thì chạy lại từ 5, không từ 1 — hiện
restart chỉ mark `interrupted`), và **dry-run** (in ra step sẽ chạy + cwd + env + permissionMode mà không chạy).

**File dự kiến chạm:** `services/workflow-runner.ts` (972 dòng — C1/C2 là sửa scheduler ở đây, phần lớn công nằm chỗ này),
`services/workflows.ts`, `services/workflow-condition.ts`, `schema.ts`, `ws/workflow-ws.ts`, `mcp/server.ts` (tool mới cho gate),
web: workflow editor + run view.

**Edge case:** parallel step ghi cùng working tree → phải ép worktree riêng hoặc serialize (repo lock đang có);
DAG có cycle; gate loop vô hạn (cần cap); trigger nổ chồng nhau (cần guard chống lặp — đúng cái bẫy đã ghi trong
`app-agents.md` cho polling); run song song cùng project cạnh tranh env set.

---

## Không làm (cố tình)

Editor, browser tab, research (arXiv/Semantic Scholar), spaces/canvas, org sync đa người. claude-station không
định thành IDE — nó là **control plane**: repo mở bằng IDE thật (`ide.command` trong Settings). Ghi ra đây để
lần sau không ai đề xuất lại.

Cũng không đổi stack sang Tauri/Rust. Web local + Node là quyết định đã chốt ở `claude-station.md`; lợi ích
"mở từ máy khác" đang là điểm mạnh so với Atlas (`.dmg` native, macOS only).

---

## Cần confirm

1. **Thứ tự.** Đề xuất: **A1 → A2** trước hết (checkpoints là thứ khác biệt nhất và là thứ Atlas dựa vào), chèn
   **C1/C2** song song vì workflow là thứ mày dùng hằng ngày. Hay muốn đảo — làm Workflows v2 trước cho ra giá trị ngay?
2. ~~**A1 phạm vi capture.**~~ **Đã chốt (2026-09-03):** metadata + file list + token, **prompt của user ghi full**
   (đã redact), tool input/output không lưu nội dung. Transcript gốc vẫn là source of truth — xem
   [`session-ledger.md`](session-ledger.md) § Quyết định thiết kế 2.
3. **A4 cách inject cho terminal.** `--append-system-prompt` (tự động, nhưng chỉ lúc mở tab) hay pre-type `@factpack.md`
   (user thấy trước, nhất quán với "never auto-sent")? Tao nghiêng về pre-type.
4. **A5 có cần vector không**, hay A5a (FTS5) là đủ? Vector kéo theo model tải về + RAM + thời gian index.
5. **B2 có nằm trong scope không?** B2a (preset terminal) rẻ và làm được ngay; B2b (ACP) là refactor lớn —
   tao đề xuất **cắt B2b khỏi roadmap này**, chỉ ghi nhận, quyết định lại sau khi Track A xong.
6. **C3 triggers.** Trigger nào cần trước — cron, git push, hay Jira label? (Jira label đã có tiền lệ `jira-ai-fixer`.)
7. **Migration.** Backfill ledger từ transcript CLI cũ: chạy nền lúc boot lần đầu, hay một nút "Import history"
   trong Settings để user tự bấm? Backfill có thể mất vài phút với `~/.claude/projects/` lớn.

## Changelog

- 2026-09-03: bản đầu — roadmap 3 track sau khi đối chiếu pacifio/atlas.
- 2026-09-03: **impl xong A1 + A2**; A3/A4/A5 dùng lại được ledger + checkpoint mà không phải sửa gì.
- 2026-09-03: chốt thứ tự **A1 → A2** làm trước; tách plan chi tiết `session-ledger.md` + `checkpoints.md`; chốt phạm vi capture của A1.
