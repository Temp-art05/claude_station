# PR actions: đổi base branch, gate Approve theo quyền, Close/Reopen, Assign, Draft toggle

> Sau khi được duyệt, copy plan này vào `docs/plans/github-pr-actions.md` (bước 0 của impl) để làm source of truth trong repo.

## Context

Trang PR detail (`web/src/features/integrations/PrDetail.tsx`) hiện chỉ có: comment, approve/request-changes, merge. Người dùng muốn bổ sung 5 khả năng như GitHub web:

1. **Đổi base branch** của PR (đã chốt: base branch, không phải head).
2. **Nút Approve chỉ enable khi có quyền** — hiện tại ai mở app cũng bấm được, lỗi chỉ hiện khi gh trả 502.
3. **Close PR** (+ Reopen khi PR closed chưa merge — đã chốt).
4. **Assign** — gán/bỏ assignees từ danh sách collaborators (đã chốt: assignees, không phải reviewers).
5. **Convert to draft** ⇄ **Ready for review** (đã chốt: cả hai chiều).

Kiến trúc hiện có: web (React 19 + React Query v5) → Fastify routes (`server/src/routes/integrations.ts`) → `gh` CLI adapter (`server/src/services/gh.ts`, luôn dùng argv array + `assertRepo`). Mọi action mới đi đúng pattern `mergePull` hiện có.

## Phạm vi

- Chỉ trang PR detail + tầng server phục vụ nó. Không đụng Issues, không thêm request-reviewers, không đổi luồng merge hiện tại.
- Không thêm audit log cho GitHub mutations (giữ parity với các mutation GitHub hiện có — chúng không audit).

## Các bước

### 1. Server — service `server/src/services/gh.ts`

Tách helper `assertBranch(branch)` từ guard đang nằm trong `deleteBranch()` (dòng 358–362: check rỗng, leading `-`, `BRANCH_RE`) rồi dùng chung. Thêm:

- `repoViewer(repo)` → `Promise.all` của `gh api user` (lấy `login`) + `gh api repos/{repo}` (lấy `permissions` của user hiện tại). Trả `{ login, canPush: !!permissions?.push, canAdmin: !!permissions?.admin }`.
- `editPullBase(repo, number, base)` → `assertBranch(base)` rồi `gh pr edit N --repo R --base <base>`.
- `closePull(repo, number)` → `gh pr close N --repo R`.
- `reopenPull(repo, number)` → `gh pr reopen N --repo R`.
- `setPullDraft(repo, number, draft)` → `gh pr ready N --repo R` (+ `--undo` khi `draft === true`).
- `listAssignableUsers(repo)` → `gh api repos/{repo}/assignees?per_page=100` → `string[]` logins.
- `editPullAssignees(repo, number, add, remove)` → validate mỗi login bằng `LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d-]{0,38})$/`, rồi `gh pr edit N --repo R [--add-assignee a,b] [--remove-assignee c]`.
- `pullDetailFull()`: thêm `assignees` vào chuỗi `--json` (dòng 222–224) và map `assignees: (raw.assignees ?? []).map(a => a.login ?? "").filter(Boolean)` vào interface `PrDetail` (dòng 156–178).

### 2. Server — routes `server/src/routes/integrations.ts` (khối GitHub, cạnh route merge dòng 226)

Tất cả parse params bằng `prParams` sẵn có (dòng 191), body bằng zod, trả `{ ok: true }`:

- `GET  /api/github/:owner/:repo/viewer` → `repoViewer`.
- `GET  /api/github/:owner/:repo/assignable-users` → `listAssignableUsers`.
- `POST /api/github/:owner/:repo/pulls/:number/base` — body `{ base: z.string().min(1) }`.
- `POST /api/github/:owner/:repo/pulls/:number/close`.
- `POST /api/github/:owner/:repo/pulls/:number/reopen`.
- `POST /api/github/:owner/:repo/pulls/:number/draft` — body `{ draft: z.boolean() }`.
- `POST /api/github/:owner/:repo/pulls/:number/assignees` — body `{ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }`.

Import các fn mới vào block import gh service (dòng 17–33).

### 3. Web — `web/src/features/integrations/PrDetail.tsx`

**Data:**
- Thêm `assignees: string[]` vào `PrDetailData` (dòng 18–40).
- Query mới `["gh-viewer", owner, name]` → `GET /viewer`, `staleTime: 5 phút`.
- Query `["gh-branches", owner, name]` (key trùng cache của BranchesTab/CodeTab) — `enabled` khi mở picker base branch.
- Query `["gh-assignable", owner, name]` → `GET /assignable-users`, `enabled` khi mở popover Assign.
- 4 mutation mới theo pattern `merge` (dòng 138–141): `editBase`, `closeReopen`, `draft`, `assign` — tất cả `onSuccess: refresh` (refresh sẵn có đã invalidate detail + list).

**UI:**
- **Base branch** (header, dòng 185–190): khi PR OPEN, chữ `baseRefName` thành control bấm được → mở picker liệt kê branches (bỏ qua branch hiện tại và head branch), chọn → `window.confirm("Change base of #N from X to Y?")` → mutate. PR merged/closed giữ text tĩnh.
- **Gate Approve** (dòng 273–280): `canReview = viewer.canPush && viewer.login !== pr.author`. Approve + Request changes `disabled` khi `!canReview` (kể cả lúc viewer đang load), thêm `title` giải thích: "You don't have push access" / "You can't approve your own PR". Nút Merge cũng gate theo `viewer.canPush` (cùng lý do — tránh bấm rồi nhận 502).
- **Hàng action mới** trong Card actions (trên hàng merge, cạnh dòng 299): 
  - Nút **Convert to draft** / **Ready for review** (ghost) tùy `pr.isDraft`.
  - Nút **Close pull request** (variant `danger`, kèm `window.confirm`).
  - **Assignees**: hiển thị danh sách assignees hiện tại + nút mở popover (theo pattern click-outside của `web/src/features/git/BranchMenu.tsx:61-68`) liệt kê assignable users, mỗi user toggle add/remove (check ✓ với user đang được assign).
- **PR CLOSED (chưa merge)**: hiện Card nhỏ với nút **Reopen** (hiện tại toàn bộ Card actions ẩn khi `state !== "OPEN"`, dòng 258).
- Assignees hiển thị ở header dạng badge (cạnh labels, dòng 194–196).

### 4. Docs sync (cùng commit)

- Cập nhật `docs/plans/github-tab.md` — mục "PR detail": thêm các action mới + 7 route mới vào bảng route.
- Copy plan này vào `docs/plans/github-pr-actions.md`.

## File dự kiến chạm

| File | Thay đổi |
|---|---|
| `server/src/services/gh.ts` | +7 hàm, sửa `pullDetailFull` (+assignees), tách `assertBranch` |
| `server/src/routes/integrations.ts` | +7 route GitHub |
| `web/src/features/integrations/PrDetail.tsx` | +queries/mutations + UI controls |
| `docs/plans/github-tab.md` | docs sync |
| `docs/plans/github-pr-actions.md` | plan (mới) |

## Edge cases

- **Viewer load fail / đang load** → Approve disabled (an toàn theo yêu cầu "chỉ enable nếu có quyền"); lỗi gh vẫn hiện verbatim như hiện tại nếu lọt qua.
- **Approve chính PR của mình** → disabled (GitHub luôn cấm), dù có push permission.
- **Đổi base sang chính head branch** → GitHub từ chối; picker loại `headRefName` và `baseRefName` hiện tại khỏi danh sách.
- **Branch/login injection** → `assertBranch` (chặn leading `-`, whitespace, ký tự cấm) và `LOGIN_RE`; giữ nguyên nguyên tắc argv-array, không string shell.
- **Reopen PR đã merge** → không hiện nút (chỉ hiện khi `state === "CLOSED"`).
- **Draft PR** → Approve vẫn cho phép như GitHub; merge draft sẽ bị gh từ chối (giữ nguyên hành vi lỗi hiện tại, ngoài phạm vi).
- **`gh api repos/{repo}` không trả `permissions`** (token thiếu scope) → coi như không có quyền, Approve disabled.

## Bổ sung (yêu cầu thêm giữa chừng): Tạo PR mới

- **Server** (`gh.ts`): `createPull(repo, input: { title, body?, base, head, draft? })` →
  `assertBranch(base/head)`, chặn `base === head`, rồi
  `gh pr create --repo R --title T --body B --base X --head Y [--draft]`.
  `gh pr create` in URL PR ra stdout → parse số PR từ URL, trả `{ number, url }`.
- **Route**: `POST /api/github/:owner/:repo/pulls` — body zod
  `{ title: min1, body: optional, base: min1, head: min1, draft: boolean default false }`.
- **Web** (`GitHubPage.tsx`, tab Pull requests): nút **New pull request** cạnh header list →
  `Dialog` (component sẵn có `web/src/components/ui/dialog.tsx`) gồm:
  - 2 select `base` ← `head` từ query `["gh-branches", owner, name]` (default: base = defaultBranch);
  - input Title, textarea Description, checkbox "Create as draft";
  - nút Create → mutation POST; thành công → invalidate `["gh-pulls"]`, đóng dialog,
    mở luôn PR detail vừa tạo (`setSelectedPr(number)`).
- **Edge cases**: base = head → disable nút Create; gh lỗi ("no commits between",
  "already exists") → hiện message 502 verbatim trong dialog; không làm trang
  compare/diff preview như GitHub web (ngoài phạm vi — confirm với user).

## Verification

1. `npm run typecheck && npm run lint` (root scripts sẵn có).
2. `npm run dev` → mở tab GitHub → chọn repo có PR thật:
   - Đổi base branch một PR test → reload thấy base mới, header list PR cập nhật.
   - Approve: kiểm tra disabled khi xem PR của chính mình; enabled với PR người khác (nếu có push access).
   - Convert to draft → badge "Draft" hiện; Ready for review → về "Open".
   - Assign/unassign bản thân → badge assignee hiện/mất ở header.
   - Close PR → state Closed, hiện nút Reopen → Reopen về Open.
3. `npm run test` (server workspace) để chắc không vỡ test hiện có.
