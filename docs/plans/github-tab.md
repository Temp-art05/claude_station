# GitHub tab: Branches / Releases / Code browser + repo nhận URL + link GitHub theo project

Mở rộng từ [github-shortcuts.md]. Yêu cầu người dùng:
- Xem PR (của MỌI người — thực tế `gh pr list` hiện tại đã list tất cả author,
  trang trắng là do bug parse bên dưới, không phải do lọc).
- Xem Releases.
- Xem Code: list branch, XOÁ branch, duyệt file.
- Settings khai repo bằng URL đầy đủ vẫn phải chạy (hiện đang khai
  `https://github.com/...` → `split("/")` hỏng → trang trắng).
- Mỗi project có option mở trang GitHub của repo thuộc project đó.

## Thiết kế

### `shared/src/types.ts`
- `normalizeGithubRepo(input): string | null` — nhận `owner/name`, URL https,
  URL ssh (`git@host:owner/name.git`); trả `owner/name` hoặc null. Dùng chung
  server + web (web đã import shared sẵn).

### `server/src/services/gh.ts`
- `githubConfig()`: normalize từng repo qua helper, bỏ entry không parse được
  → repo khai bằng URL trong Settings tự chạy, không cần migrate DB.
- `listBranches(repo)` → `{ defaultBranch, branches: [{name, protected, sha}] }`
  (`gh api repos/{repo}` + `repos/{repo}/branches?per_page=100`).
- `deleteBranch(repo, branch)`: validate tên branch (chặn `-` đầu, ký tự lạ),
  TỪ CHỐI xoá default branch + branch protected; `gh api -X DELETE
  repos/{repo}/git/refs/heads/{branch}` (encode từng segment, giữ `/`).
- `listReleases(repo)` → tagName/name/publishedAt/isDraft/isPrerelease/isLatest
  (`gh release list --json`), url tự ghép `releases/tag/<tag>`.
- `getContents(repo, path, ref)` → union `{type:"dir", entries[]}` (folder trước,
  sort tên) | `{type:"file", text|null (binary), truncated}` — cap text 200KB,
  chặn `..` trong path (`gh api repos/{repo}/contents/{path}?ref=`).

### `server/src/routes/integrations.ts`
- `GET  /api/github/:owner/:repo/branches`
- `DELETE /api/github/:owner/:repo/branch?name=<branch>` (query vì branch chứa `/`)
- `GET  /api/github/:owner/:repo/releases`
- `GET  /api/github/:owner/:repo/contents?path=&ref=`

### `server/src/routes/projects.ts`
- `GET /api/projects/:id/github` → `[{pathId, label, url|null}]`: chạy
  `git -C <path> remote get-url origin` từng path (timeout 5s, lỗi → null),
  convert ssh→https, strip `.git`.

### `web/src/pages/GitHubPage.tsx`
- Parse repo qua `normalizeGithubRepo` (hiển thị `owner/name` trong select).
- Tabs mới: Pull requests · Issues · **Branches** · **Releases** · **Code**.
  - Branches: tên + badge default/protected + sha; nút xoá (confirm) — ẩn với
    default/protected; xoá xong invalidate query.
  - Releases: tag, tên, badge latest/draft/pre, ngày, link mở GitHub.
  - Code: select branch (mặc định = defaultBranch) + breadcrumb path + list
    dir/file; click file → xem nội dung `<pre>` (binary/quá to → thông báo).
- Giữ thanh shortcut + Work with Claude.

### `web/src/pages/SettingsPage.tsx` (GitHubForm)
- Normalize từng dòng khi save (URL → owner/name), dòng không parse được giữ
  nguyên để user tự sửa; help text nói rõ nhận cả URL.

### `web/src/pages/ProjectDetailPage.tsx`
- Query `/api/projects/:id/github`; cạnh mỗi path Badge có icon mở repo trên
  GitHub (chỉ hiện khi resolve được remote).

## Bổ sung đợt 2 — PR detail "như GitHub thật"

Click PR trong tab Pull requests → view chi tiết (thay list, có nút back):
- **Header**: state badge (Open/Draft/Merged/Closed), title #n, author,
  `head → base`, `+adds −dels · N files`, reviewDecision + status checks.
- **Sub-tabs**: Conversation (body + timeline comment/review theo thời gian) ·
  Commits (sha, message, author, ngày) · Files changed (diff từng file, dòng
  +/− tô màu như GitHub, header meta của git bị lọc).
- **Actions** (khi PR đang OPEN): ô comment (Comment / Approve / Request changes)
  và khối Merge (chọn merge/squash/rebase + option delete branch, có confirm).

### Server (`gh.ts` + `integrations.ts`)
- Tách `ghRaw(args): string` (stdout thô); `gh<T>` = ghRaw + JSON.parse.
- `pullDetailFull(repo, n)`: `gh pr view --json` (body, comments, reviews,
  commits, files, statusCheckRollup, mergeable…) → normalize shape gọn cho client.
- `pullDiff(repo, n)`: `gh pr diff` → split theo `diff --git` thành
  `[{path, patch}]`, cap 2MB (truncated flag).
- `commentPull` (`gh pr comment --body`), `reviewPull`
  (`gh pr review --approve|--request-changes|--comment [--body]`),
  `mergePull` (`gh pr merge --merge|--squash|--rebase [--delete-branch]`).
- Routes: GET `/pulls/:number/detail`, GET `/pulls/:number/diff`,
  POST `/pulls/:number/comment`, POST `/pulls/:number/review`,
  POST `/pulls/:number/merge`.

### Web
- `web/src/features/integrations/PrDetail.tsx` (component mới);
  `GitHubPage` tab pulls: click title → mở detail, back → về list.
- Sau comment/review/merge → invalidate detail + list. Merge có `window.confirm`.

## Bổ sung đợt 3 — PR actions (plan: `github-pr-actions.md`)

- **Đổi base branch**: `baseRefName` ở header thành nút mở picker (list branches,
  bỏ base hiện tại + head), confirm → POST `/pulls/:number/base` →
  `editPullBase` (`gh pr edit --base`).
- **Gate quyền**: GET `/:owner/:repo/viewer` → `repoViewer` (`gh api user` +
  `gh api repos/{repo}` → `{login, canPush, canAdmin}`). Approve/Request changes
  disabled khi không có push access hoặc viewer là author (tooltip giải thích);
  Merge disabled khi không có push access.
- **Close/Reopen**: POST `/pulls/:number/close|reopen` (`gh pr close|reopen`).
  Nút Close (danger, confirm) ở hàng action; PR CLOSED chưa merge → card Reopen.
- **Assignees**: `pullDetailFull` trả thêm `assignees[]` (badge `@user` ở header).
  GET `/:owner/:repo/assignable-users` (`gh api repos/{repo}/assignees`);
  POST `/pulls/:number/assignees` `{add[], remove[]}` → `editPullAssignees`
  (`gh pr edit --add-assignee/--remove-assignee`, validate login). UI: popover
  toggle từng user (pattern click-outside như BranchMenu).
- **Draft toggle**: POST `/pulls/:number/draft` `{draft}` → `setPullDraft`
  (`gh pr ready [--undo]`). Nút "Convert to draft" ⇄ "Ready for review".
- Guard input: `assertBranch` (tách từ `deleteBranch`), `LOGIN_RE` cho assignee;
  luôn argv array. Mutation nào cũng `onSuccess: refresh` (invalidate detail + list).
- **Tạo PR mới**: nút "New pull request" ở tab Pull requests → `NewPrDialog`
  (base/compare select từ `["gh-branches"]`, title, description, checkbox draft) →
  POST `/:owner/:repo/pulls` → `createPull` (`gh pr create --title --body --base
  --head [--draft]`, chặn base = head, parse `{number, url}` từ stdout) → tạo xong
  invalidate list + mở luôn PR detail.

## Edge cases
- Branch tên chứa `/` (vd `khai/develop/x`) → DELETE qua query param, encode segment.
- Xoá default/protected → server chặn 400, UI không hiện nút.
- File binary / >200KB → không render text, hiện ghi chú.
- Path repo local không phải git repo / không có remote origin → url null, ẩn icon.
- Repo entry Settings không parse được → bị bỏ khỏi danh sách (không crash trang).

## Verify
- typecheck 3 workspace + test server pass.
- Gọi thử listBranches/listReleases/getContents với repo thật (read-only) qua node.
- KHÔNG test deleteBranch trên repo thật (destructive) — review logic + chặn default.
- Lưu ý vận hành: sửa file server ⇒ tsx watch restart ⇒ PTY (agent) bị kill — báo user.
