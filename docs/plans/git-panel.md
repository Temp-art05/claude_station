# Git panel kiểu Android Studio (tab Diff → Git)

## Mục tiêu
Nâng tab Diff thành panel Git đầy đủ như JetBrains: xem cây file project, diff side-by-side, commit (chọn file bằng checkbox, amend, commit & push) — người dùng giao toàn quyền quyết định thiết kế.

## Phạm vi & quyết định
- **Side-by-side diff**: parse unified patch (`git diff HEAD`) ngay trên client thành 2 cột (số dòng 2 bên, hàng add/del/context, separator giữa các hunk) — không thêm dependency; hunk view (không render cả file) giống GitHub/JetBrains khi collapse unchanged.
- **Cây file project**: `git ls-files --cached --others --exclude-standard` (tracked + untracked không bị ignore, cap 30k) → client dựng tree, expand lazy; click file → viewer nội dung (số dòng, cap 1MB, phát hiện binary). Chưa làm syntax highlight (để sau).
- **Commit UI**: checkbox từng file (mặc định chọn hết), textarea message, checkbox Amend (message trống → `--amend --no-edit`), nút Commit / Commit & Push. Commit = `git add -A -- <files>` + `git commit`. Push tự thử `git push`, thiếu upstream → `git push -u origin HEAD`.
- **Branch info**: parse `git status -sb` → tên branch + ahead/behind hiển thị cạnh repo selector.
- **Untracked file diff**: `git diff HEAD` không hiện file untracked → fallback `git diff --no-index /dev/null <file>` (bắt exit code 1).
- Giữ nguyên: revert file (confirm), unified "All changes" overview, group theo worktree/session (query param sẵn có).

## File đụng tới
- `server/src/services/git.ts`: thêm `listFiles`, `readFile` (worktree/HEAD), `commit`, `push`, `branchInfo`, fix `diff` cho untracked.
- `server/src/routes/git.ts`: GET `git/tree`, GET `git/file`, POST `git/commit` (+ work_history `git_committed`).
- `web/src/features/git/DiffTab.tsx`: viết lại — layout AS-like (sidebar Changes+Commit+Files tree | pane diff/viewer).
- `web/src/features/git/SideBySideDiff.tsx` (MỚI): parser unified patch + render 2 cột.
- `web/src/features/git/FileTree.tsx` (MỚI): tree lazy expand.
- Docs: changelog rev12 trong `claude-station.md`.

## Verify
- typecheck + eslint + build web; smoke test endpoints bằng curl trên repo thật (tree/file/commit trên repo test trong scratchpad — KHÔNG commit vào repo của người dùng khi test).

## Phase 2 — Branch menu + Log + hunk rollback (kiểu Android Studio, người dùng yêu cầu "làm mạnh như AS")
- **Branch menu** (bấm vào tên branch ở sidebar): search, actions đầu menu (Fetch / Pull / Pull --rebase / Push / New branch), danh sách Local + Remote; click branch → checkout (remote chưa có local → `switch -c <name> --track`); hover branch có nút Merge into current / Rebase current onto / Delete (confirm, `-d` trước `-D` sau khi confirm force).
  - **Sửa ở rev15** (`branch-menu-nested-branches.md`): "remote → `switch -c --track`" áp dụng khi **ref tồn tại ở `refs/remotes`**, KHÔNG phải khi "tên có `/`" — `refs/heads` được tra trước nên branch local `version/4.0.0` được checkout thẳng. Danh sách Local/Remote giờ là tree gom theo folder (`buildBranchTree` trong `shared/`), row hiển thị segment cuối nhưng op vẫn dùng full ref.
- **History**: section trong sidebar — `git log -n 100` (hash, msg, author, date relative, refs %D làm badge). Click commit → pane phải hiện danh sách file của commit (`show --name-status`) + click file xem side-by-side (`git show <hash> -- <file>`).
- **Hunk rollback**: hàng hunk-header trong SideBySideDiff (chỉ với diff working-tree) có nút ⤺ Rollback — client gửi nguyên văn patch của hunk đó (header file + thân hunk), server `git apply -R` qua stdin. Sai lệch (file đã đổi tiếp) → git apply fail → báo lỗi rõ.
- Conflict khi merge/rebase/pull: KHÔNG resolve trong UI v1 — trả lỗi kèm stderr + gợi ý mở Terminal; nút Abort (merge --abort / rebase --abort) khi repo đang ở trạng thái dở.
- Endpoint mới: GET `git/branches`, `git/log`, `git/commit-files`, `git/show`; POST `git/checkout`, `git/fetch`, `git/pull`, `git/push`, `git/merge`, `git/rebase`, `git/delete-branch`, `git/abort`, `git/revert-hunk`.
