# Plan: A1 — Session ledger

> Plan con của [`atlas-parity-roadmap.md`](atlas-parity-roadmap.md) (phase **A1**) và của [`claude-station.md`](claude-station.md).
> Mọi path tương đối theo `<repo>`. Trạng thái: **L0 → L6 xong (2026-09-03)**. A1 hoàn tất.
> Đi cặp với [`checkpoints.md`](checkpoints.md) (A2) — A2 đọc dữ liệu A1 sinh ra.
> Quyết định chốt thêm 2026-09-03: § QĐ 8 (subagent), `ledger.windowHours = 24`.

## Mục tiêu

Trả lời được 4 câu hỏi mà DB hiện tại **không** trả lời được:

1. Session nào đã **ghi** vào file `X`, lúc nào?
2. Một session đã chạy bao nhiêu lượt, mỗi lượt làm gì, tốn bao nhiêu token?
3. Lúc `T`, những session nào đang chạy trong repo `R`?
4. Prompt gốc của lượt sinh ra thay đổi này là gì?

Không đổi cách chat, không thêm bước nào vào luồng làm việc. Ledger là tầng ghi chạy bên cạnh; capture chết thì app vẫn chạy nguyên như hiện tại.

## Hiện trạng (đo được, không phỏng đoán)

**Hai bề mặt, hai kiểu lưu:**

| Bề mặt | Trạng thái hôm nay |
|---|---|
| Agent SDK session (`kind` = chat/agent/workflow) | `chat_messages.content` giữ raw `SDKMessage` JSON. Muốn biết file nào bị sửa phải parse từng message. Cost đọc ở `claude-session.ts:418` rồi **broadcast xong là mất** |
| Claude terminal (bề mặt chính) | **DB không có gì.** Transcript của CLI ở `~/.claude/projects/<slug>/<uuid>.jsonl`; `lib/claude-transcript.ts` chỉ đọc head 8KB + tail 64KB để dựng danh sách History |

**Ba phát hiện từ việc đọc transcript thật trên máy này (2026-09-03):**

1. **Transcript CLI có đủ thứ cần**: mỗi record `assistant` mang `timestamp`, `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), `cwd`, `gitBranch`, `sessionId`, `isSidechain`, và `tool_use` block có `input.file_path`.
2. **Transcript CLI KHÔNG có cost.** Không hề có `costUSD`/`total_cost_usd` (grep 0 hit). Chỉ SDK's `result` message mới có `total_cost_usd`. → **Quyết định:** ledger lưu **token là số liệu chính**, `costUsd` chỉ điền cho session SDK. Không tự nhân bảng giá — bảng giá thay đổi thì mọi số cũ thành sai, mà không có cách biết số nào đã đúng.
3. **`file-history-delta` không phải đường tắt.** CLI có ghi record `file-history-delta` với `trackingPath` — trông như "danh sách file CLI đã sửa". Đo trên 224 transcript: **0** path nào xuất hiện trong delta mà không có tool call `Edit`/`Write` tương ứng, và chỉ 57/224 file có delta. Nghĩa là nó chỉ mirror Edit/Write, **không** bắt được edit qua `Bash` (`sed -i`, heredoc, `tee`) — đúng cái auto mode dùng suốt.

4. **Record `type:"user"` phần lớn KHÔNG phải prompt của user.** Tool result quay về cũng là record `type:"user"`. Trên transcript lớn nhất (29.3MB): **336** record `user`, trong đó **285 là `tool_result` echo**, chỉ **51** là prompt thật (49 content string + 2 content blocks). Đếm sai thì token/turn lệch ~6.6 lần và cửa sổ ứng viên của A2 đầy rác. → Turn = record `user`, `isSidechain=false`, **và** content không chứa block `tool_result`.

Phát hiện (3) định hình cả plan: **danh sách file lấy từ `tool_use` là gợi ý, không phải sự thật.** Muốn có sự thật thì phải hỏi git (§ L4).

## Quyết định thiết kế (và lý do)

### 1. Đơn vị ghi là **turn**, không phải message

Một turn = một lượt user gửi → agent làm xong. Lý do: đây là đơn vị mà mọi câu hỏi ở § Mục tiêu hỏi tới, và là đơn vị A2 cần để gán commit. Message-level thì `chat_messages` đã có rồi và nó không giúp gì thêm.

### 2. Ghi **metadata + prompt full của user**, cắt tool input/output

Chốt theo đề xuất đã bàn:

- **Prompt của user: lưu full** (sau redaction). Nó ngắn, và là thứ đáng giá nhất — "chat với checkpoint" và search đều dựa vào nó.
- **Tool input/output: không lưu nội dung**, chỉ lưu tên tool + path + thao tác. Cần chi tiết thì đọc lại transcript gốc / `chat_messages`.
- Hệ quả phải nói thẳng: xoá transcript ở tab History thì **mất chi tiết tool**, nhưng prompt + file list + token vẫn còn. Đây là đánh đổi có ý thức, không phải bug.

### 3. Transcript gốc vẫn là source of truth, ledger là **index**

Ledger có thể dựng lại từ transcript bất cứ lúc nào (§ L5). Nên: mất ledger không mất dữ liệu; và bug parser thì reindex, không phải migrate.

### 4. Session id: hai cột nullable, không dựng bảng trung gian

```
sourceKind        'sdk' | 'cli'
chatSessionId     FK chat_sessions  — set khi sourceKind='sdk'
claudeSessionId   uuid của CLI      — set khi sourceKind='cli'; KHÔNG phải FK
terminalId        FK terminals      — set khi biết tab nào; NULL với transcript backfill
```

`claudeSessionId` **không** làm FK vì một transcript sống lâu hơn (hoặc có trước) mọi row `terminals` — đúng cái tab History đang liệt kê: "From the CLI" gồm cả conversation app chưa từng thấy. Dựng bảng session hợp nhất thì phải viết row giả cho những conversation đó, và xoá terminal sẽ cascade mất lịch sử.

### 5. Follower đọc **incremental theo byte offset**, không đọc lại file

`claude-transcript.ts` có comment rõ: *"Never read a whole file; one of them is 16MB."* Follower giữ nguyên nguyên tắc đó — lưu `byteOffset` đã xử lý, mỗi lần chỉ đọc phần mới. Offset ghi vào DB nên restart/detach tiếp tục được, không parse lại từ đầu.

### 6. Redaction chạy **trước khi ghi disk**, không phải trước khi render

Ledger sẽ chứa prompt user. Nguồn secret đã biết: `env_vars.is_secret = 1` (đã có sẵn cột này). Scrub theo **giá trị** các biến đó + pattern chung (`ghp_`, `Bearer …`, `-----BEGIN … PRIVATE KEY-----`, `atlassian` PAT). Một module riêng `lib/redact.ts` để test được độc lập.

### 7. Ghi lỗi thì **degrade, không throw**

Mọi hook ledger bọc try/catch và chỉ hạ `session_capture.status`. Cùng triết lý `git-watch.ts` đang dùng cho watcher chết ("A dead watcher just means the client falls back to its slow poll — not a broken tab").

### 8. Turn của subagent gộp vào turn cha

Một `Task` (subagent) **không** tạo turn riêng: nó là một tool call trong lượt của user, và "một lượt user" là đơn vị mọi câu hỏi ở § Mục tiêu hỏi tới. Nhưng file nó sửa vẫn phải lần được, nên `session_files.toolName` ghi `Task:<agentName>` thay vì chỉ `Task` — thấy được subagent nào chạm file gì mà không thêm bảng nào.

(Chốt 2026-09-03. Đánh đổi: một session có 6 subagent chạy song song thì mọi file dồn vào một turn — chấp nhận, vì A2 gán commit theo *session* chứ không theo subagent.)

## Schema

Migration mới qua `npm run db:generate` (kế tiếp `0015_projects-board.sql`).

```ts
// server/src/db/schema.ts

session_turns (
  id, projectId → projects (cascade),
  sourceKind,                 // sdk | cli
  chatSessionId,              // nullable, FK chat_sessions (cascade)
  claudeSessionId,            // nullable, CLI uuid — no FK on purpose (§ QĐ 4)
  terminalId,                 // nullable, FK terminals (set null)
  workflowRunId,              // nullable — seam cho C4, điền sẵn từ giờ
  seq,                        // thứ tự turn trong session
  cwd,                        // repo path hoặc worktree path turn này chạy trong
  gitBranch,                  // nullable
  model,                      // nullable
  promptText,                 // full, đã redact
  promptPreview,              // 200 ký tự đầu, cho list
  inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
  costUsd,                    // nullable — CHỈ có với sdk (§ Hiện trạng 2)
  durationMs,                 // nullable
  toolCallCount,
  status,                     // running | done | error | interrupted
  startedAt, endedAt          // endedAt nullable
)
index (projectId, startedAt) · index (chatSessionId, seq) · unique (claudeSessionId, seq)

session_files (
  id, turnId → session_turns (cascade),
  projectId,                  // denormalize: query "ai sửa file này" không phải join
  projectPathId,              // nullable, FK project_paths — repo nào trong project
  absPath, relPath,
  op,                         // read | write | delete
  source,                     // tool | tree   ← tree = sự thật, tool = gợi ý
  toolName                    // nullable
)
index (projectId, absPath) · index (turnId)

session_capture (
  claudeSessionId PRIMARY KEY,   // chỉ CLI cần follower; sdk là in-process
  projectId, terminalId,         // nullable
  transcriptPath,                // nullable — CLI tự prune transcript của nó
  byteOffset,                    // điểm tiếp tục của follower
  mtimeMs, sizeBytes,            // để boot bỏ qua transcript không ai append (quyết định ở L0)
  lastEventAt, updatedAt,
  status,                        // ok | degraded | stopped
  detail                         // lý do, hiện thẳng lên Doctor
)
```

Ba bảng, không có bảng thứ tư: `checkpoints` thuộc A2, và **không** dựng bảng lưu diff/patch — `git.ts` đã có `commitPatch()`/`diff()` tính lại được, lưu thêm là hai nguồn sự thật.

## Chạm vào tính năng sẵn có (và sửa gì cho khớp)

Đây là phần user yêu cầu nói rõ. Không có feature nào bị đổi hành vi; chỗ nào phải sửa thật thì ghi rõ:

| Tính năng đang có | Liên kết / sửa gì |
|---|---|
| **Claude terminal** (`services/terminals.ts`, `pty-manager.ts`) | Tạo terminal `kind=claude` → mở follower cho `claudeSessionId`. Đóng/exit → đóng follower. **Không sửa** luồng spawn: `--session-id` đã có sẵn ở `lib/claude-cli.ts` |
| **Agent SDK session** (`services/claude-session.ts`) | Thêm hook ở 3 điểm đã tồn tại: `sendUserMessage` (mở turn), vòng `for await` chỗ đọc `tool_use` (`:122` qua `previewOf`) → ghi `session_files` source=`tool`, nhánh `message.type === "result"` (`:418`) → đóng turn với token/cost. `catch` + `interrupt()` → `status=error|interrupted` |
| **History tab** (`web/src/features/history/HistoryTab.tsx`, `routes/terminals.ts`) | Mỗi row hiện thêm: số turn, token, file đã sửa. Nút xoá transcript **giữ nguyên hành vi** nhưng thêm cảnh báo "prompt + file list vẫn giữ, chi tiết tool sẽ mất". Row "From the CLI" chưa có ledger → nút *Index* (gọi L5) |
| **Diff tab** (`features/git/DiffTab.tsx`) | File uncommitted hiện badge "sửa bởi session … lúc …" — đọc `session_files` mới nhất theo `absPath`. Đây là cái nhìn thấy giá trị sớm nhất, làm ở L6 |
| **Workflow run** (`services/workflow-runner.ts`) | Step `agent` đã tạo chat session sẵn → turn tự có `workflowRunId` nếu điền cột. **Điền từ giờ** để C4 (run → commit) sau này không phải migrate |
| **Search** (`services/search.ts`, FTS5) | Thêm virtual table `turn_search(prompt_text, project_id, turn_id)` cạnh `chat_search`/`knowledge_search` đang có; `ensureSearchTables()` mở rộng. Cho phép tìm "commit nào từ prompt có chữ tmux" |
| **Backup/export** (`services/backup.ts`) | 3 bảng mới đi theo DB tự động. **Phải sửa** `rewritePaths()`: thêm `rewrite("session_files","abs_path")` và `rewrite("session_turns","cwd")`, vì import trên máy khác thì prefix data dir đổi |
| **Doctor** (`routes/settings.ts:32`) | Thêm check *capture health*: đếm session `degraded`/`stopped` + lý do. Đây là phần A3 dùng lại nguyên |
| **Boot reconcile** (`server/src/index.ts`) | Thêm `reconcileLedgerOnBoot()` cạnh `reconcileRunsOnBoot()`/`reconcileWorktreesOnBoot()` đang có: turn `running` mà process đã chết → `interrupted`; follower của terminal tmux còn sống → catch-up từ `byteOffset` |
| **Settings** (`shared/src/types.ts:1142`) | Thêm `ledger.enabled` (bool, default true), `ledger.treeSnapshot` (bool, default true — chốt bằng số đo L0), `ledger.windowHours` (int, default **24** — A2 dùng, chốt 2026-09-03) |

## Các bước

### L0 — Spike đo trước, không viết schema trước ✅ **XONG 2026-09-03**

Đo trên máy này (macOS, Node 25.9, repo iOS thật ở `~/iOS`). Prototype parser ở scratchpad, không nằm trong repo.

**Kết quả 1 — `git status` trên repo iOS thật (quyết định L4):**

| Repo | Tracked | Trên disk | `status --porcelain -uall` | `diff --name-only HEAD` |
|---|---|---|---|---|
| `IIP555-ReelMe` | 1237 | 336M | 26–33 ms | 23 ms |
| `IIP555-Reelme-AI-Video` | 1393 | **6.3G** | 32–54 ms | 20 ms |
| `IIP707` | 957 | 50M | 23–30 ms | 20 ms |
| `ISI888-PixMine-IOS` | 1146 | 4.3G | 25–36 ms | 19 ms |
| `claude_station` | 270 | — | 23 ms | — |

→ **`ledger.treeSnapshot` bật mặc định (`true`).** Ngưỡng đặt ra là ≤ 1.5s; thực tế **cao nhất 54ms**, kém ngưỡng 27 lần. Hai lần `status` mỗi turn ≈ 0.1s — không đáng kể so với một turn hàng chục giây.

Ghi chú trung thực: comment ở `git-watch.ts:3` nói một lần `status` trên repo mobile "costs the better part of a second" — **không reproduce được**. 6.3GB kia gần hết là file bị `.gitignore`, và git bỏ qua ở mức thư mục nên không enumerate sâu. Cây đo được đều **sạch** (0–2 entry). Cây có hàng nghìn file *untracked* (không phải ignored) sẽ chậm hơn: nếu gặp, hạ `-uall` xuống `--untracked-files=normal` (gộp theo thư mục) thay vì tắt L4.

**Kết quả 2 — parse transcript (quyết định L3/L5):**

| Kịch bản | Số liệu |
|---|---|
| File lớn nhất, parse full (backfill 1 session) | 29.3MB → **55ms**, ~530 MB/s, RSS +53MB |
| Cùng file, tail 64KB (một lần append lúc follow) | **0.9ms**, RSS +0.6MB, 1 dòng cắt giữa → buffer xử lý đúng |
| **Toàn bộ history** (219 file, 306MB) | **820ms**, 373 MB/s, RSS +154MB, file chậm nhất 65ms |
| Nội dung: | 71.746 record → **1.349 turn thật**, 14.515 tool call, 0 dòng lỗi |

→ **Sửa quyết định về backfill:** plan cũ nói "nút bấm, không chạy lúc boot" vì sợ 224 transcript làm boot chậm. Đo được **820ms cho toàn bộ**, nên: boot **có** quét, nhưng **incremental** — bỏ qua file mà `(mtime, size)` không đổi so với `session_capture` (đúng cơ chế cache đang có ở `claude-transcript.ts`), nên boot lần thứ hai gần như 0. Nút trong Settings đổi vai thành **full reindex** (khi sửa parser). Insert DB ước tính ~16k row trong một transaction ≈ 150–200ms; chưa đo, đo ở L1.

Cảnh báo về RSS: +154MB khi chạy liên tục 219 file (GC chưa kịp chạy). Backfill phải `await` giữa các file để nhường event loop, không parse cả loạt đồng bộ như prototype.

**Kết quả 3 — xác nhận lại điểm mù `Bash` (quyết định cốt lõi của L4):** dùng chính session viết plan này làm ca thử. 3 file plan được tạo bằng `Write`, sau đó **sửa 7 lần bằng `python3 <<heredoc` qua Bash**:

```
file-history-delta ghi nhận:  3 file  (đúng 3 file mà Write đã tạo)
tool_use Write/Edit:          3 file  (cùng 3 file đó)
Bash ghi vào docs/plans:      7 lệnh  → 0 record delta mới, 0 tool_use path
```

Mạnh hơn cả thống kê 224 file: `file-history-delta` chỉ xuất hiện **vì `Write` chạm file trước**. 7 lần sửa sau đó bằng Bash **vô hình hoàn toàn** ở cả hai nguồn — và nếu một session chỉ dùng Bash thì file đó không tồn tại trong bất kỳ record nào. Xác nhận L4 là **bắt buộc**, không phải tùy chọn.

### L1 — Schema + write API + redaction ✅ **XONG 2026-09-03**

- 3 bảng + migration `server/drizzle/0016_session-ledger.sql`. Đã thử apply lên **bản copy của DB thật**: 3 bảng lên đủ, dữ liệu cũ nguyên (7 project / 29 chat_messages / 123 terminals).
- `server/src/services/session-ledger.ts` — write: `openTurn()`, `recordFiles()`, `closeTurn()`, `bumpToolCalls()`, `markInterrupted()`; read: `turnsOf()`, `filesOf()`, `turnsTouching()`, `turnsRunningAt()`; capture: `saveCapture()`, `getCapture()`, `captureHealth()`; phụ trợ: `resolveProjectPath()`, `secretValues()`/`forgetSecrets()`, `ledgerEnabled()`.
- `server/src/lib/redact.ts` — `redact()` / `redactVerbose()`, thuần (nhận sẵn danh sách secret nên không import DB, test được độc lập). 11 pattern, cộng match literal theo giá trị `env_vars.is_secret`.
- Settings: `ledger.enabled` (true), `ledger.treeSnapshot` (true), `ledger.windowHours` (24) trong `shared/src/types.ts`.
- Test: 22 case cho `redact` + 33 cho ledger + 3 cho ca **tắt ledger** (file riêng, mock `lib/config`). `npm run check` xanh: 167 test / 15 file.

**Thêm so với plan gốc** (ghi lại để plan khớp code):

- `bumpToolCalls()` — L2/L3 đếm tool call theo từng lượt stream, không đợi cuối turn mới ghi.
- `saveCapture()`/`getCapture()`/`captureHealth()` làm luôn ở L1 vì bảng đã có; L5 chỉ còn việc gọi.
- `session_capture` đổi `lastLineNo` → `mtimeMs` + `sizeBytes` (boot scan incremental cần chúng, `lastLineNo` không ai dùng).
- Test ledger dùng **DB thật trong thư mục tạm** qua `CLAUDE_STATION_DATA` + dynamic import (env phải set trước khi `../../db` được import, vì module đó resolve path và chạy migration ngay lúc load). Không mock DB.

**Hai quyết định nhỏ phát sinh khi viết:**

1. **Dedupe `session_files` theo `(source, op, path)`**, không theo path. Một claim `tree` không bao giờ được gộp vào claim `tool` cho cùng file — chính chỗ khác biệt đó là thứ A2 chấm điểm.
2. **`resolveProjectPath()` trả `NULL` cho file trong worktree riêng của session** thay vì map về repo. Map ở đây thì hai cây khác nhau nằm chung một path id; A2 tự map worktree → repo, nơi có đủ ngữ cảnh.

**Xong L1 chưa ai thấy gì trên UI** — bình thường, L1 chỉ là API. Cái nhìn thấy đầu tiên là badge ở Diff tab (L6).

### L2 — Nguồn ghi: Agent SDK session ✅ **XONG**

Hook 5 chỗ trong `claude-session.ts`, không thêm luồng mới: `sendUserMessage` (mở turn + snapshot cây), vòng `for await` chỗ đọc `tool_use` (ghi file + đếm tool call ngay khi stream, không gom cuối turn — turn bị crash vẫn giữ những gì nó đã chạm), nhánh `result` (usage + cost + duration), `catch`/`finally` (error/interrupted), và `interrupt()`.

- `Live.turnId` giữ turn đang mở → **retry sau resume-fail vẫn là MỘT turn**. `Live.treeBefore` giữ snapshot đầu turn.
- `workflowRunIdOf()` tra `workflow_run_steps` → `session_turns.workflowRunId`, seam cho C4.
- Tách `lib/tool-files.ts` (`filesFromToolUse`, `toolLabel`) vì L3 dùng lại đúng logic — 11 test.
- Test integration: mock `query` của SDK bằng async generator, chạy thật `sendUserMessage`. Một phần tử trong stream có thể là **function** → chạy như side effect, đó là cách mô phỏng edit qua Bash. 14 test.

### L3 — Nguồn ghi: CLI terminal follower ✅ **XONG**

`lib/transcript-parse.ts` (parse thuần, 24 test) + `services/transcript-follower.ts` (stateful).

- **Đổi so với plan:** parser nằm ở file riêng chứ không nhồi vào `lib/claude-transcript.ts` — file đó lo *tìm/liệt kê* transcript, parse là việc khác và đã đủ lớn để đứng riêng.
- Hai cơ chế đánh thức: `fs.watch` cho tức thì + sweep 3s cho đúng (watcher chết, transcript chưa tồn tại lúc mở tab, hoặc file được ghi lúc server không chạy). Drain rỗng chỉ tốn một `statSync`.
- `follow()` gọi từ `createTerminal` **sau khi** insert row (FK `session_turns.terminal_id`); `stopFollowing()` ở route đóng tab và xoá history; `followOpenClaudeTerminals()` ở boot; `unfollowAll()` lúc shutdown.
- `indexTranscript()` (một lần, từ byte 0) và `catchUpTranscript()` (tiếp từ offset) dùng chung `drainFollower`.
- **Bug tự bắt được bằng test:** offset đã trừ phần dòng cắt giữa, nên lần đọc sau **đã bao gồm** nó — giữ thêm `leftover` trong RAM là parse hai lần. Bỏ hẳn state đó: dòng dở nằm *sau* offset, lần sau đọc lại từ disk là đủ.
- **Turn không có điểm kết:** CLI không ghi marker "hết turn". Nên mỗi drain `closeTurn(..., keepOpen)` — turn luôn được lưu với tổng tốt nhất đã biết, append sau chỉ cập nhật lại cùng row. Không turn nào treo `running`.
- Restart giữa turn: activity đến mà không có turn mở → **nhận turn cuối cùng của hội thoại đó** thay vì tạo turn không prompt.
- 22 test, gồm: append, dòng cắt giữa, restart, transcript bị xoá, file bị truncate, subagent (`Task/Edit` gán vào turn cha).

### L4 — Sự thật về file: snapshot cây git ở biên turn ✅ **XONG**

`services/tree-snapshot.ts` — 19 test trên repo git thật trong thư mục tạm.

- `snapshotTree(cwd)` = HEAD + `git status --porcelain=v1 -uall -z`. Dùng `-z` vì path có thể chứa space/newline; rename/copy mang hai path.
- **Bổ sung không có trong plan gốc, do test bắt ra:** turn **tự commit** giữa đường thì cây sạch ở cả hai đầu → so status thấy *không có gì*. Phải nhìn cả HEAD: `committedBetween()` chạy `git diff --name-status -z <from>..<to>`. Không có nó thì turn làm việc xong xuôi nhất lại trông như turn không làm gì.
- SDK: snapshot ở `sendUserMessage`, so ở nhánh `result` **và** ở `finally` (turn bị interrupt vẫn ghi được phần đã sửa).
- CLI: turn không có biên do mình kiểm soát → so **drain này với drain trước**, và **chỉ khi drain đó thấy activity**. Cây đổi mà không có activity nào là người sửa tay, không phải turn.
- Pass đầu chỉ lấy baseline: không có gì để so thì mọi file đang dirty sẽ bị vu cho turn này.
- Giới hạn ghi rõ trong code: `tree` nghĩa là "đổi trong lúc turn chạy" — bằng chứng mạnh, **không phải chứng minh**. A2 chấm điểm nó chứ không tin tuyệt đối.

### L5 — Backfill + capture health ✅ **XONG**

`services/ledger-backfill.ts` — `scanTranscripts({projectId?, full?})`.

- Ba nhánh: chưa từng thấy → index full; đã có capture row mà `(mtime, size)` đổi → `catchUpTranscript` (chỉ đọc phần append); còn lại → skip. Tab đang follow live thì luôn skip, reindex dưới chân nó sẽ xoá turn nó đang ghi.
- Chủ sở hữu hội thoại xác định bằng `cwd` của transcript so với `project_paths`, **prefix dài nhất thắng** — cùng quy tắc với file.
- Chạy ở boot (đổi so với plan gốc, theo số đo L0) + `POST /api/ledger/index` (và `.../:id/ledger/index`), `full: true` = reindex toàn bộ sau khi sửa parser.
- **Bug tìm ra khi chạy thật:** `statSync` trả `mtimeMs` là float, cột khai `integer` nhưng SQLite lưu nguyên float → điều kiện skip **không bao giờ khớp**, mỗi lần scan đều đọc lại. Đã `Math.round` lúc ghi. Trước khi sửa: `caughtUp: 80`; sau khi sửa: `skipped: 106` cả hai lần liên tiếp.
- `captureHealth()` cắm vào `GET /api/doctor` (`ledgerCapture`) và `GET /api/ledger/health`.

### L6 — Đọc: API + UI ✅ **XONG**

`routes/ledger.ts`: `GET .../ledger/turns` (theo hội thoại), `.../ledger/recent` (mới nhất của project), `.../ledger/turns/:turnId` (prompt full + file list), `.../ledger/file?path=` (ai sửa file này), `POST .../ledger/index`, `GET /api/ledger/health`. List trả `promptPreview`, chỉ chi tiết một turn mới trả `promptText` full.

UI:
- `web/src/features/git/LedgerAttribution.tsx` — trong header của Diff tab khi chọn một file đang đổi: turn nào sửa gần nhất, prompt + thời điểm ở tooltip. **Im lặng khi không có gì để nói** (file người sửa tay thì không có turn nào).
- `web/src/features/history/TurnsPanel.tsx` + `HistoryTab` thành 2 view **Turns / Activity**. Cố tình không trộn: một bên là quyết định của agent, một bên là side effect của app. Mở một turn thì thấy file list kèm nguồn (`tree` vs tên tool) — chỗ khác biệt đó chính là thông tin.

## Phát hiện khi impl (ngoài plan gốc)

Ba thứ chỉ lộ ra khi chạy trên dữ liệu và máy thật:

1. **`shared/src/*.js` cũ che mất `.ts`.** File build leftover (gitignored) làm 3 settings key mới **không tồn tại lúc runtime**, `openTurn` trả null, 23 test fail với "expected null not to be null" trong khi typecheck xanh. Vite resolve `./types` ưu tiên `.js` trước `.ts`. Sửa: `rm -f shared/src/*.js`.
2. **So path phải case-insensitive trên macOS.** `~/iOS/…` và `~/IOS/…` là **một** thư mục, và CLI ghi `cwd` theo cách shell đang viết. So prefix bằng string thì file không thuộc repo nào → `projectPathId` NULL → attribution của A2 yếu đi mà không có lỗi ở đâu. Thêm `lib/path-compare.ts` (12 test); `turnsRunningAt` lọc cwd ở JS chứ không ở SQL vì SQLite so text case-sensitive; `turnsTouching` match theo `(projectPathId, relPath)` — nửa mà hai bên chắc chắn đồng ý.
3. **`mtimeMs` float trong cột integer** làm điều kiện skip của boot scan không bao giờ đúng (xem L5).

Và một giới hạn phải nói rõ: **history backfill không có `tree` row.** Không thể snapshot cây git của quá khứ. Turn cũ chỉ có file từ `tool_use`, nên với chúng điểm mù `Bash` vẫn còn — chỉ turn chạy live từ giờ mới có sự thật đầy đủ. Trên máy này sau lần chạy đầu: 1.198 turn / 1.499 file row, trong đó 5 row `tree`.

## Edge case

| Case | Xử lý |
|---|---|
| Transcript bị xoá giữa lúc follow (nút xoá ở History) | Follower đóng, `status='stopped'`, `detail='transcript deleted'`. Turn đã ghi giữ nguyên |
| Transcript 16MB (đã gặp thật) | Chỉ đọc incremental; backfill đọc streaming theo dòng, không `readFileSync` |
| Server restart giữa turn | Boot reconcile: `running` → `interrupted`. Với CLI, follower catch-up từ offset nên turn đó vẫn đóng đúng |
| Terminal tmux detached, server chết, mày làm tiếp trong Terminal.app | CLI vẫn append transcript. Lúc reattach follower đọc từ `byteOffset` → **không mất turn nào**. Đây là lý do offset phải nằm trong DB |
| Cùng repo, 2 tab Claude | Turn phân biệt bằng `claudeSessionId`; `session_files` của cả hai cùng trỏ một path — đúng, không dedupe |
| Session dùng worktree riêng (`data/worktrees/<id>`) | `cwd` lưu path worktree; `projectPathId` map về repo gốc để "file này ai sửa" vẫn trả lời được |
| Conversation chạy ngoài app, chưa từng có tab | Chỉ có `claudeSessionId`, `terminalId=NULL`. Vẫn index được (L5) |
| Prompt chứa secret không nằm trong env set nào | Redaction không bắt được. Nói thẳng trong UI: ledger là dữ liệu local như transcript, và `data/` đã gitignore |
| Backfill làm số liệu nhảy về quá khứ | A3 phải nhận biết; ghi `session_capture.updatedAt` để phân biệt "khi xảy ra" vs "khi index" |
| Monorepo: 1 repo, nhiều `project_paths` | `projectPathId` chọn path **dài nhất** khớp prefix của `absPath` |
| `ledger.enabled=false` | Không hook gì, không bảng nào lớn thêm. Feature phải tắt được sạch |

## Test

- Unit: `redact.ts` (secret theo giá trị, pattern, không phá text thường), `parseIncremental` với fixture JSONL (gồm dòng cắt giữa, record `isSidechain`, record không có `usage`).
- Unit: attribution helper `turnsRunningAt()` — A2 phụ thuộc trực tiếp.
- Integration: một chat session SDK giả → mở/đóng turn đúng, token khớp.
- Regression: `npm run check` (typecheck + eslint + vitest) phải xanh. Prettier **chỉ format file mình chạm** (repo có ~53 file lệch từ trước).

## Cần confirm

**Đã chốt 2026-09-03:**

- Cửa sổ gán commit: **`ledger.windowHours = 24`** (user: "lúc nhanh lúc chậm").
- Subagent: **gộp vào turn cha** (§ QĐ 8).
- FTS5 index prompt: làm ở **L6** cùng read API, không ở L1 — L1 giữ đúng phạm vi "write API + redaction", không chạm `search.ts` sớm.
- Retention: **không xoá tự động**. Ước lượng ~1KB/turn → 10k turn ≈ 10MB. Thêm nút "purge trước ngày X" chỉ khi thực sự cần.

- `ledger.treeSnapshot` = **`true`** (chốt sau L0: cao nhất 54ms trên repo iOS 6.3GB, kém ngưỡng 1.5s những 27 lần).
- Backfill: boot quét **incremental**, nút Settings là full reindex (đổi so với plan gốc, theo số đo L0).
- Turn detection: loại record `user` chứa block `tool_result` (285/336 record ở file đo).

**Còn mở:** không còn câu nào chặn L1.
