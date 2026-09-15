# Plan tổng: bù khoảng cách với Atlas + nâng Workflows

> Plan **tổng quát** (roadmap). Mỗi phase dưới đây sẽ có plan con riêng trong `docs/plans/` trước khi impl —
> file này chỉ chốt _làm gì, theo thứ tự nào, vì sao_. Plan con của [`claude-station.md`](claude-station.md).
> Mọi path tương đối theo `<repo>`.
> Trạng thái (2026-09-15, sau khi **đối chiếu lại** Atlas ở `81e6384c`, nhánh 0.3.2 — 115 commit sau lần đối
> chiếu đầu): **A1 + A2 xong** (2026-09-03) · **C1/C2/C3/C5 xong** (workflows L3) · A3/A4/A5/B1/B2/C4/C6 chưa
> bắt đầu, nhưng **hình dạng của A4/A5/B1/B2 đã đổi** vì Atlas ship xong chúng theo cách khác · thêm
> **Track D** — thứ Atlas có mà roadmap này chưa từng ghi. **Đợt 1 (D1 + A3 + D5) impl xong 2026-09-15.**

## Bối cảnh

Đối chiếu với [pacifio/atlas](https://github.com/pacifio/atlas) (Tauri + Rust, "source control for agents"),
claude-station đang mạnh hơn ở **điều phối công việc** (workflows, commands runner, Jira/GitHub, app agents,
env sets, tmux hand-off) và yếu hơn ở **ghi lại và tái dùng những gì agent đã làm**:

| Atlas hôm nay (0.3.2)                                                                      | Mình đang có gì                                     | Khoảng cách thật                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| Checkpoint commit↔session, sống qua rebase/amend                                           | `checkpoints` + `session_turns`/`session_files`     | **Đã bù xong** (A1+A2)                                   |
| Mission control: usage/cost, gantt, logs table, export                                     | Ledger có số, không có màn hình                     | A3 — gần như chỉ là màn hình đọc                         |
| Giá model fetch từ models.dev, cache lại                                                   | `costUsd` NULL cho mọi turn CLI                     | **Mới**: không có bảng giá thì A3 chỉ đúng một nửa       |
| Shared cross-agent memory: event log typed, inject theo sync clock mỗi turn                | `project_memories` pin/title                        | A4 + A5 gộp lại, và đúng hình hơn cả A4                  |
| RAG on-device: MiniLM → HNSW + graph, **cộng code index tree-sitter**                      | FTS5 (`search.ts`)                                  | A5, phần code index là mới                               |
| Packs qua index skills.sh, `.agents/skills` là canonical store                             | Skill symlink riêng của mình                        | B1, rộng hơn "clone một repo"                            |
| ACP stack port từ Zed (6 crate) + marketplace tự tải binary + native agent fork Codex      | Khoá `claude` CLI + Agent SDK                       | B2 — lệch nặng nhất, và hình dạng khác hẳn               |
| Plans panel: bắt mọi plan ExitPlanMode vào `.atlas/plans.json`                             | Plan là file `docs/plans/*.md` viết tay             | **Mới**, và hợp với rule plan-first của repo             |
| Session chat: hỏi đáp có căn cứ trên một session đã ghi                                    | "Chat với checkpoint" mới ở mức ý tưởng             | A2 còn nợ nửa này                                        |
| Analytics theo turn: đếm file/ext/dòng, **không bao giờ giữ nội dung**                     | `toolCallCount` một số                              | **Mới**, rẻ, và là cách đo không đụng privacy            |
| Redaction: entropy + rule betterleaks + prefix provider + URI có credential, traverse JSON | `lib/redact.ts`, 129 dòng, 1 mảng regex             | **Mới** — mà ledger mình đang ghi prompt full xuống disk |
| Comms (chat team), organisations, sync outbox, company brain                               | —                                                   | **Cố tình không làm** (§ Không làm)                      |
| Editor / browser / research / spaces / canvas / kb-server                                  | —                                                   | **Cố tình không làm** (§ Không làm)                      |
| Workflow engine                                                                            | `workflow-runner.ts` + DAG + gate + trigger + input | **Atlas không có gì tương đương** — grep cả repo, sạch   |

Nhận xét quan trọng để định hướng: **mình có một lợi thế Atlas không có.** Atlas phải _đoán_ commit thuộc session nào
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
  C1 DAG + parallel ✅   C2 Gate step ✅   C3 Triggers ✅
  C4 Run → checkpoint (cần A2)   C5 Template + biến ✅   C6 Learn-from-history

Track D — Lấy thêm sau khi đối chiếu lại (2026-09-15)
  D1 Bảng giá + usage thật ──→ A3
  D2 Shared memory bus (nuốt luôn A4, và là nguồn cho A5)
  D3 Plans panel     D4 Session chat (nợ của A2)
  D5 Turn analytics  D6 Redaction v2     D7 Agent start diagnostics
```

**Thứ tự (cập nhật 2026-09-15).** Track A/C đã ăn hết phần dễ; phần còn lại xếp theo đợt:

| Đợt             | Việc                                                                             | Vì sao đợt này                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**           | **D1** bảng giá → **A3** mission control + **D5** turn analytics                 | A3 là thứ duy nhất trong danh sách "chưa làm" mà dữ liệu đã nằm sẵn trong máy. Nhưng làm A3 trước D1 thì dashboard không có tiền cho session CLI — nửa số liệu trống |
| **2**           | **D2** shared memory bus (nuốt A4) + **D3** plans panel + **D6** redaction v2    | D2 là feature hay nhất của Atlas và là nguồn dữ liệu cho A5. D6 rẻ, chèn vào vì ledger đang ghi prompt full xuống disk                                               |
| **3**           | **A5a** FTS retrieval → **B1** packs → **B2a** preset agent + **D7** diagnostics | A5a ăn ngay được event log của D2. B1/B2a độc lập, chèn lúc chờ review                                                                                               |
| **4**           | **D4** session chat → **C4** run→checkpoint → **C6** learn-from-history          | Đều cần đợt trước xong mới có gì để đọc                                                                                                                              |
| **5, cân nhắc** | **A5b** embedding local + code index · **B2b** ACP                               | Đắt. Quyết định lại sau đợt 3                                                                                                                                        |

Lý do đổi thứ tự cũ: A4 không còn là một feature riêng — nó là trường hợp đặc biệt (lần inject đầu tiên) của D2.

---

## Track A — Provenance & context

### A1. Session ledger — nền của mọi thứ còn lại ✅ **XONG**

> **Plan chi tiết: [`session-ledger.md`](session-ledger.md)** — L0→L6 xong 2026-09-03.

**Vấn đề.** Hôm nay dữ liệu một session nằm ở hai chỗ khác nhau và không chỗ nào query được theo _file_ hay
theo _thời điểm_: SDK session ghi `chat_messages.content` (raw `SDKMessage` JSON, phải parse mới biết nó sửa file gì),
CLI terminal session không ghi gì vào DB cả — transcript nằm ở `~/.claude/projects/` và
`server/src/lib/claude-transcript.ts` hiện chỉ đọc **head + tail** để hiện danh sách.

**Làm gì.** Một _ledger_ chung cho cả hai bề mặt, ghi ở mức **turn**:

- `session_turns` — sessionId, seq, thời điểm bắt đầu/kết thúc, prompt preview, model, tokens in/out/cache, costUsd, kết quả.
- `session_files` — turnId, path (tuyệt đối + relative theo repo path), thao tác (read/write/delete), nguồn (`tool` hay `tree`).
- `session_capture` — transcript path, byte offset đã đọc, trạng thái capture (ok/degraded/stopped).

(Tên bảng và cột chốt theo [`session-ledger.md`](session-ledger.md) § Schema.)

Nguồn ghi:

- **SDK session:** hook ngay trong `claude-session.ts` — đã có chỗ đọc `tool_use` (`:122`) và `total_cost_usd` (`:418`),
  chỉ cần ghi xuống thay vì chỉ stream ra UI.
- **CLI terminal:** một _transcript follower_ — mỗi terminal `claude` mở ra thì tail file JSONL tương ứng
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

### A3. Mission control — usage & capture health ✅ **XONG (2026-09-15)**

> Trang `/insights`. Cửa sổ 7/30/90/365 ngày, lọc theo project, chỉ số vẽ được: cost · turns · tokens ·
> lines. Có breakdown theo project/model/surface/đuôi file, bảng _Where it went_ (turn đắt nhất, không phải
> turn gần nhất — History đã làm việc đó), và **capture health nằm ngay đầu trang**.
> Backend: `server/src/routes/insights.ts` — hai endpoint, gộp 6 nhóm vào một call để tổng và breakdown
> không lệch nhau giữa hai request.

Có A1 rồi thì cái này gần như chỉ là màn hình đọc: usage theo thời gian, chia theo project/session/model/agent,
timeline, bảng log filter được, và **capture health** một tín hiệu mỗi project (OK / Degraded / Stopped + lý do +
việc cần làm) — Atlas làm đúng thế và nó là thứ khiến provenance đáng tin. Ghép vào Settings → Doctor đang có.

**File:** `routes/insights.ts` (mới), `services/session-ledger.ts` (query aggregate), web: page mới.

**Edge case:** cost của session resume tính trùng; cache-read token không nên cộng như input; transcript backfill
làm thống kê nhảy ngược về quá khứ.

### A4. Session handoff — fact pack ở message đầu ✅ **XONG qua D2 (2026-09-15)**

> **2026-09-15: mục này bị [D2](#d2-shared-memory-bus--cái-hay-nhất-của-atlas-và-nó-nuốt-luôn-a4) nuốt.** Bơm một lần ở message đầu chỉ là trường hợp `since_seq == 0` của bus. Giữ lại phần dưới vì phần _cách tiêm vào PTY_ vẫn nguyên giá trị.

**Làm gì.** Message đầu của một session nhận thêm: plan đang active, quyết định gần đây, file vừa đổi,
tail của session trước **trong cùng project** (kể cả session đó là terminal và session này là SDK, hoặc ngược lại).

**Chỗ khó — và khác Atlas.** Atlas làm chủ mọi agent qua ACP nên inject lúc nào cũng được. Mình có bề mặt chính là
**PTY chạy `claude` CLI** — không tiêm được vào giữa hội thoại của nó. Hai lối ra, phải chốt:

- `--append-system-prompt` khi spawn terminal (chỉ tác dụng lúc mở tab, không phải mỗi turn), hoặc
- ghi fact pack thành file trong `data/` rồi pre-type một dòng `@<path>` — nhất quán với triết lý "never auto-sent"
  đang có ở nút _Work on this with Claude_.

SDK session thì tiêm thoải mái (`buildWorkspaceContext` đang làm việc này ở `services/workspace-context.ts`).

**File:** `services/handoff.ts` (mới), `services/workspace-context.ts`, `claude-session.ts`, `terminals.ts`.

**Edge case:** session trước là của project khác nhưng cùng repo path; pack quá dài → phải cap như
`prompt.knowledgeIndexBytes` đang cap; session trước fail giữa đường (đưa thất bại vào pack là _có ích_, đừng lọc bỏ).

### A5. Memory retrieval — theo nội dung, không theo pin ✅ **A5a XONG (2026-09-15)** · A5b chưa

> **2026-09-15:** thứ tự A5a → A5b vẫn đúng, nhưng thêm hai thứ từ Atlas: nguồn để retrieve giờ có cả event log của D2, và A5b phải kèm **code index** (tree-sitter → doc có cấu trúc, `atlas-codeindex`) — đó mới là chỗ Atlas ăn điểm, không phải riêng vector.

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

### B1. Packs — install một repo skills/agents/workflows/commands ✅ **XONG (2026-09-15)**

> **2026-09-15:** Atlas rộng hơn thế — pack tìm qua **index skills.sh**, và skill lưu ở `~/.agents/skills` + `<project>/.agents/skills` như một **canonical store dùng chung** với `skills` CLI và Zed, mỗi agent chỉ được symlink vào (ADR-0005 của họ). Đáng cân nhắc đổi theo để skill của mình dùng được ngoài app.

Mình đã có đủ 4 loại asset (skill symlink `services/skills.ts`, agent `.agent.md` import/export,
workflow library asset, path command). Pack chỉ là: `git clone` vào `data/packs/<name>` → đọc manifest →
đăng ký từng asset (dạng **reference**, không copy — giống `project_knowledge` đang làm) → update/uninstall theo pack.

**Bảo mật là phần chính, không phải phần phụ.** Một pack chứa hook/script là **RCE**. Nên: hiện diff những gì
sẽ được đăng ký _trước khi_ cài, script/hook mặc định **tắt** và phải bật từng cái, pin commit sha chứ không theo branch.

**File:** `schema.ts` (`packs`, `pack_assets`), `services/packs.ts` (mới), `routes/knowledge.ts` hoặc route mới, web: page Packs.

**Edge case:** tên asset trùng cái đang có; pack update làm mất bản user đã sửa tay; symlink skill trỏ vào repo đã xoá.

### B2. Multi-agent ✅ **B2a XONG (2026-09-15)** · B2b (ACP) chưa

> **2026-09-15:** đây là chỗ lệch nặng nhất. Atlas port hẳn ACP stack của Zed thành 6 crate, có marketplace tự tải binary chính chủ (`commands/registry.rs`, `catalog.rs`), OAuth từng agent, model catalogue fetch từ gateway — **và** một native agent fork engine Codex. B2a (preset terminal) vẫn là bước đầu đúng; B2b thì phạm vi thật lớn hơn ước lượng cũ.

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

| ID     | Việc                                                                                                                                  | Vì sao cần                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **DAG + parallel step** — step khai `dependsOn` thay vì `sortOrder`; fan-out một step ra nhiều path/nhiều repo rồi join               | Hôm nay chuỗi tuyến tính: build iOS + build Android phải chờ nhau vô nghĩa. `workflow_run_steps` đã unique theo `(runId, stepKey)` nên đổi sang DAG là đổi scheduler, không đổi storage nhiều |
| **C2** | **Gate step** — step kiểu `verify`: chạy command, parse exit code/output, **fail thì loop lại step trước** với error làm context      | Hiện `maxRetries` chỉ retry chính step đó. Vòng "implement → test → fix" là vòng người ta chạy thật nhất, giờ vẫn phải ngồi ghép tay                                                          |
| **C3** | **Trigger** — cron, webhook, git push, Jira label. Chạy workflow không cần ai bấm                                                     | `app-agents.md` (`jira-ai-fixer`) chứng minh nhu cầu; nhưng nó là app riêng, còn workflow thì chưa trigger được                                                                               |
| **C4** | **Run → checkpoint** — run hiện đúng những commit nó tạo ra; step hiện diff của chính nó (cần **A2**)                                 | Hôm nay xong run không biết nó đã đổi gì trong repo                                                                                                                                           |
| **C5** | **Template + biến** — workflow nhận input khai báo trước (`{{ticket}}`, `{{targetPath}}`), step nội suy; import/export `.workflow.md` | Đang phải sửa definition mỗi lần chạy cho việc khác                                                                                                                                           |
| **C6** | **Learn-from-history** — từ ledger (A1) đề xuất workflow từ chuỗi việc user vừa làm thật                                              | Cái này Atlas không có; là chỗ mình đi trước được                                                                                                                                             |

Thêm hai cái nhỏ nhưng đau hằng ngày: **resume-from-step** (run fail ở step 5 thì chạy lại từ 5, không từ 1 — hiện
restart chỉ mark `interrupted`), và **dry-run** (in ra step sẽ chạy + cwd + env + permissionMode mà không chạy).

**File dự kiến chạm:** `services/workflow-runner.ts` (972 dòng — C1/C2 là sửa scheduler ở đây, phần lớn công nằm chỗ này),
`services/workflows.ts`, `services/workflow-condition.ts`, `schema.ts`, `ws/workflow-ws.ts`, `mcp/server.ts` (tool mới cho gate),
web: workflow editor + run view.

**Edge case:** parallel step ghi cùng working tree → phải ép worktree riêng hoặc serialize (repo lock đang có);
DAG có cycle; gate loop vô hạn (cần cap); trigger nổ chồng nhau (cần guard chống lặp — đúng cái bẫy đã ghi trong
`app-agents.md` cho polling); run song song cùng project cạnh tranh env set.

---

## Track D — Lấy thêm sau khi đối chiếu lại (2026-09-15)

Tất cả những mục dưới đây đến từ việc đọc **bề mặt command của Atlas** (79 module trong `src-tauri/src/commands/`),
không phải từ README. Mỗi mục ghi kèm chỗ Atlas làm nó, để lần sau tra lại được.

### D1. Bảng giá model + cost thật — nền của A3 ✅ **XONG (2026-09-15)**

**Vấn đề.** `session_turns.costUsd` **NULL với mọi turn CLI** — đúng như comment trong `schema.ts` đã ghi:
transcript của CLI không mang cost, và mình từ chối đoán bằng bảng giá hardcode. Hệ quả: A3 vẽ ra thì nửa số liệu trống.

**Atlas giải bằng cách nào.** `commands/models_pricing.rs`: fetch `https://models.dev/api.json`, chuẩn hoá thành price
map, cache ra `models-pricing.json`, mỗi lần khởi động fetch nền rồi **chỉ ghi lại khi có thay đổi** + bắn event cho UI
reload. `commands/usage.rs` ghi rõ vì sao bỏ lối scrape JSONL cũ: nó khiến ba bề mặt UI _Claude-only by construction_.

**Làm gì.** `services/model-pricing.ts`: fetch + cache `data/models-pricing.json`, refresh nền **sau `app.listen`**
(việc nặng ở boot đã có tiền lệ làm UI trông như mất data). Thêm helper `costOf(turn)`: có `costUsd` do SDK báo thì
dùng, không thì tính `tokens × giá` và **đánh dấu là ước lượng** — cột `costSource` (`reported` | `estimated` | `unknown`).
UI không được phép hiện số ước lượng mà trông như số thật.

**File dự kiến chạm:** `services/model-pricing.ts` (mới), `db/schema.ts` (`costSource` trên `session_turns`),
`services/session-ledger.ts`, `routes/ledger.ts`, `services/claude-session.ts`.

**Edge case:** lần đầu chạy offline → không có giá thì hiện token, không hiện tiền (đừng hiện `$0.00`);
model id lạ (alias, bedrock, vertex) không map được → `unknown`, không đoán; **cache-read token phải tính theo giá
cache-read**, không cộng vào input (edge case này roadmap cũ đã ghi ở A3); giá đổi về sau không được làm số cũ nhảy →
tính xong thì lưu, không tính lại từ giá mới.

### D2. Shared memory bus — cái hay nhất của Atlas, và nó nuốt luôn A4 ✅ **XONG (2026-09-15)**

**Atlas làm gì.** Một _bus_ giữa các agent, 5 module: `memory_delta` (capture) → `shared_memory` (log append-only
`events.jsonl` + state gập lại `state.json`) → `memory_inject` (đọc/push) → `memory_sharing` (sync clock) →
`memory_compile` (pass LLM tuỳ chọn, chưng prose thành event có kiểu). Ba chi tiết đáng lấy nguyên:

1. **Event có kiểu, không phải transcript thô.** `plan` / `decision` / `fact` / `failure` / `architecture` /
   thay đổi file. Bắt từ tín hiệu _có cấu trúc_ (plan update, tool call sửa file) trước, rồi một pass keyword
   **bảo thủ** trên message đã hoàn tất. Streaming text bị bỏ qua hẳn.
2. **Sync clock theo session.** Lần gửi đầu (`since_seq == 0`) thì session thừa hưởng **toàn bộ state hiện tại**;
   từ turn sau chỉ chèn **delta** — những gì agent khác ghi kể từ lần session này nhìn. Không có delta thì
   không chèn gì, không cả dấu phân cách.
3. **Redact ngay tại biên ghi**, vì đây là kênh dùng chung.

**Vì sao nó thay A4.** A4 của mình là "fact pack ở message đầu" — bơm một lần rồi thôi. Bus thì liên tục và hai
chiều: session A quyết định gì, session B biết ở turn kế. Và khi B2a có agent khác chạy, đây là **chỗ duy nhất**
phải cắm vào.

**Làm gì.** Bảng `session_memory_events` (seq tự tăng theo project, projectId, sourceKind, sessionId, turnId, kind,
text đã redact, createdAt) — dùng SQLite thay vì JSONL vì mình đã có sẵn, và `seq` là thứ sync clock cần.
Capture móc vào **`onTurnClosed` đã có** (`services/session-ledger.ts:222`) nên cả SDK lẫn CLI đi chung một đường.
Fold ra state bounded (plan đang active + N decision/fact/failure gần nhất). Inject:

- **SDK** — chèn trong `workspace-context.ts`, đã là chỗ dựng context.
- **CLI/PTY** — không tiêm được vào giữa hội thoại, nên giữ nguyên quyết định pre-type `@<path>` của A4, nhưng file
  đó giờ do bus ghi và chỉ chứa **delta**; UI hiện chỉ báo khi `seq` tăng. Nhất quán với "never auto-sent".

**File dự kiến chạm:** `db/schema.ts`, `services/shared-memory.ts` (mới), `services/session-ledger.ts` (emit),
`services/workspace-context.ts`, `services/terminals.ts`, `routes/memory.ts`, web: tab Memory thêm view Events/State.

**Edge case:** backfill transcript cũ sinh event trùng → dedup theo `(sessionId, turnSeq, kind, hash(text))`;
một repo hai `project_paths`; state phình → cap theo bytes như `prompt.knowledgeIndexBytes` đang cap;
keyword pass bắt nhầm câu phủ định ("không dùng RS256") — thà bỏ sót còn hơn ghi ngược;
xoá project phải xoá cả log.

### D3. Plans panel — hợp với rule plan-first hơn bất kỳ ai ✅ **XONG (2026-09-15)**

**Atlas làm gì.** `commands/plans.rs`: mỗi lần agent đề xuất plan (permission `ExitPlanMode` mang `{ plan: markdown }`),
lưu lại kèm **message đã gây ra plan đó** + timestamp vào `.atlas/plans.json`; panel Plans duyệt lại mọi plan từng có
của project, xuyên session.

**Vì sao mình nên lấy.** Rule của repo là plan-trước-impl, mà plan hiện chỉ tồn tại nếu ai đó nhớ viết ra file
`docs/plans/*.md`. Plan Claude đề xuất trong một session CLI thì bay mất cùng scrollback. Transcript CLI **có**
tool_use `ExitPlanMode` → backfill được cả plan cũ, không chỉ plan từ đây về sau.

**Làm gì.** Bảng `session_plans` (projectId, sessionId, turnId, promptText đã gây ra nó, markdown, status
`proposed|accepted|rejected`, createdAt). Bắt ở `claude-session.ts` (SDK) và `lib/claude-transcript.ts` (CLI +
backfill). Panel: list theo project, xem full, diff hai bản plan của cùng một việc, và nút "plan này đã thành file
nào trong `docs/plans/`".

**Edge case:** plan vài chục KB; plan **bị từ chối** vẫn phải lưu và ghi rõ là rejected (đó là dữ liệu tốt, không
phải rác); cùng một plan gửi lại nhiều lần sau khi sửa → nhóm theo session chứ đừng dedup mất lịch sử.

### D4. Session chat — trả nợ nửa còn lại của A2 ✅ **HOÁ RA ĐÃ CÓ**

**Đối chiếu lại 2026-09-15: mục này đã được impl từ trước và không ai ghi vào roadmap.**
`POST /api/projects/:id/checkpoints/:cpId/work-with-claude` mở một terminal `claude` với seed prompt dựng
từ commit + turn + file (`routes/checkpoints.ts:29 buildSeedPrompt`), và **cố tình không paste diff** — chỉ
trỏ `git show`. Đúng hơn cách Atlas làm. Không impl trùng.

~~A2 đã hứa "chat với checkpoint" nhưng mới ở mức ý tưởng.~~ Atlas có hẳn `commands/session_chat.rs`: **chỉ retrieval** —
gom từ store ra rồi trả về một prompt đã bổ sung ngữ cảnh, phần sinh chữ đi qua đường provider sẵn có. Đúng cách
mình nên làm: `services/session-chat.ts` dựng prompt từ (turn + `session_files` + diff của commit) rồi đẩy vào
`createChatSession` đang có. Không engine mới.

### D5. Turn analytics — đo mà không giữ nội dung ✅ **XONG (2026-09-15)**

`commands/agent_analytics.rs` + `tool_stats.rs`: mỗi turn một event giàu thông tin — đếm tool call theo loại, số file
theo **đuôi file**, số dòng thêm/bớt, turn kết thúc kiểu gì. Và ghi rõ nguyên tắc: _"never a path, an argument, a
tool's output, or a word of the conversation"_. Mình đã có `session_files` nên phần "file theo đuôi" là một câu query,
chỉ thiếu **số dòng thêm/bớt** — lấy được từ diff cây làm việc mà A1 đã chạy. Đây là thứ khiến A3 có cái để vẽ
ngoài mỗi tiền.

### D6. Redaction v2 — rủi ro đang tồn tại, không phải giả định ✅ **XONG (2026-09-15)**

`atlas-redact` là hẳn một crate: entropy Shannon + bộ rule betterleaks vendor về + prefix theo nhà cung cấp +
URI có credential + connection string + key/value có giới hạn, và **traverse theo cấu trúc JSON** chứ không chỉ
regex trên text phẳng. `lib/redact.ts` của mình: **129 dòng, một mảng `PATTERNS` + masking theo secret đã biết**.
Trong khi `session_turns.promptText` đang ghi **prompt đầy đủ** xuống SQLite.

**Làm gì.** Nâng `lib/redact.ts`: thêm pass JSON-aware cho tool input, thêm bộ prefix provider, thêm entropy
detector có ngưỡng **và allowlist** (hash, UUID, sha commit không được mask). Test bằng corpus transcript thật
trong `~/.claude/projects/`.

**Edge case:** mask quá tay làm prompt đọc lại thành vô nghĩa — cần đối chứng trước/sau trên corpus thật;
entropy tốn CPU → chỉ chạy trên field đã chọn, không quét cả transcript 29MB.

### D7. Agent start diagnostics — blob copy được khi agent không lên ✅ **XONG (2026-09-15)**

`commands/diagnostics.rs` nói thẳng vấn đề: _"Every 'Codex never starts' report used to arrive empty-handed"_ — nên
họ gom log app + log npm + trạng thái thư mục cài thành một blob plain-text copy được. Bản của mình:
`claude --version`, PATH đã resolve, env set đang áp, cwd, và 50 dòng cuối của PTY → một nút Copy trong terminal
và trong workflow step. Rẻ, và đúng thứ thiếu mỗi lần một agent "trông như chết".

---

## Không làm (cố tình)

**Bổ sung 2026-09-15 — hai nhóm, hai lý do khác nhau.**
_(1) Bề mặt IDE:_ editor (kể cả editor kiểu Notion), browser WebKit, research arXiv/Semantic Scholar + đọc PDF,
spaces/canvas, kb-server export ra binary. _(2) Tầng team/cloud:_ comms (chat nội bộ), organisations + auth +
sync outbox + "company brain" (ADR-0006 của họ). Nhóm 2 là Atlas đang đi làm SaaS; station là local-first và
điểm mạnh của nó là **mở được từ máy khác** — kéo cloud vào là đổi cả mô hình bảo mật lẫn vận hành, không phải
thêm một feature. Cộng thêm: **không nuôi một fork engine agent** như `atlas-native-agent`.

Editor, browser tab, research (arXiv/Semantic Scholar), spaces/canvas, org sync đa người. claude-station không
định thành IDE — nó là **control plane**: repo mở bằng IDE thật (`ide.command` trong Settings). Ghi ra đây để
lần sau không ai đề xuất lại.

Cũng không đổi stack sang Tauri/Rust. Web local + Node là quyết định đã chốt ở `claude-station.md`; lợi ích
"mở từ máy khác" đang là điểm mạnh so với Atlas (`.dmg` native, macOS only).

---

## Cần confirm

**Đã chốt 2026-09-15 (đừng mở lại):**

- **Đợt 1 = D1 + A3 + D5.** Bảng giá trước, rồi mission control, kèm số dòng thêm/bớt mỗi turn để dashboard có
  cái vẽ ngoài tiền.
- **D2 giai đoạn 1 KHÔNG gọi LLM.** Chỉ tín hiệu có cấu trúc + một pass keyword bảo thủ. Một lời gọi API mỗi
  turn là tiền thật và là một đường fail mới; Atlas cũng để `memory_compile` mặc định tắt.
- **D3 lưu bảng SQLite**, panel có nút _xuất thành `docs/plans/<tên>.md`_. Lưu file thẳng sẽ biến plan nháp và
  plan bị từ chối thành rác trong repo, và mất khả năng diff theo session.
- **D1 fetch models.dev**: đặt **sau `app.listen`**, fail im lặng, có toggle tắt trong Settings. App local-first
  thì một lời gọi ra ngoài phải tắt được.

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
- 2026-09-15: **đối chiếu lại** Atlas ở `81e6384c` (0.3.2, +115 commit). Bảng so sánh viết lại; A4 bị D2 nuốt;
  A5/B1/B2 đổi hình; thêm **Track D** (D1 bảng giá · D2 shared memory bus · D3 plans panel · D4 session chat ·
  D5 turn analytics · D6 redaction v2 · D7 diagnostics); thứ tự chuyển sang 5 đợt.
- 2026-09-15: **impl xong đợt 1** — D1 (`services/model-pricing.ts`, models.dev, 10.572 model, cột
  `cost_source`), D5 (`linesFromToolUse` + `lines_added`/`lines_removed`), A3 (`routes/insights.ts` +
  trang `/insights`). Migration `0021_turn-cost-lines`. Phát hiện lúc impl: **1785/1786 turn trong ledger
  đang có `model` NULL** vì transcript follower chưa bao giờ ghi model — đã sửa, nhưng turn cũ phải
  _Reindex history_ trong Settings mới có giá.
- 2026-09-15: **impl xong đợt 2** — D6 (`lib/redact.ts`: 15 pattern provider mới, rule `key = value`,
  entropy pass **đo được** 10.8% → 0.3% prompt bị chạm, `redactJson` đi theo cấu trúc), D3
  (`session_plans` + `services/plans.ts` + view Plans trong History + export ra `docs/plans/`), D2
  (`session_memory_events` + `session_memory_cursors` + `services/shared-memory.ts`, inject vào cả
  `buildWorkspaceContext` của SDK lẫn context file của terminal, view Shared trong tab Memory).
  Migration `0022_session-plans`, `0023_shared-memory`.
  **Phát hiện:** transcript store hiện tại **không có một `ExitPlanMode` thật nào** — mọi lần khớp đều là
  dòng liệt kê deferred tools. Nên D3 không backfill được gì; panel bắt đầu từ rỗng và chỉ đầy lên từ giờ.
- 2026-09-15: **impl xong đợt 3 + 4.** A5a (`memory_search` FTS5 + trigger + `renderRetrieved`, note không pin
  giờ vào được prompt; `memory_search` MCP cũng chuyển sang xếp hạng BM25), B1 (`services/packs.ts`,
  preview → chọn → install, pin sha, script bị ghi nhận chứ không bao giờ cài, trang `/packs`), B2a
  (`lib/agent-cli.ts` — codex/opencode/cursor-agent/gemini, dò PATH qua login shell, chạy thành terminal
  `shell` và **nói thẳng** là không có MCP/ledger), D7 (`/api/terminals/:id/diagnostics` + nút Copy),
  C4 (`checkpointsOfRun` + khối "What this run landed"), C6 (`services/workflow-suggest.ts`).
  Migration `0024_packs`. **D4 hoá ra đã có sẵn từ trước** — không impl trùng.
  Còn lại cố ý chưa làm: **A5b** (embedding local + code index) và **B2b** (ACP) — xem § Cần confirm.
