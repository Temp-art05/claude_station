# Plan — Giữ state UI khi chuyển tab / chuyển tính năng

## Mục tiêu

Chuyển sidebar (Projects ⟷ GitHub ⟷ Jira…) hoặc chuyển tab trong một project **không được xoá trạng thái đang làm việc**: tab nào đang mở, item nào đang chọn, filter/toggle đã set, text đã gõ nhưng chưa lưu, và vị trí scroll.

Sau khi làm xong, ba hành vi này phải đúng:

1. **Quay lại** một trang → thấy đúng chỗ đã rời đi (tab, selection, scroll).
2. **Reload / mở link mới** → URL tự mô tả được "đang mở cái gì" (deep-link được, Back/Forward của trình duyệt chạy đúng).
3. **Text đã gõ mà chưa submit không bao giờ mất im lặng** (commit message, workflow/agent editor, env draft).

## Chẩn đoán — vì sao đang mất

Có **bốn** nguyên nhân độc lập, phải xử lý riêng từng cái. Sửa một cái không cứu được ba cái kia.

### N1 — Đổi route ⇒ page unmount, mọi `useState` bị xoá

`web/src/main.tsx:22-40` dùng `createBrowserRouter` thường. React Router unmount hoàn toàn component của route cũ. Không có lớp nào giữ lại state.

Cụ thể mất:

| File | State mất |
| --- | --- |
| `web/src/pages/GitHubPage.tsx:110-113` | `tab`, `selectedRepo`, `selectedPr`, `newPrOpen` |
| `web/src/features/integrations/PrDetail.tsx:120` | sub-tab của PR (conversation/files/checks) |
| `web/src/pages/JiraPage.tsx:36` | issue đang chọn |
| `web/src/pages/EnvPage.tsx:65` | `vars` draft đang gõ |
| `web/src/pages/AgentsPage.tsx:21`, `WorkflowsPage.tsx:49` | form đang tạo dở |

Dữ liệu (React Query) thì **không** mất — `queryClient` là module-level singleton nên cache sống qua route. Cái mất thuần tuý là **state UI**.

### N2 — Đổi tab trong project ⇒ panel unmount

`web/src/pages/ProjectDetailPage.tsx:179-205` render kiểu `{tab === "diff" && <DiffTab/>}`. Rời tab là panel bị destroy.

Nặng nhất:

- `web/src/features/git/DiffTab.tsx:120-130` — `pathId`, file đang chọn, `unchecked` (những file bỏ tick khi commit), **`message` (commit message đang gõ)**, `sideBySide`, `bottomView`, `mdSource`. Mất commit message là mất dữ liệu người dùng thật sự.
- `web/src/features/terminals/TerminalsTab.tsx:36-38` — `selectedId`, `pathId`, `envSetId`. Kèm theo `TerminalPane` unmount → `web/src/features/terminals/TerminalPane.tsx:162-170` đóng WebSocket và `term.dispose()`. PTY phía server vẫn sống (`server/src/services/pty-manager.ts:12-26` có ring buffer scrollback và replay lại), nên **nội dung không mất**, nhưng: reconnect + vẽ lại toàn bộ scrollback, nhảy về đáy, mất vị trí scroll, mất selection, mất trạng thái cuộn lên đang đọc log.
- `web/src/features/workflows/WorkflowsTab.tsx:32-36` — `openRun`, `importOpen`, `startFor`.
- `web/src/features/commands/CommandsTab.tsx:41-42`, `web/src/features/memory/MemoryTab.tsx:27`, `web/src/features/git/BranchMenu.tsx:49`.

### N3 — Chính cái "tab đang mở" cũng là local state

`web/src/pages/ProjectDetailPage.tsx:63` — `const [picked, setTab] = useState<Tab | null>(null)`, và `tab = picked ?? fromUrl ?? "chat"`.

`?tab=` chỉ được đọc **một lần lúc vào**; click tab không ghi ngược lên URL. Hệ quả: reload → về `chat`; Back của trình duyệt không quay lại tab trước; rời project rồi vào lại → về `chat`. Cùng lỗi ở `GitHubPage.tsx:110` và `PrDetail.tsx:120` (tab không hề nằm trên URL).

### N4 — Không có scroll restoration

`web/src/components/AppShell.tsx` — `<main class="overflow-y-auto">` là scroll container. Không có `<ScrollRestoration/>`, không lưu `scrollTop`. Mọi lần quay lại đều về đầu trang. Các list cuộn bên trong (PR list, file tree của Diff, knowledge list) cũng vậy.

## Phạm vi

**Trong phạm vi:** toàn bộ web UI — `ProjectDetailPage` và các tab con, `GitHubPage` + `PrDetail`, `JiraPage`, `EnvPage`, `AgentsPage`, `WorkflowsPage`, `KnowledgePage`, `SearchPage`, và scroll restoration ở `AppShell`.

**Ngoài phạm vi (không đụng tới):** server, protocol WS, PTY daemon, schema DB. Toàn bộ thay đổi nằm trong `web/src`. Không đổi thiết kế/visual.

**Loại trừ có chủ đích — form của `EnvPage` không persist.** Env set chứa API key, token, secret
(`isSecret`). Hiện chúng chỉ nằm trong RAM và chết theo lần unmount. Ghi chúng vào `localStorage`
là đổi một tiện nghi lấy việc secret nằm lại trên đĩa vô thời hạn, đọc được bởi bất kỳ script nào
chạy trên origin này — kể cả sau khi env set đã bị xoá. Gõ lại vài dòng rẻ hơn nhiều. Phần
`editing`/`name`/`description` cũng không giữ: khôi phục nửa form (tên còn, secret trống) dễ gây
lưu nhầm hơn là bắt đầu lại.

**Draft khôi phục phải nói ra.** Draft cũ có thể lệch so với bản đã lưu trên server (người khác
sửa, hoặc chính mình sửa ở tab khác). Khôi phục im lặng rồi bấm Save = ghi đè bản mới bằng bản cũ.
Nên mỗi editor mở lên với draft khôi phục sẽ hiện `DraftNotice` + nút **Discard**.

## Kiến trúc — 4 lớp

Mỗi lớp giải đúng một nguyên nhân. Quy tắc phân loại: **cái gì đáng share qua link thì lên URL; cái gì riêng tư/rác thì vào store.**

| Lớp | Giải | Chứa gì | Nơi lưu |
| --- | --- | --- | --- |
| L1 URL | N3 | Cái gì đang mở: `?tab=`, `?repo=`, `?pr=`, `?issue=`, `?file=` | address bar |
| L2 Store | N1 | Toggle, filter, draft, selection phụ | `zustand` + `localStorage` |
| L3 Keep-alive | N2 | Panel nặng không bị unmount khi đổi tab | DOM (`hidden`) |
| L4 Scroll | N4 | `scrollTop` theo key | store (L2), `sessionStorage` |

`zustand@5.0.14` đã có sẵn trong `web/package.json` nhưng **chưa dùng ở đâu** — không cần thêm dependency mới.

### L1 — URL là nguồn sự thật cho "đang mở cái gì"

Thêm `web/src/lib/useUrlState.ts`:

```ts
/** Một param trên URL, đọc-ghi như useState. Ghi bằng replace: không rác history khi click tab. */
export function useUrlState(key: string, fallback: string): [string, (v: string) => void]
```

Áp dụng:

- `ProjectDetailPage.tsx:63` — bỏ `picked`, tab đọc/ghi thẳng `?tab=`.
- `GitHubPage.tsx:110-112` — `?tab=`, `?repo=`, `?pr=`.
- `PrDetail.tsx:120` — `?prtab=`.
- `JiraPage.tsx:36` — `?issue=`.

**Sửa so với bản đầu:** `DiffTab.tsx:121` **không** đưa lên `?file=`, mà vào store (L2).
`Selection` là union 3 nhánh (`change` / `file` / `commit` + `commit.file`); đưa mỗi nhánh `file`
lên URL sẽ khiến **một** state có **hai** chủ sở hữu — đúng loại lỗi đang đi sửa. Đổi lại là mất
khả năng share link tới 1 file diff; chấp nhận được vì đây là đường dẫn local trong máy, không
phải thứ gửi cho người khác.

Đổi tab dùng `replace: true` (không nhồi history); mở một PR/issue/file dùng `push` (Back đóng lại được — đúng kỳ vọng).

### L2 — Store UI có persist

Thêm `web/src/lib/uiStore.ts` — một zustand store duy nhất, `persist` vào `localStorage` key `cs.ui.v1`:

```ts
interface UiState {
  byProject: Record<string, ProjectUi>;   // key = projectId
  github: { repo: string; prTab: string };
  jira:   { jql: string };
  drafts: Record<string, string>;         // key = "commit:<projectId>:<pathId>" v.v.
}
```

Chứa (theo project, không lẫn giữa các project):

- Diff: `pathId`, `sideBySide`, `bottomView`, `mdSource`, `unchecked`, `amend`.
- Terminals: `selectedId`, `pathId`, `envSetId` (gộp luôn cái `localStorage` thủ công đang có ở `AgentWorkspace.tsx:82,135` cho nhất quán).
- Workflows/Commands/Memory: item đang chọn, filter.
- `drafts`: mọi ô text chưa submit.

**Ranh giới persist — panel giữ, modal không.** Panel/detail view (`openRun`, `selectedRun`,
`editing`, file đang chọn ở Diff) = "tôi đang ở đâu" → giữ. Modal dialog (`importOpen`,
`startFor`, `addFor`, `newPrOpen`, `editOpen`, `deleteOpen`) → **không** giữ: một hộp thoại tự
bật lên khi quay lại trang là mất phương hướng, không phải giữ ngữ cảnh. Con trỏ tới object thì
lưu **id**, không lưu cả object — object lưu lại sẽ cũ so với server.

**Ba quy tắc bắt buộc:**

1. **Version + migrate.** `persist` có `version: 1`; đổi shape sau này phải bump và viết `migrate`, không được để state cũ làm crash app.
2. **Validate khi đọc.** State phục hồi có thể trỏ tới thứ đã bị xoá (terminal đã kill, file đã commit, repo đã gỡ). Mọi selection đọc ra phải lọc qua danh sách hiện tại rồi mới dùng — pattern `activeId` sẵn có ở `TerminalsTab.tsx:52-54` là đúng, nhân rộng ra.
3. **Dọn rác.** Xoá project → xoá luôn entry của nó (hook vào `DeleteProjectDialog`). Draft rỗng thì xoá key thay vì lưu chuỗi rỗng.

### L3 — Keep-alive cho panel nặng

Thêm `web/src/components/KeepAlive.tsx`: mount lười (chỉ khi lần đầu được xem), sau đó **giữ mount** và ẩn bằng `hidden` khi không active.

```tsx
<KeepAlive active={tab === "diff"}><DiffTab project={project}/></KeepAlive>
```

Áp dụng ở `ProjectDetailPage.tsx:178-206` cho: `chat`(TerminalsTab), `terminals`, `diff`, `workflows`, và mỗi `AgentWorkspace` đang mở.

**Không** keep-alive cho: `knowledge`, `memory`, `agents`, `history` — nhẹ, dữ liệu đã có trong React Query cache, remount gần như tức thì; giữ chúng lại chỉ tốn RAM vô ích.

Ba điều phải xử lý cùng lúc:

- **`ResizeObserver` khi ẩn.** `TerminalPane.tsx:150-160` gọi `fit.fit()` trong observer. Panel `hidden` có kích thước 0 → `fit()` tính ra cols/rows rác và gửi `resize` sai lên PTY, làm vỡ layout terminal khi quay lại. Phải bỏ qua khi `offsetParent === null` / kích thước 0, và `fit()` lại một lần khi hiện ra.
- **Giới hạn số panel giữ sống.** Mỗi `AgentWorkspace` mở là một WebSocket + một xterm. Giữ vô hạn sẽ ăn RAM và socket. Dùng LRU: giữ tối đa **6** panel gần nhất, panel cũ hơn bị unmount (PTY server vẫn sống, quay lại chỉ là reconnect như hiện tại).
- **Không kéo trạng thái quá hạn.** Panel bị ẩn vẫn chạy `useQuery` với `refetchInterval`. Truyền
  cờ `active` xuống bằng React context (`usePanelActive`), không prop-drill.
  Chỉ tạm dừng poll **vô điều kiện**: `DiffTab` git-status 5s (`DiffTab.tsx:148`).
  **Giữ nguyên** hai poll có điều kiện — `useRuns` (`workflows/hooks.ts:90`) và `useCommandRuns`
  (`commands/hooks.ts:11`) tự tắt khi không còn job chạy, và tiến độ job đang chạy là thứ người
  dùng muốn thấy đúng lúc quay lại. Tắt chúng sẽ đổi một lỗi (lãng phí) lấy một lỗi tệ hơn
  (quay lại thấy trạng thái cũ).

### L4 — Scroll restoration

Thêm `web/src/lib/useScrollMemory.ts`: nhận `key`, lưu `scrollTop` (throttle qua `rAF`) vào `sessionStorage`, khôi phục sau lần paint đầu.

Áp dụng cho `<main>` ở `AppShell.tsx` (key = pathname) và các list cuộn trong: PR list ở `GitHubPage`, file tree ở `DiffTab`, `KnowledgePanel`, `HistoryTab`.

Dùng `sessionStorage` (không phải `localStorage`): scroll là thứ chỉ có nghĩa trong phiên hiện tại, khôi phục sau vài ngày là gây khó chịu.

**Riêng terminal:** xterm không dùng scrollTop của DOM. Đã keep-alive ở L3 nên viewport tự giữ nguyên — không cần làm gì thêm. Panel bị LRU đẩy ra thì vẫn về đáy như hiện tại; chấp nhận.

## Các bước theo thứ tự

Mỗi bước tự đứng được và test được riêng; dừng ở bất kỳ bước nào app vẫn chạy.

| # | Bước | File chạm |
| --- | --- | --- |
| 1 | `useUrlState` + đưa tab của ProjectDetail lên URL | `web/src/lib/useUrlState.ts` (mới), `pages/ProjectDetailPage.tsx` |
| 2 | URL cho GitHub (`repo`/`pr`/`tab`) + PrDetail sub-tab + Jira `issue` | `pages/GitHubPage.tsx`, `features/integrations/PrDetail.tsx`, `pages/JiraPage.tsx` |
| 3 | `uiStore` (zustand + persist + version/migrate) | `web/src/lib/uiStore.ts` (mới) |
| 4 | Nối DiffTab vào store — **ưu tiên commit message draft** | `features/git/DiffTab.tsx` |
| 5 | Nối Terminals/Workflows/Commands/Memory vào store; gộp localStorage thủ công của AgentWorkspace | `features/terminals/TerminalsTab.tsx`, `features/workflows/WorkflowsTab.tsx`, `features/commands/CommandsTab.tsx`, `features/memory/MemoryTab.tsx`, `features/agents/AgentWorkspace.tsx` |
| 6 | Draft cho các editor chưa lưu (workflow, agent, memory, command) | `features/workflows/WorkflowEditor.tsx`, `features/agents/AgentEditor.tsx`, `features/memory/MemoryTab.tsx`, `features/commands/CommandsTab.tsx`, `components/DraftNotice.tsx` (mới) |
| 7 | `KeepAlive` + LRU + sửa `fit()` khi ẩn + tạm dừng polling | `web/src/components/KeepAlive.tsx` (mới), `pages/ProjectDetailPage.tsx`, `features/terminals/TerminalPane.tsx` |
| 8 | `useScrollMemory` + gắn vào AppShell và các list | `web/src/lib/useScrollMemory.ts` (mới), `components/AppShell.tsx`, `pages/GitHubPage.tsx`, `features/git/DiffTab.tsx`, `features/knowledge/KnowledgePanel.tsx`, `features/history/HistoryTab.tsx` |
| 9 | Dọn rác store khi xoá project + `pnpm --filter web typecheck` | `features/projects/DeleteProjectDialog.tsx` |

## Edge case

- **Selection trỏ tới thứ đã chết** — terminal đã kill, PR đã merge, file đã commit, repo đã gỡ, workspace đã archive. Luôn validate với list hiện tại; không khớp thì fallback im lặng, không hiện lỗi.
- **`?tab=agent:<id>` của session đã archive** — `ProjectDetailPage.tsx:88` đang lọc theo `allTabs`, giữ nguyên cách này; fallback về `chat`.
- **Nhiều tab trình duyệt cùng mở** — `persist` của zustand ghi đè lẫn nhau giữa các tab. Chọn: **không** bật đồng bộ cross-tab; mỗi tab tự chạy, ghi sau thắng. Đồng bộ live sẽ làm hai cửa sổ giật selection của nhau.
- **Deep link `?terminal=&seed=`** — `TerminalsTab.tsx:41-48` xoá param sau khi dùng; store không được ghi đè logic một-lần này. Giữ nguyên `seedTarget` là `useState` khởi tạo từ URL.
- **Quota `localStorage`** — draft dài (workflow prompt) có thể phình. Cap mỗi draft ở 64KB, bọc `try/catch` quanh mọi lần ghi, đầy thì âm thầm bỏ qua chứ không làm vỡ UI.
- **Store cũ, shape mới** — `migrate` thất bại thì reset về mặc định, không crash.
- **`unchecked` là `Set`** — `JSON.stringify` ra `{}`. Phải serialize thành mảng trong `partialize`/`merge`.
- **StrictMode double-mount** (`main.tsx:43`) — `KeepAlive` và `useScrollMemory` phải idempotent, không đếm mount.

## Sửa vòng 2 (2026-08-12) — lỗ hổng thật, do người dùng phát hiện

### Lỗi L1-only: điều hướng bằng sidebar làm mất "đang mở cái gì"

Bản đầu đặt tab/selection **chỉ** trong URL. Nhưng bấm `Projects` ở sidebar đi tới `/projects` —
một URL **mới, không mang param nào**. Vào lại project → `?tab=` không tồn tại → rơi về `chat`.
Reload và Back đúng (có test), nhưng đúng luồng dùng thật thì hỏng.

Lỗi này áp cho **cả ba** trang có state trên URL: `ProjectDetailPage` (`?tab=`),
`GitHubPage` (`?tab=`/`?repo=`/`?pr=`), `JiraPage` (`?issue=`).

**Sửa:** L1 và L2 phải hợp tác, không phải chọn một. Hook mới `useStickyUrlState` /
`useStickyUrlStateOptional`:

- URL **có** param → URL thắng (link paste, Back/Forward, reload vẫn đúng).
- URL **không** có → lấy giá trị lần cuối từ store, và ghi ngược lên URL bằng `replace`
  (không đẻ history entry) để reload sau đó vẫn nhất quán.
- Mọi lần ghi cập nhật **cả hai**.

### Bỏ giới hạn LRU — giữ tất cả panel

Người dùng chốt lại: giữ **hết**, không phải 6. `RETAIN_LIMIT` = `Infinity`.
Đánh đổi đã nêu vẫn đúng và giờ không còn trần: mỗi agent workspace / terminal giữ sống một
WebSocket và một instance xterm, mở càng nhiều tab thì RAM và số socket càng tăng, không tự thu hồi.
Cơ chế LRU giữ nguyên trong code nên chỉnh lại chỉ là đổi một hằng số.

### State còn sót, bổ sung nốt

`JiraPage.jql` (ô tìm kiếm), `SearchPage.term`, `WorkflowsPage.folder` (filter thư mục) — đều là
`useState` trần, mất khi rời trang. Đưa vào store.

Vẫn **không** persist: form `EnvPage` (secret), và mọi modal dialog — lý do như hai mục trên.

### Vòng 3 — route-level keep-alive (đã chốt: làm)

Đổi trang bằng sidebar (`/projects/:id` → `/github`) vẫn **unmount** `ProjectDetailPage`, vì nó nằm
trong `<Outlet/>` của router. Panel bị destroy; state được **khôi phục** (URL + store + server replay
scrollback), chứ không phải **giữ sống**. Khác biệt thực tế còn sót lại:

- Terminal reconnect + vẽ lại scrollback (có nháy), và về đáy — mất vị trí đang cuộn đọc log.
- Panel dựng lại từ đầu thay vì hiện ra tức thì.

**Cách làm:** kéo `ProjectDetailPage` ra **ngoài** `<Outlet/>`, render trong `AppShell`, ẩn khi
không ở route project.

- `main.tsx`: route `projects/:id` giữ nguyên path nhưng `element: null` — router vẫn match URL,
  chỉ không render gì qua `<Outlet/>`.
- `AppShell`: `useMatch("/projects/:id")` lấy id đang mở; `useRetainedKeys(id, Infinity)` giữ danh
  sách mọi project đã vào; render mỗi cái trong một `KeepAlive`.
- `ProjectDetailPage` nhận `projectId` qua **prop**, không dùng `useParams()` nữa — khi bị ẩn thì
  `useParams()` trả về param của route hiện tại (ví dụ đang ở `/github`), tức là sai project.
- `KeepAlive` phải **lồng nhau đúng**: panel `diff` bên trong project bị ẩn thì `usePanelActive()`
  phải trả `false`, nếu không nó vẫn poll git-status cho một project không hiện trên màn hình.
  → context mới = `active && parentActive`.

**Chi phí:** mọi project đã vào ở lại trong DOM đến khi reload trang, kèm terminal và WebSocket của
nó. Đây là hệ quả trực tiếp của yêu cầu "giữ hết state", không phải tác dụng phụ ngoài ý muốn.

### Vòng 4 — trang bị ẩn không được đụng vào URL

Hệ quả trực tiếp của vòng 3 mà bản đầu bỏ sót: `ProjectDetailPage` bị ẩn **vẫn chạy hook**, nên

- `useSearchParams()` của nó trả về param của trang **đang hiện** (`/github?tab=pulls`), không phải
  của project;
- effect backfill của nó **ghi `?tab=diff` lên URL của `/github`** — mà `GitHubPage` cũng đọc
  `?tab=`. Hai trang độc lập tranh nhau một param, một trong hai vô hình.

**Sửa:** `useStickyUrlState`/`useStickyUrlStateOptional` nhận thêm `enabled`. Khi `false` thì bỏ qua
URL hoàn toàn (chỉ đọc store) và không ghi gì. `ProjectDetailPage` truyền `enabled: usePanelActive()`.
Effect xoá `?terminal=`/`?seed=` trong `TerminalsTab` cũng gate theo `onScreen` vì cùng lý do.

### Vòng 5 — mất *project đang mở*, không phải state bên trong

Triệu chứng người dùng báo, và là thứ tôi hiểu sai suốt bốn vòng trước: đang làm trong một project,
bấm `GitHub`, rồi bấm `Projects` → về **màn danh sách**, phải tự tìm lại project.

Không phải lỗi state. `Projects` ở sidebar trỏ cứng `/projects`, và không có đường nào quay lại
project vừa làm ngoài việc bới lại danh sách. Bốn vòng trước tôi đi sửa state *bên trong* project
trong khi thứ bị mất là *chính project đó*.

**Sửa:** `Projects` ở sidebar **quay về project đang mở**, đúng cách `GitHub` quay về repo + PR đang
xem. Id lưu ở `globalKey("lastProject")` nên sống qua cả reload, và được validate với danh sách
project thật trước khi dùng (project có thể đã bị xoá).

Highlight tách khỏi đích đến: `to` trong `NAV` vẫn là gốc section (`/projects`) để so khớp
`pathname`, còn chỗ bấm tới có thể sâu hơn (`/projects/<id>`). Nếu dùng `NavLink` mặc định thì ở màn
danh sách sẽ không có mục nào sáng.

**Đường về danh sách:** breadcrumb `Projects` sẵn có ở đầu trang project (`ProjectDetailPage.tsx:133`).

Bản đầu của vòng này tôi làm khác — thêm danh sách project đang mở thành các mục con dưới `Projects`.
Người dùng bác: không muốn thêm thành phần mới trong nav, muốn đúng hành vi của `GitHub`. Đã gỡ.

### Vòng 6 — hai lần `setSearchParams` trong một handler **không** cộng dồn

Triệu chứng: ở GitHub không đổi được repo, và bấm Back không thoát khỏi PR về danh sách.

`node_modules/react-router/dist/development/lib/dom/lib.js:761`:

```js
nextInit(new URLSearchParams(searchParams))   // searchParams = snapshot của render trước
```

`searchParams` là `useMemo` theo `location.search`. Gọi hai lần trong cùng một handler thì **cả hai
đều nhận snapshot cũ**, và `navigate` lần sau ghi đè lần trước.

- `closePr()` = `setPr(null)` rồi `patchUrl({prtab:null})` → lệnh sau tính từ snapshot vẫn còn
  `pr=829` → URL cuối vẫn có `pr` → PR không đóng được.
- Đổi repo = `setRepo(v)` rồi `closePr()` → hai navigate sau ghi đè, repo mới bị mất.

Đây đúng là thứ `useUrlPatch` sinh ra để tránh, và ở vòng 2 tôi tự phá luật bằng cách gọi nối tiếp
hai setter.

**Sửa:** hook sticky trả thêm phần tử thứ ba `setStore` (chỉ ghi store). Hành động chạm nhiều param
thì cập nhật store trực tiếp và gộp **toàn bộ** thay đổi URL vào **một** `useUrlPatch`.

**Luật cần nhớ:** một hành động của người dùng = **tối đa một** lần ghi URL.

## Tình trạng — xong 10 bước gốc + vòng 2 → 6 (2026-08-12)

File mới: `web/src/lib/useUrlState.ts`, `web/src/lib/uiStore.ts`, `web/src/lib/useScrollMemory.ts`,
`web/src/components/KeepAlive.tsx`, `web/src/components/DraftNotice.tsx`.

Đã verify: `web typecheck` sạch, `vite build` thành công, dev server boot và serve module OK,
`eslint web/src` chỉ còn **1 lỗi có sẵn từ trước** ở `web/src/features/git/FileTree.tsx:49`
(không thuộc phạm vi thay đổi này), `npm test` 48/48 pass.
**Chưa** kiểm chứng tương tác bằng tay trên trình duyệt — cần người dùng bấm thử.

## Đã chốt (2026-08-12)

1. **Phạm vi** — làm cả 9 bước, cộng bước 10 dưới đây.
2. **Nơi lưu** — `localStorage` cho draft/toggle/selection (`cs.ui.v1`), `sessionStorage` cho scroll (`cs.scroll`).
3. **LRU keep-alive** — giữ **6** panel gần nhất.
4. **Reset UI state** — có, thêm nút trong Settings.

| # | Bước bổ sung | File chạm |
| --- | --- | --- |
| 10 | Nút "Reset UI state" trong Settings: xoá `cs.ui.v1` + `cs.scroll`, reload | `pages/SettingsPage.tsx` |
