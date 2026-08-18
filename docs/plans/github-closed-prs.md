# GitHub tab: lọc PR theo state (Open / Closed / All)

## Context

Tab **Pull requests** ở `/github` chỉ bao giờ hiện PR đang mở. `listPulls` trong
`server/src/services/gh.ts:63` hardcode `"--state", "open"`, và route
`/api/github/:owner/:repo/pulls` (`server/src/routes/integrations.ts:189`) không nhận
tham số nào cả — nên mọi PR đã merge hoặc đã close đều không tồn tại trong app.

Hậu quả cụ thể: repo này vừa merge #13 và #12, cả hai đã biến mất khỏi tab. Muốn xem
lại một PR đã merge (đọc lại review, mở diff, "Work with Claude" trên PR cũ) phải rời
app sang github.com, dù `PrDetail` **đã** render đầy đủ state `MERGED`/`CLOSED`
(`web/src/features/integrations/PrDetail.tsx:71-73`, và nút Reopen ở dòng 516) — chỉ
là không có đường nào đi tới nó từ list.

Kết quả mong muốn: một hàng chip **Open / Closed / All** trên đầu list, đúng như tab
Open/Closed của github.com — "Closed" gộp cả merged và closed-không-merge, mỗi row có
badge riêng để phân biệt. Lựa chọn nằm trong URL nên chia sẻ link được và quay lại
trang vẫn giữ nguyên. Issues **không** trong phạm vi lần này.

## Phạm vi

4 file: `server/src/services/gh.ts`, `server/src/routes/integrations.ts`,
`web/src/pages/GitHubPage.tsx`, `README.md`. Không đụng `PrDetail`, không đụng
`listIssues`, không đổi API của các mutation PR đang có.

## Các bước

### 1. `server/src/services/gh.ts` — `listPulls` nhận state

- Thêm type export `PullState = "open" | "closed" | "all"`.
- `listPulls(repo, limit = 30, state: PullState = "open")` → truyền `state` vào
  `--state` thay cho literal `"open"`. Default `"open"` giữ mọi caller hiện tại
  không đổi hành vi.
- Thêm `mergedAt,closedAt` vào chuỗi `--json`. `gh pr list` là GraphQL-backed nên
  đây vẫn là **một** lần gọi, không fan-out thêm process (đã xác nhận cả hai field
  tồn tại bằng `gh pr list --json` liệt kê field name).
- `PullRequest` interface: thêm `mergedAt: string` và `closedAt: string`
  (`?? ""` trong `.map` giống các field optional khác). Field `state` đã có sẵn
  trong interface và đã nằm trong `--json` — không cần thêm.

### 2. `server/src/routes/integrations.ts` — query param

Route `/api/github/:owner/:repo/pulls` (dòng 189) parse thêm query:

```ts
const { state } = z
  .object({ state: z.enum(["open", "closed", "all"]).default("open") })
  .parse(req.query);
return listPulls(`${owner}/${repo}`, 30, state);
```

zod enum tự trả 400 cho giá trị lạ, nên không có đường nào nhét chuỗi tuỳ ý vào
argv của `gh`.

### 3. `web/src/pages/GitHubPage.tsx`

- **State trong URL**: thêm
  `const [rawPrState, setPrState] = useStickyUrlState("prstate", globalKey("github", "prstate"), "open")`
  rồi guard đúng pattern của `tab` (dòng 125): giá trị không thuộc danh sách →
  fallback `"open"`. Dùng `useStickyUrlState` (replace mặc định) chứ không phải
  `useStickyUrlStateOptional` — đổi filter không nên tạo history entry.
- **Query key**: `["gh-pulls", repo, prState]`, url thành
  `` `/api/github/${owner}/${name}/pulls?state=${prState}` ``. Các
  `invalidateQueries({ queryKey: ["gh-pulls", repo] })` đang có (dòng 397) là
  prefix-match nên vẫn invalidate đúng, không cần sửa.
- **Hàng chip**: tái dùng `FilterChip` từ `@/components/ui/chip` (pattern đã dùng ở
  `web/src/features/workflows/WorkflowsTab.tsx:259`). Đặt vào **đúng cái div đã có**
  ở dòng 242 — đổi `justify-end` thành `justify-between`, chip bên trái, nút
  "New pull request" bên phải, không tốn thêm chiều cao. Div đó vốn đã chỉ render
  khi `tab === "pulls" && selectedPr === null`, tức là chip tự động ẩn khi đang mở
  một PR.
- **`Pull` interface** (dòng 27): thêm `state: string`, `mergedAt: string`,
  `closedAt: string`.
- **Badge state trên row**: PR không phải open được thêm badge, map **trùng với
  `PrDetail.stateBadge`** để hai chỗ không lệch nhau — `MERGED` → `tone="accent"`
  nhãn `merged`, `CLOSED` → `tone="err"` nhãn `closed`.
- **`reviewBadge` chỉ cho PR open**: một PR đã merge vẫn còn `reviewDecision`, hiển
  thị "review required" trên PR merged rồi là nhiễu → gọi `reviewBadge(pr)` chỉ khi
  `pr.state === "OPEN"`.
- **Ngày tháng**: row non-open thêm `merged {fmtDate(pr.mergedAt)}` /
  `closed {fmtDate(pr.closedAt)}` vào dòng meta thứ hai (cạnh
  `headRefName → baseRefName`), dùng `fmtDate` đã có ở dòng 111. Row open giữ y
  nguyên như hiện tại — không thêm gì.
- **Empty state**: giờ một filter có thể trả về rỗng một cách hợp lệ (repo chưa
  close PR nào), và list rỗng hiện tại render ra khoảng trắng trông như lỗi. Khi
  query đã xong mà `pulls.data?.length === 0` → `EmptyState` (đã import sẵn) với
  câu theo filter đang chọn.

### 4. Docs

- `README.md` mục **GitHub** (dòng 162-173): câu mở đầu hiện viết "PRs, issues,
  branches, releases…" — bổ sung rằng list PR lọc được open / closed / all, và PR
  đã merge/close mở ra vẫn xem được review + diff. Sửa tại chỗ, không thêm section.
- Ghi plan này vào `docs/plans/github-closed-prs.md` (repo **có** track
  `docs/plans/` — 34 file plan đang trong git index, nên đây là convention của repo,
  không phải file tạm).
- Ảnh `docs/images/github.png` sẽ hơi cũ (chưa có hàng chip). Không tự chụp lại;
  sẽ nêu ra để bạn quyết.

## Edge case đã tính

- **`--state all` + limit 30**: `gh` sort theo created desc, nên "All" trên repo
  nhiều PR sẽ chỉ là 30 PR mới nhất. Limit 30 là con số đang có sẵn cho open, giữ
  nguyên để không lặng lẽ đổi cost của một request; nếu bạn muốn "All" sâu hơn thì
  đó là một thay đổi riêng.
- **Deep link `?pr=N` tới PR đã close**: hoạt động sẵn — `PrDetail` fetch theo số PR,
  độc lập hoàn toàn với filter của list.
- **`?prstate=garbage`**: guard fallback `"open"` (không throw, không màn hình trắng).
- **Đổi repo**: `prstate` cố ý **không** reset — filter là preference của người dùng,
  còn `pr` thì vẫn reset như hiện tại vì số PR không có nghĩa ở repo khác.
- **`WorkWithClaude` trên PR đã close**: để nguyên, vẫn hợp lý (đọc lại context PR cũ).
- **Nút "New pull request"**: không phụ thuộc filter, luôn hiện như cũ.

## Verification

1. `npm run typecheck` và `npm run lint` (root) — bắt được `Pull` interface lệch với
   payload server.
2. `npm test -w server` — không có test nào cho `gh.ts` (nó shell ra `gh` thật), nên
   đây chỉ là kiểm tra không làm vỡ suite hiện có.
3. API trực tiếp, đối chiếu với `gh` để chắc chắn con số khớp thực tế:
   - `curl 'localhost:<port>/api/github/Temp-art05/claude_station/pulls'` → chỉ PR
     open (mặc định không đổi).
   - `?state=closed` → phải chứa #14/#13/#12 với `state` là `MERGED`/`CLOSED` và
     `mergedAt`/`closedAt` khác rỗng; so số lượng với
     `gh pr list --repo Temp-art05/claude_station --state closed --json number`.
   - `?state=all` → là hợp của hai cái trên.
   - `?state=bogus` → 400, và **không** có process `gh` nào được spawn.
4. UI: mở `/github`, bấm từng chip — kiểm tra `?prstate=` xuất hiện trong URL,
   reload giữ nguyên filter, Back **không** đi qua từng lần bấm chip; PR merged hiện
   badge `merged` màu accent + ngày merge và **không** có badge review; click vào một
   PR đã merge mở đúng `PrDetail`; chọn một filter rỗng thấy EmptyState chứ không
   phải khoảng trắng.

## Kết quả verify (đã chạy)

- `npm run typecheck` (shared/server/web), `eslint .`, `npm run build` — pass.
- API thật (server đang chạy ở `:3789`), đối chiếu với `gh` trên
  `Temp-art05/claude_station`: mặc định (không param) = 0 PR, `?state=closed` = 14,
  `?state=all` = 14 — khớp đúng `gh pr list --state open|closed|all` (0 / 14 / 14).
  `?state=bogus` → **400** với issue của zod, không spawn `gh`.
- `mergedAt`/`closedAt` về đúng: PR #14 `MERGED merged=2026-08-18T09:34:52Z`.
- Nhánh `CLOSED` (close mà không merge) **không** repo nào trong Settings có, nên đã
  test qua route với repo public `cli/cli`: `?state=closed` trả 14 `CLOSED` + 16
  `MERGED`, và mẫu #14187 là `mergedAt=''` (từ `null`) + `closedAt` có thật.
- Cùng mẫu đó có `reviewDecision='REVIEW_REQUIRED'` **trên một PR đã close** — đúng
  như dự đoán trong plan, nên việc chặn `reviewBadge` cho PR non-open là cần thiết
  chứ không phải dọn dẹp cho đẹp.
- **Chưa verify bằng mắt**: máy không có Playwright/Puppeteer nên hàng chip, badge,
  `?prstate=` trong URL và EmptyState chưa được xem trên browser thật — cần bạn mở
  `/github` xác nhận.
- `docs/images/github.png` chưa có hàng chip; chưa chụp lại.
