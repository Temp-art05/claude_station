# Redesign UI: Material 3 Expressive + Liquid Glass

## Context

UI hiện tại (xem ảnh trang GitHub) trông "cổ điển": chữ tiêu đề nhỏ (`text-lg font-semibold` lặp ở 12 page),
bo góc nhỏ và không nhất quán (67 chỗ `rounded-md`, 3 chỗ `rounded-xl`), nền phẳng xám
(50 chỗ `border-edge`, 36 chỗ `bg-surface` dùng ad-hoc thay vì primitive), icon lucide nét mảnh
đồng đều nên không có phân cấp thị giác, transition tuyến tính 150ms nên không có cảm giác vật lý.
Lớp `glass` đã có trong `web/src/index.css` nhưng chỉ được dùng ở 9 chỗ nên phần lớn app không hưởng.

Mục tiêu: đưa toàn bộ web sang hệ Material 3 (Expressive) + liquid glass, icon Material Symbols
Rounded, giữ nhận diện teal hiện tại. Chốt với người dùng: **icon = Material Symbols Rounded**,
**phạm vi = foundation + primitives + sweep toàn app**, **màu = giữ teal làm M3 primary + dựng tonal
palette**, **motion = expressive**.

Không đổi: mọi logic/data-flow, tên token Tailwind đang dùng (giữ làm alias để 37 file không phải
sửa class), cấu trúc route/state.

---

## Bước 0 — Ghi plan vào repo

Copy plan này thành `docs/plans/ui-material3-liquid.md` (theo quy ước `docs/plans/` của repo).
Mọi thay đổi phạm vi sau này sửa file đó trước, rồi mới sửa code.

## Bước 1 — Foundation: token M3 (`web/src/index.css`)

Trong `@theme`, dựng tonal palette M3 dark từ seed teal `#2dd4bf`, **giữ nguyên tên token cũ làm
alias** để 50 chỗ `border-edge` / 36 chỗ `bg-surface` / `text-ink-muted` … tự nhận giá trị mới:

- Primary: `--color-primary #4fd9c8`, `--color-on-primary #00201c`,
  `--color-primary-container #00504a`, `--color-on-primary-container #71f7e4`
  → alias `--color-accent`, `--color-accent-ink`, `--color-accent-hover`.
- Secondary container `#1f3a37`; Tertiary lấy từ `--color-think` cũ: `#c3b5fd` / container `#322a55`.
- Error `#ffb4ab` / container `#5c1a1a` → alias `--color-err`; `--color-ok`, `--color-warn` retune
  theo tonal (T80 trên dark).
- Surface tonal: `surface-dim #0b0d10`, `surface #101317`,
  `container-lowest/low/default/high/highest = #070a0d / #14181c / #181c21 / #232830 / #2d333c`
  → alias `--color-base`, `--color-surface`, `--color-surface-2`, `--color-surface-3`.
- `--color-outline #8b939f`, `--color-outline-variant #3a4048` → alias `--color-edge`,
  `--color-edge-strong`. Giữ `--color-hairline*` cho lớp kính.
- State layer M3: `--state-hover 8%`, `--state-focus 10%`, `--state-press 12%`, `--state-drag 16%`.
- Shape scale M3: `--radius-xs .25rem`, `sm .5rem`, `md .75rem`, `lg 1rem`, `xl 1.25rem`,
  `2xl 1.75rem` (28px), `pill 999px`.
- Motion M3: `--ease-emphasized cubic-bezier(.2,0,0,1)`,
  `--ease-emphasized-decel cubic-bezier(.05,.7,.1,1)`,
  `--ease-emphasized-accel cubic-bezier(.3,0,.8,.15)`,
  `--ease-spring cubic-bezier(.34,1.56,.64,1)`;
  `--dur-short 150ms/200ms`, `--dur-med 300ms/400ms`, `--dur-long 500ms`.
- Elevation M3 level 0–3 (`--shadow-e1..e3`) thay cho `--shadow-glass`/`--shadow-lift` (giữ alias).
- Type scale M3 làm `@utility`: `m3-display-sm`, `m3-headline-sm/md`, `m3-title-sm/md/lg`,
  `m3-body-sm/md`, `m3-label-sm/md` (font-size + line-height + tracking chuẩn M3) để thay dần các
  `text-[10.5px]`, `text-[12.5px]`, `text-[13px]` rải rác.
- Giữ nguyên font stack (Outfit → Plus Jakarta cho dấu tiếng Việt).

## Bước 2 — Liquid glass utilities (`web/src/index.css`)

Viết lại `glass` / `glass-raised` / `glass-flat` và thêm `liquid`, `liquid-interactive`:

- Viền gradient specular bằng double-background (`padding-box` + `border-box`) thay vì
  `1px solid hairline` phẳng.
- Highlight mép trên (`inset 0 1px 0 rgb(255 255 255/18%)`) + pool sáng radial ở góc trên-trái.
- `backdrop-filter: blur(24px) saturate(180%) brightness(1.04)`.
- `liquid-interactive`: hover nâng elevation + quét sheen (`::after` translate) với
  `--ease-emphasized-decel`; active `scale(.985)` với `--ease-spring`; state layer dùng
  `--state-hover/--state-press` thay vì `bg-white/6` hard-code.
- Ambient light `body::before` giữ nhưng đổi sang primary/tertiary container mới, giảm bán kính
  để không rửa trôi bảng màu.
- `@media (prefers-reduced-motion: reduce)` tắt sheen/transform.

## Bước 3 — Icon: Material Symbols Rounded

- Thêm dep `@material-symbols/font-400` (self-hosted, offline — cùng cách các font hiện tại),
  `@import "@material-symbols/font-400/rounded.css"` trong `index.css`.
- `web/src/components/ui/icon.tsx`: base `<Icon name size fill weight grade />` render
  `<span class="ms">` với `font-variation-settings: 'FILL' x, 'wght' y, 'GRAD' z, 'opsz' size`,
  có transition `font-variation-settings` để icon active **morph sang filled** (chữ ký M3).
- `web/src/components/ui/icons.tsx`: export ~45 component **trùng tên lucide đang dùng**
  (`Plus`, `Trash2`, `ExternalLink`, …) với cùng prop `size`/`className` → migrate chỉ là đổi
  import path. Bảng map chính:
  `FolderKanban→space_dashboard`, `Ticket→confirmation_number`, `BookOpen→menu_book`,
  `Brain→psychology`, `Bot→smart_toy`, `Workflow→schema`, `KeyRound→key`, `Settings→settings`,
  `Search→search`, `Terminal(Square)→terminal`, `Plus→add`, `Trash2→delete`, `Pencil→edit`,
  `Check→check`, `X→close`, `ChevronDown→keyboard_arrow_down`, `ChevronRight→chevron_right`,
  `ExternalLink→open_in_new`, `Download→download`, `Upload→upload`, `Paperclip→attach_file`,
  `Send→send`, `RefreshCw→refresh`, `RotateCcw→rotate_left`, `RotateCw→rotate_right`,
  `ListRestart→restart_alt`, `SkipForward→skip_next`, `StopCircle→stop_circle`,
  `CirclePause→pause_circle`, `CircleAlert→error`, `Sparkles→auto_awesome`, `Users→group`,
  `Archive→archive`, `Rows3→table_rows`, `LocateFixed→my_location`,
  `MessageSquarePlus→add_comment`, `FileText/File→description`, `FileDiff→difference`,
  `FilePlus→note_add`, `FileSpreadsheet→table_view`, `FileUp→upload_file`, `Folder→folder`,
  `FolderPlus→create_new_folder`, `FolderInput→drive_file_move`,
  `FolderUp→drive_folder_upload`, `FolderGit2→snippet_folder`, `GitCommitHorizontal→commit`,
  `GitMerge→merge`.
- **Ngoại lệ có chủ ý**: `GitPullRequest` và `GitBranch` không có glyph tương đương dễ nhận ra
  trong Material Symbols → giữ 2 icon SVG inline vẽ theo grid 24px/nét rounded, export từ cùng
  module. Ngữ nghĩa git là thứ người dùng nhận ra bằng hình, không đánh đổi cho tính thuần M3.
- Sweep: `sed 's|from "lucide-react"|from "@/components/ui/icons"|'` trên 37 file
  (`web/src/**/*.tsx`), rồi bỏ `lucide-react` khỏi `web/package.json`. `grep -r lucide web/src`
  phải rỗng.

## Bước 4 — Primitives M3 (`web/src/components/ui/`)

Giữ nguyên API/prop hiện có để không phải sửa call site, chỉ đổi style bên trong:

- `button.tsx`: `primary`→M3 **filled**, `secondary`→**tonal** (secondary-container),
  `ghost`→**text**, `danger`→tonal error; thêm `outlined`. Cao 40px (`md`) / 32px (`sm`) /
  40px (`icon`), full-round, state layer `::after`, press `scale(.97)` spring, icon dẫn 18px.
- `card.tsx`: `Card` = surface-container-low + `liquid` + `rounded-xl`; thêm prop `interactive`
  cho card click được (elevation 1→3). `Badge` giữ pill cho status, thêm dáng chip M3 8px cho
  nhãn dữ liệu.
- `tabs.tsx`: đổi pill → **M3 tabs có indicator trượt** (đo `left/width` của tab active, animate
  bằng `--ease-emphasized`; không thêm dep). Giữ `closable`.
- `input.tsx`: outlined text field M3 — `rounded-md`, viền `outline`, focus viền 2px primary,
  `Label` lên `m3-label-md`.
- `dialog.tsx`: `rounded-2xl` (28px), scrim `bg-black/32 backdrop-blur`, enter
  scale/translate với `--ease-emphasized-decel`, title `m3-title-md`.
- Mới: `page-header.tsx` (`<PageHeader title supporting actions />`) thay 12 chỗ
  `<h1 className="text-lg font-semibold">` — headline M3 + dòng phụ + slot action;
  `icon-button.tsx` (40px, state layer, dùng cho các chỗ `Button size="icon"` dày đặc).

## Bước 5 — AppShell (`web/src/components/AppShell.tsx`)

Navigation drawer M3: panel `rounded-2xl` + `glass`, item cao 56px `rounded-pill`, active =
secondary-container + **icon filled** (`fill={active ? 1 : 0}`) + label weight 600, inactive =
state-layer hover. Brand: ô squircle 12px gradient primary-container, tên app `m3-title-lg`.
Group label lên `m3-label-md`. Footer version thành chip nhỏ. Main panel `rounded-2xl`.

## Bước 6 — Sweep toàn app

Áp cho `web/src/pages/*.tsx` (12 file) và `web/src/features/**/*.tsx` (~25 file), theo thứ tự dày
đặc nhất trước — `features/integrations/PrDetail.tsx`, `pages/GitHubPage.tsx`,
`features/git/DiffTab.tsx`, `features/git/BranchMenu.tsx`, `features/chat/ChatTab.tsx`,
`features/commands/CommandsTab.tsx`, `features/terminals/TerminalsTab.tsx`,
`pages/SettingsPage.tsx`, `pages/EnvPage.tsx`, `features/workflows/WorkflowsTab.tsx`,
`features/knowledge/KnowledgePanel.tsx`, `features/agents/AgentEditor.tsx` — rồi phần còn lại:

1. `<h1 className="text-lg font-semibold">` → `<PageHeader>`.
2. Container/card ad-hoc (`rounded-md border border-edge bg-surface…`) → `<Card>` hoặc lớp
   `liquid` + shape scale mới (list row 16px, panel 20px, overlay 28px). Input/chip nhỏ giữ 12px.
3. Font-size ad-hoc (`text-[10.5px]`, `text-[12.5px]`, `text-[13px]`, `text-xs` lạc chuẩn) →
   utility `m3-*`.
4. `bg-white/4..10` hard-code → state-layer token.
5. Row danh sách (PR, issue, branch, release, env set, agent, workflow) dùng chung dáng
   "M3 list item": leading icon 20px trong ô tonal, 2 dòng text, trailing action mờ đến khi hover.
6. `GH_SHORTCUTS` trong `GitHubPage.tsx` → assist chip M3 thay vì nút xám nhỏ.
7. Trang trống (`Projects`, `GitHub` khi chưa cấu hình) dùng empty-state M3: icon lớn trong ô
   tonal + headline + nút filled — chỗ hiện tại là mảng đen trống trong ảnh.

## Bước 7 — Bề mặt không phải DOM

- `web/src/features/terminals/TerminalPane.tsx`: `THEME` xterm đổi sang surface/primary mới
  (background `#101317`, cursor primary, ANSI theo tonal mới).
- CodeMirror (`features/git/FileEditor.tsx`, `SideBySideDiff.tsx`) và
  `features/git/MarkdownView.tsx`: kiểm tra nền/viền còn khớp; chỉ retune biến màu, không đổi theme dep.
- `web/index.html`: `<meta name="theme-color">` `#0e1013` → `#0b0d10`.

## Bước 8 — Đồng bộ tài liệu

- `docs/plans/ui-material3-liquid.md` (bước 0) cập nhật nếu phạm vi lệch.
- `README.md`: 7 ảnh screenshot (`docs/images/*.png`) sẽ lệch giao diện sau restyle → tôi sẽ
  chụp lại từ app đang chạy và thay, hoặc báo lại nếu bạn muốn tự chụp.

---

## Verification

1. `npm run typecheck` và `npm run lint` (root) — phải sạch; `npm run build -w web` phải pass
   (`tsc --noEmit` + vite build).
2. `grep -rn "lucide" web/src web/package.json` → rỗng. `grep -rn "https\?://" web/src/index.css`
   → rỗng (không CDN, app phải chạy offline).
3. Chạy `npm run dev`, mở `http://127.0.0.1:5173` và duyệt: Projects (grid + empty state),
   Project detail (Terminals / Chat / Diff / Commands), GitHub (5 tab + mở 1 PR), Jira, Knowledge,
   Memory, Agents, Workflows (mở 1 run), Env, Search, Settings — chụp screenshot từng trang để so
   với trước.
4. Kiểm tra bằng mắt: một terminal thật (font/màu/không giật khi resize), một diff lớn
   (`DiffTab` scroll dài), một dialog (Escape + click scrim), tab indicator trượt đúng khi
   tab wrap xuống 2 dòng.
5. Contrast: `ink-muted` và `ink-faint` trên `surface-container*` mới phải ≥ 4.5:1 ở 11–13px
   (lý do các token này từng được nâng sáng — không được để tụt lại).
6. Tiếng Việt: một PR/issue title có dấu (ảnh của bạn có "Gửi creditCost… để BE trừ coin") phải
   không bị mất dấu — fallback Plus Jakarta còn nguyên.
7. `prefers-reduced-motion`: bật Reduce Motion trong macOS → không còn sheen/scale.

## Rủi ro / điểm cần bạn quyết nếu phát sinh

- `@material-symbols/font-400` (~1.6MB unpacked cho cả 3 style) chỉ import biến thể rounded; nếu
  woff2 rounded > ~600KB tôi sẽ báo lại và cân nhắc subset thủ công theo ~45 glyph đang dùng.
- Nếu trục `FILL` không có trong bản font-400, bỏ hiệu ứng morph và dùng 2 tên glyph
  (outlined/filled) thay thế.

---

## Đã triển khai — sai lệch so với plan ban đầu

Ghi lại để plan khớp code (plan là source of truth cho phạm vi/luồng):

1. **Icon size**: thay vì sed từng `size={n}` ở call site, `Icon` (`web/src/components/ui/icon.tsx`)
   ép **sàn 16px** — Material Symbols vẽ trên grid 24px/weight 400, dưới 16px bị nhoè. Sau đó vẫn
   chuẩn hoá luôn 148 chỗ `size={9..15}` → `size={16}` để prop không "nói dối" về thứ được render.
2. **Glyph không có trong Material Symbols**: `auto_awesome` (Sparkles) đã bị Google bỏ → dùng
   `wand_stars`; `push_pin` → `keep` / `keep_off`. `GitPullRequest` + `GitBranch` giữ **SVG tự vẽ**
   trong `icons.tsx` như plan.
3. **`rounded-md` giữ nguyên 12px** thay vì đẩy hết lên 16px: 12px đúng là "medium" trong shape
   scale M3 và phù hợp row dày đặc. Radius lớn chỉ áp cho tầng page: drawer/main/dialog `2xl` (28px),
   card `xl` (20px).
4. **Utility `m3-body-*` / `m3-label-*` KHÔNG set `font-weight`**: 143 call site đã tự khai
   `font-medium|semibold|bold` cạnh class size; utility mà set weight sẽ đánh nhau với chúng
   (cùng specificity). `m3-title-*` / `m3-headline-*` vẫn giữ weight.
5. **Thêm `FilterChip`** (`web/src/components/ui/chip.tsx`): cùng một hàng chip lọc folder bị
   hand-roll ở 3 file (knowledge, workflows, attach-from-library) và đã lệch nhau — gom về một chỗ.
6. **Hai vòng feedback từ người dùng, đã áp**:
   - *Liquid quá sáng* → glass fill mix từ `surface-container-lowest`, `backdrop-filter`
     `brightness(1.03)` → `0.96`, specular giảm ~½, sheen hover 13% → 7%.
   - *Border thiếu tương phản* → chuyển sang "double stroke": viền sáng nhẹ **+** vòng tối
     `0 0 0 1px rgb(0 0 0/45%)` nằm trong `--shadow-e1..e4`; `liquid-flat`/`glass-flat` (panel chính)
     trước đó không có viền nào nên nay có; `--color-edge` `#262b34` → `#3b424b`, hairline 7% → 11%.
7. **Chưa làm**: chụp lại 7 screenshot trong `README.md` (`docs/images/*.png`) — giao diện đã đổi nên
   ảnh cũ lệch; cần chốt với người dùng ai chụp.
8. **Lint**: `web/src/features/git/FileTree.tsx:49` báo `react-hooks/set-state-in-effect` — lỗi
   **có từ trước**, không thuộc phạm vi lần này (diff của file chỉ đổi class).

## Vòng 3 — revert "prod polish" + đổi bảng màu

- Người dùng thử hướng "prod tool" (font Inter, radius nhỏ, bỏ viền gradient + sheen, giảm chroma) và
  **không thích** → đã revert nguyên trạng: Outfit + Plus Jakarta, radius M3 (28/20/16/12), viền
  gradient specular + sheen quét + press squash, shadow double-stroke, type scale cũ. Dep
  `@fontsource-variable/inter` đã uninstall.
- Bảng màu mới theo ảnh reference người dùng gửi:
  - Surface **ấm (nâu)** thay vì charcoal lạnh: `dim #100e0c` → `container-highest #35302b`,
    `on-surface #f7f3ef`, `on-surface-variant #c4bbb2`, `outline-variant #453f39`.
  - `primary` = **xanh lá `#3fd898`** và chỉ dùng làm *token* (label, count, status, glyph active).
  - Thêm cặp **inverse**: `--color-inverse-surface #f6f3f0` / `--color-on-inverse-surface #171412`
    cho trạng thái "sáng lên" — nút primary, nav item đang chọn, tab indicator, filter chip đang chọn.
    Mỗi lúc chỉ một mảng trắng nên thứ cần bấm là thứ duy nhất phát sáng.
  - Semantic theo ảnh: `ok #3fd898`, `warn #ffb020`, `err #ff6259`, thêm `info #5aa9ff`,
    `tertiary #b79cf8`.
  - Terminal xterm + `<meta theme-color>` đồng bộ palette ấm.

## Vòng 4 — nền xám neutral, controls tự vẽ

- **Nền**: bỏ hẳn sắc nâu (nó làm mọi overlay `bg-white/8` + chữ muted trông olive/vàng). Ramp neutral
  nâng khỏi đen: `surface-dim #1a1a1b` → `container-highest #38383a`; glass giờ mix từ bậc **trên**
  nền (`container-low` 72%) nên panel sáng hơn nền thay vì tối hơn.
- **Chữ**: `on-surface #ffffff`, `on-surface-variant #dcdcde`, `outline #a3a3a6` — trung tính, không
  ăn theo sắc nền. Vùng sáng ambient đổi từ amber sang tím/xanh lá vì ánh vàng lọt qua kính làm chữ ngả vàng.
- **Trạng thái "sáng lên" = trắng** ở mọi control: nút primary, nav item, tab indicator, `FilterChip`,
  tab terminal, segmented "Project files / History" trong Diff. Chip lọc ở `WorkflowsPage` trước đó là
  bản hand-roll còn dùng `secondary-container` → đã đổi sang `FilterChip` dùng chung.
- **`PageHeader`**: khi không có dòng phụ thì căn giữa theo ô icon (trước đó `items-start` làm tiêu đề
  bị lệch xuống).
- **Favicon**: `web/public/favicon.svg` vẽ lại theo logo sidebar, xanh lá `#3fd898` + glyph `#05261a`.
- **`Select` mới** (`web/src/components/ui/select.tsx`): thay **cả 28** `<select>` native trong 15 file.
  Popup native do OS vẽ nên không style được (đó là control duy nhất còn "cổ điển"); giờ trigger là
  button glass, list là sheet `liquid-raised` render qua portal (thoát mọi `overflow: hidden`), tự lật
  lên khi thiếu chỗ bên dưới, Escape/click-ngoài để đóng.
- **`ConfirmProvider` + `useConfirm()`** (`web/src/components/ui/confirm.tsx`): thay **cả 14**
  `window.confirm()` trong 11 file. API promise-based nên call site vẫn đọc như cũ
  (`if (await confirm({...}))`); `tone: "danger"` cho hành động phá dữ liệu. Provider mount ở
  `web/src/main.tsx`.

## Vòng 5 — chụp lại screenshot cho README

Ảnh chụp từ chính Claude Station đang chạy (dữ liệu thật), bằng headless Chrome điều khiển qua CDP
(`Page.navigate` + `Page.captureScreenshot`), profile tạm nên không đụng session của người dùng.

Hai cái bẫy gặp phải, ghi lại để lần sau không mất thời gian:

1. **Phải dùng `http://claude.station`, không phải `127.0.0.1:5173`.** Đúng như `scripts/setup-host.sh`
   đã cảnh báo trong comment đầu file: khi pf redirect được cài, pf sở hữu cổng 5173 làm redirect
   target và reverse-translate cả reply của kết nối trực tiếp → Chrome nhận `ERR_CONNECTION_TIMED_OUT`.
2. **Cờ `--screenshot` của Chrome không bao giờ trả về với app này** — websocket + poller làm
   `--virtual-time-budget` không có điểm tĩnh để kết thúc. Phải drive qua CDP và tự chờ.

Trạng thái cần chuẩn bị trước khi chụp: run view của workflow được mở bằng cách seed
`localStorage['cs.ui.v1']` (zustand persist) key `p/<projectId>/workflows/openRun`, vì "run nào đang
mở" là UI state chứ không nằm trong URL.

14 ảnh: `projects`, `claude`, `commands`, `diff`, `workflows`, `workflow-run`, `agents`, `knowledge`,
`memory`, `env`, `settings`, `github`, `github-pr`, `jira` — resize về 1440px, tổng ~5.3MB.
`terminals.png` bị xoá (đã thay bằng `claude.png`). README thêm section riêng cho Knowledge, Memory,
GitHub, Jira, Settings thay vì để chung trong bảng "And the rest".

**Còn thiếu**: ảnh agent `jira-ai-fixer` *đang chạy*. Không tự bật vì `start.sh` của bundle này dựng
webhook server **+ ngrok tunnel** và sẽ tự fix bug Jira có label AI-Fix — side effect ra ngoài, cần
người dùng quyết.

### Ảnh agent đang chạy (đã có, người dùng đồng ý bật)

`jira-ai-fixer` được bật để chụp rồi tắt: `POST /api/projects/:id/sessions {agentName}` → mở tab
`agent:<sessionId>`, `POST /api/agents/:id/start` → chạy `start.sh`. Sau khi chụp: `DELETE
/api/terminals/:id` + archive session. **Tunnel/ngrok không bị chạm** — nó đã chạy sẵn trước đó và
`ensure-tunnel.sh` cố ý cho tunnel sống độc lập với agent.

Terminal của agent in **ngrok URL kèm webhook token** và email assignee → đã che (vẽ đè bằng màu nền
terminal) trước khi đưa vào `docs/images/agent-run.png`. README nói rõ là ảnh có redact. Bất kỳ lần
chụp lại nào cũng phải che lại chỗ đó: webhook đó public, ai có URL+token là POST được.
