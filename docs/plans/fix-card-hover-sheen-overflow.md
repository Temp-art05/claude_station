# Fix: hover trên project card làm tràn sheen ra ngoài + hiện scrollbar ngang

## Context

Khi hover vào một project card ở `/projects`, người dùng thấy:

1. Một vệt sáng ("splash") xuất hiện ở **vùng bên phải màn hình**, ngoài card.
2. **Thanh scroll ngang** hiện ra ở đáy trang, làm cảm giác "view to hơn" (trang rộng ra, kéo ngang được).

### Nguyên nhân gốc

`@utility liquid-interactive` trong `web/src/index.css:449` tạo hiệu ứng sheen bằng một pseudo-element:

```css
&::after {
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 32%, rgb(255 255 255 / 7%) 48%, transparent 64%);
  transform: translateX(-130%);   /* nghỉ: nằm bên trái card */
}
&:hover::after {
  transform: translateX(130%);    /* hover: chạy sang phải card */
}
```

Card (`liquid`) có `position: relative` nhưng **không có `overflow: hidden`**, nên khi `::after` dịch 130% chiều rộng card:

- Nó **vẫn được vẽ** ra ngoài biên card → chính là vệt sáng ở mép phải màn hình trong ảnh chụp (card `iip555-reelme-ios` rộng ~480px, dịch +624px → dải gradient rơi vào x ≈ 1662–1816px, tràn khỏi viewport).
- Phần tử absolute này **tính vào scrollable overflow** của tài liệu → trình duyệt sinh thanh scroll ngang. Không có `hover:scale` nào trong code (đã grep toàn repo) — cảm giác "view to hơn" chính là do vùng scroll ngang mới sinh ra này.

Bug ảnh hưởng **mọi** chỗ dùng `liquid-interactive`, không riêng Projects: `web/src/features/workflows/WorkflowsTab.tsx:156`, `web/src/features/agents/AgentsTab.tsx:66`, và `Card interactive` (`web/src/components/ui/card.tsx:18`).

## Mục tiêu

Giữ nguyên hiệu ứng sheen quét ngang như hiện tại, nhưng sheen **không bao giờ vẽ hoặc chiếm chỗ ra ngoài biên card** → hết vệt sáng lạc và hết scrollbar ngang.

## Phạm vi

Chỉ sửa CSS trong `web/src/index.css`. Không đụng component, không đổi markup, không đổi API của `Card`.

## Cách làm

Thay vì `transform: translateX()` trên một lớp phủ full-size (thứ gây tràn), **animate `background-position`** của cùng gradient đó trên một `::after` đứng yên `inset: 0`. Background không bao giờ vẽ ra ngoài padding/border box của phần tử và không đóng góp vào scroll overflow → triệt tận gốc cả hai triệu chứng, mà chuyển động nhìn y hệt.

### Các bước

1. **`web/src/index.css` — `@utility liquid-interactive` (~dòng 449–487)**
   - Đổi `background` shorthand của `::after` thành `background-image` + `background-repeat: no-repeat` + `background-size: 240% 100%`.
   - Trạng thái nghỉ: `background-position: 100% 0` (dải sáng nằm ngoài mép trái khung nhìn của card).
   - `:hover::after`: `background-position: 0 0` (dải sáng quét sang phải rồi ra khỏi mép phải).
   - Bỏ `transform: translateX(...)` khỏi `::after` và khỏi `:hover::after`.
   - Đổi `transition` của `::after`: `transform` → `background-position` (giữ nguyên `var(--dur-long) var(--ease-emphasized-decel)` và transition `opacity`).
   - Giữ nguyên `transform` ở `&:active { transform: scale(0.985) }` — cái này nằm trên chính card, không tràn.
   - Cập nhật comment mô tả kỹ thuật cho khớp (comment ở dòng 448 và block comment 363–371 nói "hover sheen").

2. **`web/src/index.css` — block `prefers-reduced-motion` (~dòng 641)**
   - Giữ nguyên `.liquid-interactive::after { display: none }` — vẫn đúng.

3. **Chốt chặn phòng thủ (khuyến nghị làm luôn, 1 dòng)**
   - Thêm `overflow: clip;` vào `@utility liquid-interactive`. `clip` (khác `hidden`) không tạo scroll container, không ảnh hưởng `position: sticky`/focus scrolling bên trong, chỉ cắt phần vẽ tràn. Đây là lưới an toàn cho bất kỳ trang trí nào thêm vào sau này.
   - Lưu ý kiểm tra: `liquid-interactive` hiện chỉ dùng cho card/row/chip **không** chứa popover hay tooltip nào tràn ra ngoài (đã kiểm tra 3 call-site ở trên) → an toàn.

### Vì sao `background-size: 240%`

Với `background-position` theo phần trăm, `0%` căn mép trái ảnh với mép trái card, `100%` căn mép phải ảnh với mép phải card. Ảnh rộng 240% card, dải sáng nằm ở 48% chiều rộng ảnh:

- `100% 0` → tâm dải ở ≈ −25% chiều rộng card (ngoài mép trái).
- `0 0` → tâm dải ở ≈ 115% chiều rộng card (ngoài mép phải).

Nên `100% → 0` cho đúng chuyển động trái-sang-phải như bản `translateX(-130% → 130%)` hiện tại.

## Edge case đã cân nhắc

- **Border radius**: `background-clip` mặc định là `border-box`; `::after` có `border-radius: inherit` nên vẫn bo góc đúng, không lộ góc vuông.
- **`z-index: -1` + `isolation: isolate`**: không đổi, sheen vẫn nằm dưới chữ.
- **Chip bo tròn ở `AgentsTab.tsx:66`** (`rounded-pill`, cao ~36px): gradient theo phần trăm nên tự co giãn theo mọi kích thước, không cần trị số riêng.
- **`prefers-reduced-motion`**: `transition-duration: 0.001ms !important` + `display: none` cho `::after` → sheen tắt hẳn, không đổi hành vi.
- **Không đụng `liquid`/`liquid-raised`/`liquid-flat`**: `::before` của chúng là `inset: 0` không transform, vốn không tràn.

## File dự kiến chạm

- `web/src/index.css` (duy nhất)
- `docs/plans/fix-card-hover-sheen-overflow.md` — lưu bản plan này vào repo theo rule của project

## Verification

1. `npm run dev` (hoặc lệnh dev của repo), mở `http://claude.station/projects`.
2. Hover từng card ở **cột phải** — nơi bug lộ rõ nhất:
   - Không còn vệt sáng nào xuất hiện ngoài biên card.
   - Không còn thanh scroll ngang ở đáy trang.
   - Kiểm tra bằng console: `document.documentElement.scrollWidth === document.documentElement.clientWidth` phải là `true` cả khi đang hover.
3. Xác nhận sheen **vẫn quét** từ trái sang phải bên trong card khi hover (hiệu ứng không bị mất).
4. Kiểm tra hồi quy 2 call-site còn lại: danh sách workflow (`WorkflowsTab`) và chip agent (`AgentsTab`) — sheen vẫn chạy, không tràn.
5. `npm run lint` / typecheck của repo để chắc không vỡ gì.

## Đã chốt

- Có thêm `overflow: clip` (bước 3) làm lưới an toàn — đã impl.
