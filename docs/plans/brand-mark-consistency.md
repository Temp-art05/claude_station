# Đồng bộ brand mark: favicon và ô logo sidebar

## Context

Mark `>_` xuất hiện ở tab trình duyệt, chip bookmark và ô brand trong sidebar, nhưng trông không giống nhau. Trong code chỉ có **2 bản vẽ**:

- `web/public/favicon.svg`
- `web/src/components/AppShell.tsx:79-81`

Màu và glyph **đã khớp** (Material Symbols Rounded `terminal` filled, `--color-primary #3fd898` trên `--color-on-primary #05261a`, `index.css:26-27`). Lệch nằm ở hình học:

| | favicon.svg | ô sidebar |
|---|---|---|
| Bo góc | `rx="8"` / 32px → **25%** cạnh | `rounded-lg` 16px / `size-10` 40px → **40%** cạnh |
| Ink glyph so với ô | ~20px / 32px → **~62%** | `size={20}` → ink ~16.7px / 40px → **~42%** |

Nên favicon đọc ra "ô vuông, chữ to chiếm hết", sidebar đọc ra "ô tròn, chữ nhỏ lọt thỏm" — cùng một mark mà ra hai cảm giác.

**Hướng đã chốt với người dùng: gặp nhau ở giữa.** Không kéo hẳn về một phía vì có đánh đổi thật: glyph tỉ lệ 42% kiểu sidebar khi thu về 16px ở tab chỉ còn ink ~6.7px, nhoè thành một vệt.

Kết quả nhắm tới: bo góc **40% cạnh ở cả hai**, ink glyph **~55% (favicon)** và **~50% (sidebar)** — đủ gần để mắt đọc là một mark, mà favicon vẫn rõ ở 16px.

## Phạm vi

2 file. Không đổi màu, không đổi glyph, không đổi token, không đụng icon nào khác (pill "Projects" dùng `space_dashboard` — khác có chủ ý, giữ nguyên).

## Cách làm

### 1. `web/src/components/AppShell.tsx:80`

`<TerminalSquare size={20} fill={1} />` → `size={24}`.

Ô giữ nguyên `size-10 rounded-lg bg-primary text-on-primary shadow-e2`. Em box 24px trong ô 40px → ink `24 × 800/960 = 20px` → **50%** ô.

### 2. `web/public/favicon.svg`

- `rect`: `rx="8"` → `rx="13"` (32 × 0.4 = 12.8 → 13, khớp 40% của `rounded-lg`).
- `g`: `transform="translate(4 28) scale(0.025)"` → `transform="translate(5.5 26.5) scale(0.021875)"`.

  Em box `0.021875 × 960 = 21px`; ink rộng `21 × 800/960 = 17.5px` → **54.7%** ô 32px.

  Căn tâm: path `terminal` chiếm x `80..880`, y `-800..-160` trên lưới 960. Với scale `s`, tâm nằm ở `480s + tx` và `-480s + ty`, nên `tx = 16 - 480s = 5.5`, `ty = 16 + 480s = 26.5`. (Công thức này tái tạo đúng `translate(4 28)` của bản `scale(0.025)` hiện tại — đã kiểm chứng ngược.)

- **Sửa comment trong file.** Comment hiện viết "The sidebar logo mark, exactly" — sau thay đổi này thì không còn "exactly" nữa, và đó là chủ ý. Viết lại cho đúng: cùng glyph, cùng màu, cùng tỉ lệ bo góc; glyph để to hơn sidebar một nhịp vì favicon bị trình duyệt thu về 16px. Nói rõ luôn nguồn `@material-symbols/svg-400/rounded/terminal-fill.svg` và công thức căn tâm ở trên để lần sau ai đổi scale còn biết dịch translate theo.

### 3. Phát sinh khi impl: `favicon.svg` không parse được như XML

Comment trong file (cả bản trên `main`) chứa `--color-primary` — XML **cấm** `--` bên trong comment, nên file không phải XML hợp lệ (`rsvg-convert` và `xml.dom.minidom` đều từ chối). Trình duyệt hiện vẫn vẽ ra icon, nhiều khả năng nhờ chế độ recovery của libxml2, nhưng đây là chỗ dựa không nên có: parser nghiêm hơn một chút là tab rơi về quả địa cầu trắng.

→ Viết lại comment không còn `--` nào (gọi token là "primary / on-primary tokens from index.css", viết công thức bằng chữ "minus/plus"), và thêm một dòng cảnh báo ngay trong comment để lần sau không tái phạm.

### 4. Vòng 2 — favicon chỉ còn `>_`, bỏ khung cửa sổ

Sau khi đồng bộ, người dùng vẫn thấy icon ở tab **quá bé**: ở 16px thì khung cửa sổ chiếm hết chỗ, `>_` bên trong chỉ còn ~7px và nhoè thành một vệt. Chốt hướng: **favicon bỏ khung cửa sổ, giữ ô bo góc xanh, vẽ mỗi `>_` thật to**; **sidebar giữ nguyên** glyph terminal đầy đủ (ở 40px khung vẫn đọc tốt và đó là mark đầy đủ hơn).

Đây là **chỗ lệch có chủ ý** so với mục tiêu "hai bên giống hệt" ở phần trên — đổi lấy tính đọc được ở 16px. Comment trong `favicon.svg` phải nói rõ điều này.

Cách làm: path `terminal` gồm 4 subpath — khung ngoài, khung trong, chevron `>`, gạch dưới `_`. Bỏ 2 subpath khung, giữ chevron + gạch dưới. Subpath chevron bắt đầu bằng `m221-218` **tương đối** so với điểm cuối của subpath khung trong `(140, -220)`, nên khi bỏ khung phải đổi thành tuyệt đối `M361-438`; subpath gạch dưới vẫn tương đối so với điểm đầu của chevron nên giữ nguyên.

Bbox ink còn lại: x `269.4..710`, y `-572..-288` → rộng 440.6, cao 284, tâm `(489.7, -430)`. Với `scale(0.048)`: ink rộng 21.2px trên ô 32px (**66%**), căn tâm bằng `translate(16 - 489.7s, 16 + 430s)`.

## Edge case đã cân nhắc

- **`MIN_PX = 16` trong `web/src/components/ui/icon.tsx:20`**: sàn dưới, `size={24}` không bị chạm.
- **Nút `size-10` không đổi** → không có gì trong sidebar bị đẩy layout; chỉ glyph bên trong to lên 4px, ô `grid place-items-center` tự căn lại.
- **`fill={1}`** giữ nguyên để khớp asset `terminal-fill` mà favicon vẽ.
- **Không có manifest / apple-touch-icon** trong repo (đã grep) → chỉ 1 file favicon cần sửa.
- **`web/dist/`** là build artifact, gitignore — không cần đụng.

## File dự kiến chạm

- `web/src/components/AppShell.tsx`
- `web/public/favicon.svg`
- `docs/plans/brand-mark-consistency.md` — lưu plan này vào repo theo rule của project

## Nhánh

Nhánh hiện tại `fix/card-hover-sheen-overflow` đang có PR #11 chờ merge và là chuyện khác hẳn. Tách nhánh mới `fix/brand-mark-consistency` từ `main`. Chưa mở PR — hỏi người dùng sau khi code xong.

## Verification

1. `npm run build` — pass, và favicon được copy nguyên vào `web/dist/`.
2. `npm run dev`, mở `http://claude.station`:
   - So mark ở tab trình duyệt với ô sidebar: cùng độ bo góc, chữ `>_` cùng độ "đầy" trong ô.
   - Hard-refresh (Cmd+Shift+R) vì favicon bị cache rất dai; nếu vẫn cũ thì mở thẳng `http://claude.station/favicon.svg`.
   - Kiểm tra glyph trong favicon còn căn giữa: mở file SVG, mark không được lệch lên/xuống/trái/phải.
3. Ở 16px (tab + bookmark) chữ `>_` vẫn phải đọc ra là terminal, không thành vệt mờ.
4. `npm run lint`.
