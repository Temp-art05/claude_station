# Orphaned worktrees lock branches forever

## Vấn đề quan sát được

Trong `FE-ReelMe-film-studio`, branch `claude-station/msh5jskb-384` không
checkout được và cũng không delete được:

```
checkout failed: fatal: 'claude-station/msh5jskb-384' is already used by worktree
at '/Users/dinhngocthe/SkillsAgent/claude_station/data/worktrees/msh5jskb-384cfff3-619'
```

`git worktree list` xác nhận worktree đó còn sống và đang giữ branch. Worktree
sạch: không file thay đổi, không commit nào ngoài `develop`, tạo 2026-08-06.

## Nguyên nhân gốc

`createWorktree` (`server/src/services/git.ts:24`) tạo
`data/worktrees/<sessionId>` + branch `claude-station/<sessionId[0:12]>`.

Worktree chỉ bị xoá qua 3 đường, **cả 3 đều cần session row**:

- `server/src/routes/chat.ts:58` — session archived
- `server/src/routes/chat.ts:81` — session deleted
- `server/src/services/projects.ts:53` — project deleted

Session `msh5jskb-384cfff3-619` không còn trong `chat_sessions`. Thủ phạm là
`server/src/services/backup.ts:145`:

```js
// Worktrees don't travel — sessions must not point at ghosts.
db.prepare("UPDATE chat_sessions SET worktree_path = NULL").run();
```

Đúng khi chuyển máy, nhưng trên **cùng một máy** thì worktree trên đĩa và bản
đăng ký của nó trong git vẫn còn, chỉ mất chủ. Từ đó không code nào xoá được nữa:

- `server/src/index.ts` có `reconcileRunsOnBoot()` cho workflow step nhưng
  **không có gì tương đương cho worktree**.
- Không có UI nào liệt kê hay xoá worktree (`grep worktree web/src` chỉ ra chỗ
  *tạo*, không có chỗ *dọn*).

Hệ quả: branch bị git giữ vĩnh viễn. `-d` và `-D` đều vô dụng — đây không phải
lỗi "not fully merged", nên fix force-delete ở `BranchMenu` không cứu được ca này.

## Mục tiêu

Worktree do app tạo không bao giờ sống lâu hơn cái session sở hữu nó; và khi một
worktree vẫn giữ branch, người dùng phải dọn được từ trong UI thay vì phải mở
terminal.

## Phạm vi

Server: một hàm reconcile lúc boot + một git op mới. Web: một dialog escape hatch
trong `BranchMenu`. Không đụng logic tạo worktree.

## Các bước

### B1 — `reconcileWorktreesOnBoot()`
`server/src/services/git.ts` (hàm), `server/src/index.ts` (gọi cạnh `reconcileRunsOnBoot`)

Với mỗi `project_paths.path` là git repo:

1. `git worktree list --porcelain` → danh sách worktree.
2. Chỉ xét worktree có path nằm **bên trong `WORKTREES_DIR`**. Worktree người dùng
   tự tạo ở nơi khác thì tuyệt đối không chạm.
3. `basename(path)` là sessionId. Nếu id đó còn trong `chat_sessions` → bỏ qua.
4. Nếu không còn chủ:
   - Có file thay đổi (`git -C <wt> status --porcelain` khác rỗng) **hoặc** có
     commit không nằm ở đâu khác → **không xoá**, chỉ `app.log.warn` kèm path.
     Không bao giờ âm thầm phá công việc dở.
   - Sạch → `git worktree remove --force <path>` rồi `git worktree prune`.
5. Log tổng số đã dọn / số bị giữ lại vì còn việc dở.

**Không tự xoá branch `claude-station/*`.** Giải phóng worktree là đủ để người
dùng xoá branch từ UI (đã có dialog force-delete). Tự xoá branch là phá huỷ,
không đưa vào bước tự động.

### B2 — Import không để lại worktree mồ côi
`server/src/services/backup.ts:145`

Trước khi `SET worktree_path = NULL`, đọc các `worktree_path` không rỗng và gọi
`removeWorktree` cho từng cái (cùng điều kiện an toàn như B1: sạch mới xoá).
Đây là chỗ sinh ra rác, nên bịt tại nguồn thay vì chỉ dựa vào B1 dọn sau.

### B3 — Escape hatch trong UI
`server/src/routes/git.ts` (op mới), `server/src/services/git.ts`, `web/src/features/git/BranchMenu.tsx`

- Op mới `remove-worktree` nhận `path`, **chỉ chấp nhận path nằm trong
  `WORKTREES_DIR`** (dùng `path-safety`), trả 400 nếu không.
- `BranchMenu.onError`: khi message khớp
  `/already used by worktree at '(.+)'/` và path bắt được nằm trong
  `data/worktrees/` → mở dialog nêu rõ worktree nào đang giữ branch, nút
  "Remove worktree" gọi op mới rồi thử lại op ban đầu.
- Nếu path **không** nằm trong `data/worktrees/` (worktree của chính người dùng)
  → chỉ hiện lỗi như cũ, không đề nghị xoá.

### B4 — Docs
- README: nói rõ worktree của session sống trong `data/worktrees/` và được dọn ở
  boot khi session đã mất.

## Edge cases

- **Worktree còn việc dở:** giữ lại + log. Người dùng tự xử lý; app không phá.
- **Repo đã bị xoá/di chuyển:** `git worktree list` sẽ lỗi → bọc try/catch từng
  repo, một repo lỗi không được làm sập boot.
- **Session còn sống nhưng worktree bị xoá tay:** ngoài phạm vi B1 (chiều ngược
  lại). `removeWorktree` đã tự chịu được trường hợp này.
- **Nhiều project trỏ chung một repo:** cùng một worktree có thể gặp 2 lần → dedupe
  theo path trước khi xử lý.
- **Path traversal ở op mới:** bắt buộc `resolve()` rồi kiểm tra prefix
  `WORKTREES_DIR`, không so sánh chuỗi thô.
- **Boot chậm:** mỗi repo thêm 1–2 lệnh git. Số repo nhỏ (hiện 3/project), chấp nhận.

## Cần confirm

1. Xoá ngay worktree mồ côi đang chặn (`msh5jskb-384cfff3-619`, đã kiểm tra sạch)
   để mày dùng lại branch, trước khi impl? Đây là hành động một lần bằng tay.
2. B1 có nên chạy mỗi lần boot, hay chỉ chạy khi người dùng bấm một nút trong
   Settings? Đề xuất: mỗi boot, vì rác này im lặng và người dùng không biết mà bấm.
