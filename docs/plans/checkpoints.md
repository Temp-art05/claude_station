# Plan: A2 — Checkpoints (commit ↔ session)

> Plan con của [`atlas-parity-roadmap.md`](atlas-parity-roadmap.md) (phase **A2**) và của [`claude-station.md`](claude-station.md).
> **Phụ thuộc [`session-ledger.md`](session-ledger.md) (A1)** — cụ thể là `session_files` với `source='tree'` (L4, đã chốt bật mặc định sau khi đo L0).
> Mọi path tương đối theo `<repo>`. Trạng thái: **M0 → M6 xong (2026-09-03)**. A2 hoàn tất.
> Quyết định chốt 2026-09-03: cửa sổ 24h, badge `inferred` **có** hiện, watcher nội bộ watch riêng `.git`.

## Mục tiêu

Biến `git log` từ "ai commit" thành "**vì sao có commit này**":

1. Mỗi commit chỉ được đúng session/turn đã sinh ra nó, kèm prompt gốc.
2. Bấm vào một commit → mở lại cuộc hội thoại đó, hoặc **chat với chính checkpoint** đó.
3. Một session → tập commit chính xác của nó (để review, hoặc để revert đúng phần nó làm).
4. Liên kết **không đứt** khi `--amend` / rebase.

Nguyên tắc xuyên suốt: **thà nói "không biết" hơn là gán sai.** Một badge sai còn tệ hơn không có badge, vì mày sẽ tin nó.

## Lợi thế so với Atlas — và chỗ mình yếu hơn

Atlas phải đoán hoàn toàn: nó observe commit rồi reconcile bằng heuristic. Mình **tự cấp `--session-id`** khi spawn CLI (`lib/claude-cli.ts`, `terminals.ts:48`) và sở hữu luôn Agent SDK session, nên với commit tạo *từ trong app* mình biết **chắc**, không đoán.

Chỗ yếu hơn: Atlas là app native luôn chạy; mình là server có thể tắt. Commit tạo lúc server tắt vẫn bắt được (§ M1) nhưng **turn tương ứng có thể không có** nếu terminal đó cũng không chạy qua app → orphan. Chấp nhận.

## Hiện trạng (đọc code, không phỏng đoán)

**Cái đã có, dùng lại được nguyên:**

| Có sẵn | Ở đâu | Dùng cho |
|---|---|---|
| Watch `.git/HEAD`, `refs`, `packed-refs` | `services/git-watch.ts:34` (`GIT_DIR_WATCHED`) | Phát hiện commit mới |
| `log()`, `commitFiles()`, `commitPatch()` | `services/git.ts:667, 701, 718` | Đọc commit + file + diff |
| `commit()` của app | `services/git.ts:495`, `routes/git.ts:304` | Nguồn attribution `exact` |
| `listWorktrees()`, `createWorktree()` | `services/git.ts:56, 24` | Worktree riêng của session |
| API `git/log`, `git/commit-files`, `git/show` | `routes/git.ts:184, 198, 211` | UI đã có, chỉ enrich thêm |
| Diff tab + side-by-side viewer | `web/src/features/git/` | Chỗ đặt badge |

**Cái phải sửa — và đây là chỗ quan trọng nhất của plan:**

`watchTree()` ở `git-watch.ts:70` **refcount theo listener của UI**: watcher chỉ dựng khi có client mở WS `/ws/git/:projectId`, và **tự tháo khi client cuối rời đi** (`git-watch.ts:104-112`). Nghĩa là:

> Đóng tab Diff → không còn ai watch → **commit tạo sau đó không ai thấy.**

Nó đúng cho mục đích ban đầu (tín hiệu refresh cho UI, không nên trả giá khi không ai xem) nhưng **sai hoàn toàn** cho checkpoint. Đây là "sửa tính năng sẵn có cho khớp plan mới" — chi tiết ở § M0.

## Quyết định thiết kế (và lý do)

### 1. Observe, không intercept

Không hook `git commit`, không cài git hook vào repo của user. Lý do: hook chỉ bắt được commit tạo từ trong app, mà phần lớn commit mày tạo từ terminal thật hoặc từ Xcode/Android Studio. Và cài hook vào repo người khác là xâm phạm — repo là của mày, không phải của app.

Đổi lại: attribution là suy luận với những commit ngoài app. Nên mới cần 3 mức confidence.

### 2. Ba mức confidence, hiện rõ trên UI

| Mức | Khi nào | Hiện thế nào |
|---|---|---|
| `exact` | Commit do chính app tạo (`git.ts commit()` gọi từ một session/MCP tool) **hoặc** đúng một session đang chạy trong cây đó tại thời điểm commit và có `session_files` khớp | Badge đầy, tên session |
| `inferred` | File của commit giao với `session_files` của một turn trong cửa sổ thời gian; điểm đủ cao và không có turn khác cạnh tranh | Badge mờ + dấu `~`, tooltip nói lý do và điểm |
| `orphan` | Không đủ căn cứ | **Không** badge. Có thể lọc "chỉ xem orphan" để biết chỗ nào ledger còn mù |

**Chốt 2026-09-03: `inferred` CÓ hiện** — nhưng phải khác `exact` rõ ở mức nhìn là biết (badge viền rỗng + tiền tố `~`, không phải chỉ nhạt màu hơn), và tooltip luôn nói điểm + lý do. Lý do chọn hiện: nếu chỉ tin `exact` thì badge rất thưa — nhất là khi `ledger.treeSnapshot` tắt, lúc đó gần như mọi commit ngoài app đều tụt xuống `inferred`, và một feature không thấy gì thì coi như không có.

Squash làm nhập nhằng thật → `orphan`, đúng cách Atlas làm. Không có mức thứ tư kiểu "guess".

### 3. Attribution dựa vào `source='tree'` trước, `source='tool'` sau

A1 § Hiện trạng đo được: `tool_use` **không** thấy edit qua `Bash` (auto mode dùng liên tục). Nên:

- Có `session_files` với `source='tree'` (snapshot cây git ở biên turn, A1/L4) → dùng nó, đó là sự thật.
- Chỉ có `source='tool'` → vẫn chấm điểm được nhưng **hạ một mức** confidence (`exact` → `inferred`), vì tập file chắc chắn thiếu.

Hệ quả: **A1/L4 tắt thì A2 chỉ ra `inferred`/`orphan`.** Ghi rõ ở đây để không ai ngạc nhiên. (L0 đo được `git status` chỉ 25–54ms trên repo iOS 6.3GB nên L4 bật mặc định — trường hợp tắt là ngoại lệ, không phải mặc định.)

### 4. Sống qua amend/rebase bằng `patch-id`, không phải bằng sha

`git commit --amend` sinh sha hoàn toàn mới → link theo sha đứt ngay. Nên lưu thêm `git patch-id --stable` (hash nội dung diff, không đổi khi sửa message hay rebase lên base khác).

Thuật toán khi thấy sha lạ:
1. Tính patch-id.
2. Có checkpoint nào cùng patch-id mà sha của nó **không còn reachable** từ bất kỳ ref nào → **re-point** checkpoint đó sang sha mới, ghi `supersededSha` để lần vết.
3. Không khớp, hoặc sha cũ vẫn reachable → checkpoint **mới**, đi attribute bình thường.

**Đo thật ở L0 (2026-09-03), cả 4 giả định đều đúng:**

| Thao tác | sha | patch-id | sha cũ còn reachable? | Kết luận |
|---|---|---|---|---|
| `--amend` (chỉ đổi message) | đổi | **giữ nguyên** | không | → re-point |
| `rebase` lên base khác | đổi | **giữ nguyên** | **không** | → re-point |
| `cherry-pick` | đổi | **giữ nguyên** | **có** (bản gốc vẫn nằm trên nhánh cũ) | → checkpoint **riêng**, không re-point |
| squash 2 → 1 | đổi | **đổi** | không | → orphan |

**Sửa so với bản plan đầu:** điều kiện phải là **reachability**, không phải `git cat-file -e`. Đo được: sau rebase, object của sha cũ **vẫn còn trong repo** (chưa gc) nên `cat-file -e` vẫn thành công — dùng nó thì không bao giờ re-point được. Kiểm tra đúng là `git merge-base --is-ancestor <sha> <mỗi ref>`, hoặc rẻ hơn: `git rev-list --all --quiet --objects <sha>` / `git branch --contains <sha>` rỗng.

Và chính reachability là thứ phân biệt **rebase với cherry-pick** — hai trường hợp có patch-id giống nhau y hệt nhưng phải xử lý ngược nhau. Không có nó thì cherry-pick sẽ ăn cắp checkpoint của commit gốc.

Squash gộp N commit → patch-id mới không khớp cái nào → orphan. **Không** chia phần cho N session.

### 5. Không lưu diff/patch vào DB

`commitPatch()` tính lại được. Lưu là hai nguồn sự thật, và DB phình theo repo. Cùng lý do A1 không lưu tool output.

### 6. Checkpoint là bảng riêng, `work_history` giữ nguyên vai trò

`work_history` là audit feed người-đọc (đang được ghi từ 25 chỗ). Checkpoint là dữ liệu quan hệ để query. Không nhồi vào nhau. Nhưng khi tạo checkpoint `exact`, ghi **một** dòng `work_history` kind=`checkpoint` để nó xuất hiện trong History tab như mọi việc khác.

## Schema

```ts
// server/src/db/schema.ts — migration kế tiếp A1

checkpoints (
  id,
  projectId → projects (cascade),
  projectPathId,          // nullable, FK project_paths (set null)
  repoPath,               // cây git chứa commit (repo gốc, KHÔNG phải worktree)
  commitSha,
  patchId,                // nullable — commit merge/rỗng không có
  committedAt,            // author date, ISO
  subject,                // copy để list không phải gọi git
  turnId,                 // nullable, FK session_turns (set null)
  chatSessionId,          // nullable — denormalize để filter nhanh
  claudeSessionId,        // nullable
  confidence,             // exact | inferred | orphan
  score,                  // real 0..1, chỉ có nghĩa với inferred
  reason,                 // câu ngắn hiện ở tooltip: vì sao gán / vì sao orphan
  supersededSha,          // nullable — sha cũ trước amend/rebase
  detectedAt
)
unique (repoPath, commitSha) · index (projectId, committedAt) · index (patchId) · index (turnId)

repo_cursors (
  repoPath PRIMARY KEY,
  lastSeenSha,            // đã ingest tới đâu
  lastScanAt,
  status,                 // ok | degraded | stopped
  detail
)
```

`repo_cursors` là cái cho phép **bắt commit tạo lúc server tắt**: boot đọc cursor, `git log <lastSeenSha>..--all` → ingest phần thiếu.

## Chạm vào tính năng sẵn có (và sửa gì cho khớp)

| Tính năng | Liên kết / sửa gì |
|---|---|
| **git-watch** (`services/git-watch.ts`) | **Sửa thật** (§ M0): tách watcher khỏi refcount của UI. Thêm `watchGitDir(repoPath, cb)` — `fs.watch` non-recursive trên `<repo>/.git`, listener nội bộ sống suốt đời process. `watchTree()` và contract WS `/ws/git/:projectId` **không đổi một dòng** |
| **git service** (`services/git.ts`) | Thêm `patchId(cwd, sha)`, `logRange(cwd, fromSha)`, `shaReachable(cwd, sha)` (**reachable**, không phải `cat-file -e` — xem § QĐ 4). Không sửa hàm nào đang có |
| **app commit** (`routes/git.ts:304`, `git.ts:495`) | Sau khi commit thành công, nếu request đến từ một session (hoặc MCP tool) → ghi checkpoint `exact` **ngay**, không chờ watcher. Đây là đường chính xác nhất |
| **git log API** (`routes/git.ts:184`) | Response mỗi entry thêm `checkpoint: { confidence, sessionTitle, turnId, promptPreview } | null`. UI cũ bỏ qua field mới nên không vỡ |
| **Diff tab** (`web/src/features/git/DiffTab.tsx`, `BranchMenu.tsx`) | Commit list hiện badge; bấm badge → panel checkpoint |
| **History tab** | Checkpoint `exact` ghi 1 dòng `work_history` kind=`checkpoint`. Bấm vào → panel checkpoint |
| **Terminal / chat session** | "Chat với checkpoint" tạo session mới qua `createChatSession()` + block context (§ M5) — **không** machinery mới, đúng cách workflow step đang truyền context |
| **Worktree** (`services/sessions.ts`, `git.ts:24`) | Commit trong `data/worktrees/<id>` thuộc **repo gốc**. `repoPath` luôn là repo gốc; branch `claude-station/<id>` là dấu hiệu attribution `exact` rất mạnh |
| **Search** (`services/search.ts`) | A1 đã index `promptText`; hit trả về kèm checkpoint nếu turn đó có → "tìm commit theo prompt" |
| **Backup** (`services/backup.ts:138`) | **Phải sửa** `rewritePaths()`: thêm `rewrite("checkpoints","repo_path")` và `rewrite("repo_cursors","repo_path")` |
| **Doctor** (`routes/settings.ts:32`) | Thêm: repo nào `degraded/stopped`, số commit orphan 7 ngày gần nhất (chỉ số sức khoẻ attribution) |
| **Boot** (`server/src/index.ts`) | `reconcileCheckpointsOnBoot()` cạnh các reconcile đang có: catch-up commit lúc server tắt + dựng persistent watcher cho mọi `project_paths` là git repo |
| **Projects** (`routes/projects.ts`) | Thêm/xoá project path → dựng/tháo watcher tương ứng |
| **Workflow run** (C4, sau) | A1 đã điền `session_turns.workflowRunId` → "run này tạo commit nào" chỉ là một câu query, không cần code thêm. Đó là lý do điền cột đó từ A1 |

## Các bước

### M0 — Watcher sống độc lập UI ✅ **XONG**

`git-watch.ts` giữ nguyên `watchTree` của UI, thêm hẳn watcher thứ hai: `watchGitDir(repoPath, cb)` — `fs.watch` **non-recursive trên `<repo>/.git`**, listener không bao giờ detach, lọc theo `GIT_DIR_WATCHED` đã có. `watchProjectRepos()` gọi ở boot và khi thêm project path; `unwatchAllGitDirs()` lúc shutdown. Trả `false` khi không dựng được watcher → hạ `repo_cursors.status='degraded'` chứ không im lặng mù.

### M1 — Ingest commit ✅ **XONG**

`services/checkpoints.ts` + 3 helper mới trong `git.ts`: `patchId()`, `shaReachable()`, `commitsSince()`, `mainRepoOf()`, `headSha()`.

- `ingest()` đọc `repo_cursors.lastSeenSha` → `commitsSince()` (dùng `--all`, oldest first) → insert + attribute. Unique index `(repo_path, commit_sha)` làm double-ingest thành no-op.
- Repo mới: chỉ lấy `INITIAL_DEPTH = 200` commit gần nhất.
- **Bug thật, tìm ra khi test:** trên macOS `/var/…` là symlink của `/private/var/…`, và git luôn báo path đã resolve. Cùng một repo thành **hai danh tính** → row trùng, tra không thấy. Thêm `realish()` vào `lib/path-compare.ts` và `canonicalRepo()` — mọi đường vào đều đi qua nó. Kéo theo: `turnsRunningAt` phải so cả dạng đã resolve, không thì attribution không tìm ra ứng viên nào.

### M2 — Attribution ✅ **XONG**

Đúng công thức trong plan: `overlap × penalty + bonus`, ngưỡng `0.5 / 0.2 / 0.9`, hằng số một chỗ, **không** đưa lên Settings. `exact` còn đòi thêm `treeBacked` và không có ứng viên thứ hai.

Câu `reason` viết bằng lời người đọc được và hiện thẳng lên tooltip — ví dụ thật từ máy này: *"100% of the commit's files match (from tool calls only, which miss shell edits)"*.

### M3 — Reconcile amend/rebase ✅ **XONG**

`findRewritten()` = cùng patch-id **và** sha cũ **không còn reachable**. `reconcileGoneCommits()` hạ `orphan` cho commit đã biến mất, giữ row làm bằng chứng.

4 ca đã verify bằng test trên repo git thật: amend → re-point; rebase → re-point; **cherry-pick → checkpoint riêng** (patch-id giống nhưng bản gốc vẫn reachable); squash → orphan.

Một cái bẫy khi viết test: cherry-pick lên **đúng parent cũ** sinh ra commit *byte-identical* nên git trả lại chính sha gốc — target phải diverge trước, không thì test không kiểm được gì.

### M4 — UI: badge + strip ✅ **XONG**

- `git/log` trả thêm `checkpoint` cho mỗi commit (UI cũ bỏ qua field mới nên không vỡ).
- `web/src/features/git/CheckpointStrip.tsx`: `CheckpointBadge` trong danh sách commit — `exact` badge đặc, `inferred` **viền rỗng + tiền tố `~`** (khác hẳn về hình, không chỉ nhạt hơn), `orphan` không hiện gì.
- `CheckpointStrip` dưới header commit đang chọn: confidence + điểm, prompt gốc, mở rộng ra thấy token/cost/tool, và **cảnh báo những file trong commit mà turn đó không viết** — đó gần như chắc là mày sửa tay.
- Commit list đã mang `checkpoint` sẵn nên chọn một commit không tốn request nào thêm.
- **Không làm:** filter "chỉ xem orphan" trong commit list. Badge vắng mặt đã nói điều đó, và `orphanCount` có ở API; thêm filter là UI cho một câu hỏi hiếm.

### M5 — Ask this checkpoint ✅ **XONG — đổi so với plan**

Plan chốt "dùng Agent SDK chat". **Sai với app này:** session `kind: "chat"` không còn bề mặt UI nào — `ProjectDetailPage` chỉ dựng tab cho `kind === "agent"`. Và mọi hand-off khác (Jira, PR) đều mở **Claude terminal** với context pre-type, không auto-send.

Nên `POST .../checkpoints/:cpId/work-with-claude` tạo terminal `kind: "claude"` trả `{terminalId, seed}`, client navigate `?tab=chat&terminal=…&seed=…` — **đúng convention `WorkWithClaude` đang có**, không dựng convention thứ hai. Terminal mở trong repo của commit, không phải path default của project.

Seed **không nhồi diff**: chỉ prompt gốc + file list + `git show <sha>` để nó tự đọc — cùng nguyên tắc "folder resolve thành pointer, không paste".

### M6 — Multi-path, worktree, health ✅ **XONG**

`ownerOf()` prefix dài nhất (resolve cả hai đầu). Worktree: `attribute()` lấy `listWorktrees()` làm tập cây ứng viên, và turn chạy trong worktree được `+0.15`. Doctor thêm `checkpointRepos` + `checkpointRepoIssues`; `POST .../checkpoints/scan` để ingest tay sau khi rebase ngoài app.

## Bug nặng nhất, và cách sửa (2026-09-03)

Bản đầu của M0 đọc lịch sử **ngay trong `watchProjectRepos()`, trước `app.listen()`**, đồng bộ:

| Việc | Chi phí đo được |
|---|---|
| `ingest` lần đầu | 200 commit × 11 repo × ~23ms (patch-id 9 + commitFiles 7 + `worktree list` 7) ≈ **51s** |
| `reconcileGoneCommits` | 2.203 checkpoint × 21ms (`git branch --contains`, **mỗi row**) ≈ **46s** — và lặp lại **mỗi lần restart** |
| | **≈ 97s chặn boot** |

Triệu chứng nhìn từ browser: app render đủ nhưng **mọi API rỗng** — trông y như *mất sạch data*. `tsx watch` restart theo mỗi lần save file nên gần như luôn ở trạng thái đó. Data chưa bao giờ bị chạm.

Bốn chỗ sửa:

1. **`reachableSet()`** — một `git rev-list --all` cho cả repo rồi kiểm tra tập hợp, thay vì một process mỗi row. Trả `null` (= "không biết") thì để nguyên mọi row, không dám kết luận "mất hết".
2. **`attribute()` hỏi DB trước khi hỏi git.** Không có turn nào trong cửa sổ → orphan ngay, không `commitFiles`, không `worktree list`. Phần lớn commit trong lịch sử một repo có trước cả ledger.
3. **patch-id chỉ tính khi có thứ để mất.** Nó tồn tại để giữ *attribution* qua rebase; orphan thì không có gì để giữ. Commit nào attribute được thì tính bù ngay sau đó.
4. **Tách `watchProjectRepos()` (dựng watcher, rẻ) khỏi `catchUpRepos()` (đọc lịch sử, đắt)**, và `catchUpRepos()` chạy **sau `app.listen()`**, `await setImmediate` giữa từng repo.

Kết quả đo lại trên cùng dữ liệu:

| | trước | sau |
|---|---|---|
| Trước `listen` | ~97s | **84ms** |
| Sau `listen` (không chặn) | — | 703ms (cursor đã cập nhật) · **5,2s** cho lần cold 1.408 commit |

Có 3 test chặn hồi quy ở § test: `watchProjectRepos()` **không được** tạo checkpoint nào; `catchUpRepos()` mới là chỗ ingest; commit không có session thì không có patch-id.

## Kết quả chạy thật (2026-09-03)

Server dev đang chạy tự reload code, nên A2 chạy thẳng trên dữ liệu thật:

| | |
|---|---|
| Repo được watch | **11** — không repo nào `degraded` |
| Checkpoint ingest | **2.203** trên 8 repo |
| `inferred` | 35 |
| `orphan` | 2.168 — trong đó 1.146 "không session nào làm việc trong 24h trước commit", 550 merge commit, 51 "có session hoạt động nhưng không chạm file này" |
| `exact` | **0** |

`exact` = 0 là **đúng, không phải bug**: nó đòi `source='tree'`, mà toàn DB chỉ có 8 tree row — history backfill không thể snapshot cây git của quá khứ (xem [`session-ledger.md`](session-ledger.md) § Phát hiện khi impl). Commit từ giờ trở đi, do turn chạy live, mới lên được `exact`.

Chất lượng attribution kiểm bằng mắt trên commit thật: `Fix bug [IIP555-2238][AI Create]` ↔ prompt *"bỏ creditCost ở client trước, còn cơ chế hiển thị giá thì mặ…"*, 100% file khớp; hai commit `chore(config)` + `fix(generation)` cùng về một prompt *"fix cả 3 đi"*.

## Edge case## Edge case

| Case | Xử lý |
|---|---|
| Commit tạo lúc server tắt | Boot catch-up qua `repo_cursors`. Có turn trong cửa sổ thì vẫn gán được |
| Commit merge | Không có patch-id ổn định → `patchId=NULL`, `orphan`. Không cố gán |
| `git reset --hard` rồi commit lại | Checkpoint cũ trỏ sha không tồn tại → M3 hạ `orphan`, giữ row |
| Cherry-pick | patch-id giống commit gốc → **checkpoint riêng** cùng attribution, không re-point. Phân biệt được vì sha gốc **vẫn reachable** (verify ở L0) |
| Mày commit tay, không qua Claude | `orphan`, không badge. Đúng — không phải commit nào cũng của agent |
| 2 session cùng sửa 1 repo (repo lock tắt) | Cạnh tranh điểm → nếu chênh < 0.2 thì `orphan` + reason nói rõ. **Không chia đôi** |
| Session commit trong worktree rồi merge vào main | Commit trong worktree được gán; commit merge thì orphan (§ trên). Nhìn qua branch `claude-station/*` vẫn lần được |
| File rename trong commit | `commitFiles()` trả path mới; `session_files` có thể ghi path cũ → overlap giảm. Chấp nhận (thành `inferred` thay vì `exact`) |
| Repo shallow / vừa `git init` chưa có commit | `log()` đã `try/catch` trả `[]`; ingest no-op |
| Submodule | Không đi vào submodule. Ghi `detail` ở cursor nếu phát hiện |
| Ledger tắt (`ledger.enabled=false`) | Vẫn ingest commit (rẻ) nhưng mọi thứ `orphan`. UI nói "bật ledger để có attribution" thay vì im lặng |
| Repo rất lớn, watcher đắt | § M0 fallback: watch riêng `.git`, hoặc poll 60s + `degraded` |

## Test

- Unit thuật toán attribution: bảng case (overlap 100% một turn; hai turn cạnh tranh; chỉ `source='tool'`; ngoài cửa sổ; worktree bonus).
- Integration trên repo tạm (`git init` trong tmp): commit thường → `exact`; amend → re-point; rebase → re-point; cherry-pick → 2 checkpoint; squash → orphan; commit lúc "server tắt" (ingest sau) → vẫn gán.
- `patchId()` ổn định qua amend message-only.
- `npm run check` xanh. Prettier chỉ file mình chạm.

## Cần confirm

**Đã chốt 2026-09-03** (4 câu user trả lời + 2 câu tao tự quyết theo uỷ quyền "cứ làm theo ý mày"):

- `ledger.windowHours` = **24h**.
- Badge `inferred`: **hiện**, khác `exact` rõ về thị giác + tooltip nói điểm và lý do (§ QĐ 2).
- M0 watcher: **watch riêng `<repo>/.git`, non-recursive** (§ M0).
- `checkpoint.initialDepth` = **200**, để dạng setting nên đổi lúc nào cũng được. Sâu hơn chỉ tạo thêm row `orphan` vì không có ledger nào tương ứng.
- "Chat với checkpoint": **Agent SDK chat**, không mở Claude terminal. Đây là việc hỏi-đáp read-only — không cần TUI, và SDK chat cho stream + approval modal sẵn có.

**Đổi trong lúc impl, đã ghi ở § M5:** "Ask this checkpoint" mở **Claude terminal**, không phải Agent SDK chat — vì `kind: "chat"` không có bề mặt UI trong app này.

**Còn mở:** không còn.
