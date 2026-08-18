# GitHub tab: ô tìm kiếm + phân trang cho list PR

## Context

Vừa thêm filter Open / Closed / All (`docs/plans/github-closed-prs.md`), và chính nó
làm lộ ra giới hạn kế tiếp: `listPulls` fetch cứng `--limit 30` rồi hết. Trên
`AperoVN/IIP555-ReelMe` con số thật là **30/30 dòng closed đều là MERGED** — tức là
list đã chạm trần và không có cách nào biết còn gì phía sau, cũng không có cách nào
tìm một PR cụ thể. Bật chip "Closed" trên một repo có vài trăm PR thì được đúng 30 PR
mới nhất và một cảm giác sai rằng đó là tất cả.

Kết quả mong muốn: một ô search truyền thẳng vào `gh pr list --search` (gõ được
`author:thedn-art`, `is:draft`, `review:required`, hay cả một SHA), cộng Prev/Next để
đi sâu quá 30 dòng đầu.

## Điều đã kiểm chứng trước khi thiết kế

`gh pr list` **không có offset** — chỉ `--limit`. Nên paging bắt buộc là over-fetch +
slice ở server. Ba thứ đã đo thật để chắc scheme đó đúng:

1. **Thứ tự ổn định.** Không search → created desc. Có search → **relevance order**
   (`--search auth` trên `cli/cli` trả `[14157,13781,13400,14177,…]`, không hề giảm
   dần). Nhưng gọi lại cùng query cho ra đúng dãy đó, và `--limit 16` có 8 phần tử
   đầu **trùng khít** `--limit 8`. Slice theo offset vì vậy hợp lệ; nếu thứ tự không
   ổn định thì cả thiết kế này sai.
2. **Giá của over-fetch.** `--limit 30` = 0.65s, `--limit 150` = 1.2s. Đủ rẻ cho
   ~5 trang đầu.
3. **`--search` không thoát scope repo.** `--repo cli/cli --search "repo:torvalds/linux"`
   trả `[]` (hai qualifier `repo:` AND với nhau). Không có đường đọc repo ngoài Settings
   qua ô search.

Đã bỏ phương án "Page 2 of 12": `gh pr list` không trả tổng số, lấy được qua
`gh api search/issues` nhưng tốn +0.83s và buộc mình **dựng lại** query
(`repo:X is:pr is:closed …`) mà `gh` đang tự dịch — tổng số sẽ lệch với list khi hai
bản dịch drift. Prev/Next với `hasMore` từ dòng thứ 31 thì đúng-bởi-cấu-trúc.

## Phạm vi

3 file code: `server/src/services/gh.ts`, `server/src/routes/integrations.ts`,
`web/src/pages/GitHubPage.tsx`. Cộng `README.md` + `docs/plans/github-search-paging.md`.
Không đụng Issues, không đụng `PrDetail`.

## Các bước

### 1. `server/src/services/gh.ts` — `listPulls` nhận options

`listPulls` hiện là `(repo, limit = 30, state = "open")` và **chỉ có một caller**
(`routes/integrations.ts:195`), nên đổi sang options object là an toàn và tránh tham số
positional thứ tư:

```ts
const PER_PAGE = 30;
/** Cap giữ `--limit` dưới 601: page=999999 sẽ bắt `gh` bò hết API của GitHub. */
const MAX_PAGE = 20;

export interface ListPullsOptions {
  state?: PullState;
  /** Truyền nguyên văn vào `--search`; rỗng thì bỏ hẳn flag. */
  search?: string;
  page?: number;
}

export async function listPulls(
  repo: string,
  { state = "open", search = "", page = 1 }: ListPullsOptions = {},
): Promise<{ items: PullRequest[]; hasMore: boolean }>;
```

- `const want = page * PER_PAGE` → `--limit String(want + 1)`. Dòng thứ `want+1`
  chính là câu trả lời cho "còn trang sau không": `hasMore = raw.length > want`.
- `items = raw.slice((page - 1) * PER_PAGE, want)` rồi mới `.map(...)` như hiện tại.
- `if (search.trim()) args.push("--search", search.trim())` — chỉ thêm khi có, để
  query rỗng giữ nguyên created-desc thay vì rơi vào relevance order.
- `search` đi vào argv array của `execFile` (không qua shell) và `assertRepo` vẫn
  chạy trước, nên không cần thêm regex cho nó.

### 2. `server/src/routes/integrations.ts:189` — query params

```ts
const { state, q, page } = z
  .object({
    state: z.enum(["open", "closed", "all"]).default("open"),
    q: z.string().max(256).default(""),
    page: z.coerce.number().int().min(1).max(20).default(1),
  })
  .parse(req.query);
return listPulls(`${owner}/${repo}`, { state, search: q, page });
```

`max(20)` là cái cap ở trên, đặt ở tầng zod để `?page=999999` thành 400 chứ không
thành một request `gh` chạy vài phút. `max(256)` cho `q` chặn query rác dài vô hạn.

### 3. `web/src/pages/GitHubPage.tsx`

- **Ô search**: debounce 400ms theo đúng pattern đã có ở `web/src/pages/JiraPage.tsx:33-38`
  (`useUiState` cho text + `useState`/`setTimeout` cho giá trị debounced). Markup dùng
  lại pattern field-có-icon của `web/src/pages/SearchPage.tsx:58-66` (`relative` +
  `SearchIcon` absolute + `Input className="pl-9"`), icon `Search` đã có ở
  `web/src/components/ui/icons.tsx:26`.
  Term nằm trong `useUiState` (không phải URL) — giống Jira; nó sống qua điều hướng
  nhưng không làm URL nhảy mỗi lần debounce.
  Placeholder phải nói ra được rằng qualifier dùng được, ví dụ
  `Search PRs — text, author:me, is:draft, review:required…`.
- **`page`**: `useState(1)`, **không** vào URL — một link `?page=5` cũ trỏ vào list đã
  đổi thì tệ hơn là vô dụng. Reset về 1 khi đổi chip state, khi search debounced đổi,
  và khi đổi repo.
- **Query**: `queryKey: ["gh-pulls", repo, prState, debouncedQ, page]`, url
  `?state=…&q=${encodeURIComponent(debouncedQ)}&page=${page}`, kiểu trả về đổi thành
  `{ items: Pull[]; hasMore: boolean }`. Endpoint này **chỉ** `GitHubPage` gọi (đã
  grep), nên đổi shape không ảnh hưởng chỗ khác.
- **`placeholderData: keepPreviousData`** (react-query v5, repo chưa dùng ở đâu): bấm
  Next mà không có nó thì list trắng một nhịp rồi mới vẽ lại. Đây là pattern mới cho
  repo — đổi lấy việc không nháy khi sang trang.
- **Layout hàng điều khiển**: hàng `justify-between` hiện tại (chips | New pull request)
  thành một hàng `flex flex-wrap items-center gap-2` ba phần: chips — ô search
  (`min-w-[12rem] flex-1`) — nút New PR. Chiều cao ô search kéo về ngang `h-8` của
  `FilterChip` cho thẳng hàng.
- **Pager** dưới list, chỉ render khi `page > 1 || hasMore`: `IconButton` với
  `ChevronLeft`/`ChevronRight` (cả hai đã có trong `icons.tsx:85-86`),
  `disabled={page === 1}` / `disabled={!hasMore}`, giữa là `Page {page}`.
- **Empty state**: điều kiện đổi thành `pulls.data?.items.length === 0`; khi đang có
  search thì câu chữ phải nói là không khớp query, chứ không phải repo không có PR.

### 4. Docs

- `README.md` mục GitHub: bổ sung ô search (có qualifier) + Prev/Next vào câu đã sửa
  lần trước.
- `docs/plans/github-search-paging.md`: plan này, kèm mục "Kết quả verify (đã chạy)"
  ở cuối như các plan khác trong repo.

## Edge case đã tính

- **Search + chip mâu thuẫn**: gõ `is:open` khi chip đang Closed → `gh` nhận query tự
  phủ định nhau và trả rỗng. Là lỗi của người gõ, EmptyState nói rõ "không khớp query"
  là đủ; không đi sửa query của người dùng.
- **Trang cuối**: `raw.length === want` đúng bằng biên → `hasMore = false`, Next disable.
  Không có trang trống ở cuối.
- **Đang ở page 3 rồi gõ search**: page reset về 1 _trước_ khi query mới bay đi, nên
  không có nhịp nào fetch page 3 của một kết quả chỉ có 5 dòng.
- **`?page=21`** → 400 từ zod (cap 20 ≈ 600 PR gần nhất). Muốn sâu hơn thì dùng search
  để thu hẹp, đó là lý do hai thứ này đi cùng nhau.
- **Relevance order khi có search**: PR mới nhất không còn nằm đầu. Đây là hành vi gốc
  của `gh pr list --search`, giữ nguyên chứ không tự chèn `sort:created-desc` vào query
  của người dùng.
- **`q` chỉ có khoảng trắng**: `.trim()` ở server → coi như không search.

## Verification

1. `npm run typecheck`, `eslint .`, `npm run build`, `npm test`.
2. API thật (server dev đang ở `:3789`, token ở `.env` là `CLAUDE_STATION_TOKEN`),
   đối chiếu từng cái với `gh`:
   - `?state=closed` (không `page`) → `items` 14 dòng, `hasMore:false` trên
     `Temp-art05/claude_station`; so với `gh pr list --state closed --limit 31`.
   - Repo sâu hơn (`cli/cli` qua route, hoặc `AperoVN/IIP555-ReelMe`):
     `?state=all&page=1` và `?page=2` → hai tập **không giao nhau**, và ghép lại phải
     khớp đúng `gh pr list --limit 60`. Đây là test quan trọng nhất: nó chứng minh
     slice không lặp hay bỏ sót dòng.
   - `?state=all&q=auth&page=1` → khớp `gh pr list --search auth --limit 31`.
   - `?q=author:<login>` → mọi dòng đúng một author.
   - `?page=21` → 400. `?q=` dài 300 ký tự → 400.
   - `?q=repo:torvalds/linux` → rỗng, **không** phải PR của linux.
3. UI: mở `/github`, gõ search thấy list đổi sau ~400ms; Next/Prev đi đúng và không
   nháy trắng; đổi chip khi đang ở page 2 thì về page 1; search không khớp gì thì thấy
   EmptyState nói về query.

## Bổ sung sau khi plan được duyệt: Next/Prev tự scroll lên đầu

Yêu cầu thêm giữa lúc impl. Điểm cần biết: app **không** scroll window — thứ cuộn là
`<main>` trong `web/src/components/AppShell.tsx:134`, và ref của nó do
`useScrollMemory` giữ, `GitHubPage` không với tới được.

Nên thay vì đi tìm element đó: đặt `pageTopRef` lên div ngoài cùng của trang và gọi
`pageTopRef.current?.scrollIntoView({ block: "start" })` trong một helper `goToPage`
dùng cho cả hai nút — browser tự tìm ancestor nào cuộn được, không cần `GitHubPage`
biết gì về AppShell.

Cố ý **không** `behavior: "smooth"`: các dòng bên dưới đang bị thay hết, glide qua một
giây nội dung cũ không được gì. `useScrollMemory` sẽ ghi lại vị trí mới như thường,
đúng như mong đợi.

Lưu ý về thứ tự: chỗ này code đi trước plan (ngược rule), vì nó là một yêu cầu nhỏ
mang tính cộng thêm gửi giữa turn; plan được cập nhật ngay sau đó.

## Bổ sung: loading state cho Next/Prev

`placeholderData: keepPreviousData` giữ layout không sụp khi sang trang, nhưng đổi lại
là các dòng trên màn hình **thuộc trang cũ** trong lúc `gh` trả lời — và ban đầu không
có gì báo điều đó, nên bấm Next trông như click không ăn.

Tách làm hai trạng thái vì chúng sai theo hai kiểu khác nhau:

- `pulls.isLoading` — chưa có gì trên màn hình. Vùng list trống sẽ bị đọc thành "repo
  không có PR nào".
- `prShowingStale = isPlaceholderData && isFetching` — có dòng, nhưng là dòng của trang
  trước. `&& isFetching` không phải cho đẹp: nếu query trang mới lỗi thì
  `isPlaceholderData` vẫn true mà `isFetching` false, thiếu nó thì list dim vĩnh viễn.

Xử lý: một dòng `Loading…` (theo đúng convention `TerminalsTab.tsx:157`, repo không có
spinner component) + list `opacity-45` khi đang stale, và **disable cả hai nút pager**
khi stale — `hasMore` thuộc về trang đang hiện, nên khi đó nó không đủ tin cậy để nói
có trang sau hay không.

## Độ trễ thật của scheme over-fetch (đo sau khi impl)

Đây là con số đáng lưu, và nó xấu hơn nhiều so với timing `gh` đo lúc thiết kế
(0.65s / 1.2s cho limit 30 / 150 — đó là `gh` chạy trần, không qua server):

| trang | `--limit` | thời gian API |
| ----- | --------- | ------------- |
| 1     | 31        | 2.3s          |
| 2     | 61        | 3.3s          |
| 3     | 91        | 5.3s          |
| 5     | 151       | 10.5s         |
| 10    | 301       | 19.9s         |
| 20    | 601       | 21.3s         |

Tăng gần tuyến tính theo độ sâu, đúng như bản chất của over-fetch. Hai hệ quả:

1. Loading state ở trên **không phải nicety** — không có nó thì page 5 là 10 giây màn
   hình không phản hồi.
2. Cap `page=20` chỉ bảo vệ server khỏi việc chạy vô hạn, **không** bảo vệ trải nghiệm.
   Và `ghRaw` timeout ở 60s (`gh.ts`), nên trên repo lớn / mạng chậm thì trang sâu có
   thể chạm timeout rồi fail.

Muốn paging sâu mà nhanh thì phải đổi kiến trúc: `gh api graphql` với cursor, mỗi trang
một request chi phí hằng số. Đó là việc riêng, không nằm trong phạm vi lần này — ghi ra
đây để lần sau không phải đo lại.

## Kết quả verify (đã chạy)

- `npm run typecheck`, `eslint .`, `npm run build`, `npm test` (95/95) — pass.
- **Slice không lặp và không bỏ sót** (test quan trọng nhất): trên `cli/cli`
  `?state=all&page=1` và `?page=2` mỗi trang 30 dòng, `page1 ∩ page2 = ∅`, và
  `page1 + page2` **bằng đúng từng phần tử** `gh pr list --limit 60`.
- `Temp-art05/claude_station` `?state=closed` → `items` 14, `hasMore:false`; khớp
  `gh pr list --state closed --limit 31` (14).
- `?q=auth&page=1` trên `cli/cli` → 30 số PR **trùng khít** 30 dòng đầu của
  `gh pr list --search auth --limit 31`, tức là relevance order được giữ nguyên và
  slice ăn đúng vào nó.
- `?q=author:mislav` → 30 dòng, tập author đúng `{'mislav'}`.
- `?q=repo:torvalds/linux` → 0 dòng, không rò repo ngoài Settings.
- Validation: `page=21` → 400, `page=20` → 200, `page=0` → 400, `page=abc` → 400,
  `q` 300 ký tự → 400. `q` chỉ khoảng trắng → hành xử như không search (14 dòng).
- **Lệch với plan, đã sửa**: plan định reset page bằng `useEffect`, nhưng lint rule
  `react-hooks/set-state-in-effect` chặn. Đổi sang idiom "adjust state during render"
  (`listKey` + `prevListKey`) — hoá ra đúng hơn: nó gom repo/state/query vào một chỗ
  thay vì rải setPrPage(1) qua ba handler, và render có page cũ bị bỏ luôn nên query
  không bao giờ bay đi với page không còn tồn tại.
- **Chưa verify bằng mắt**: web workspace **không có test setup nào** (không vitest,
  không testing-library) và máy không có Playwright/Puppeteer. Nên hàng search, pager,
  `Loading…`, list dim khi stale, và scroll-lên-đầu đều chỉ được chứng minh qua
  typecheck + lint + build, chưa xem trên browser thật.
