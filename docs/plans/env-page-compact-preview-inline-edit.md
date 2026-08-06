# EnvPage — preview gọn 2 dòng + edit inline trong item

## Mục tiêu
Trang Environment sets (`web/src/pages/EnvPage.tsx`):
1. Preview vars của mỗi env set chỉ chiếm **tối đa 2 dòng** (clamp, phần thừa ẩn) thay vì dump toàn bộ vars làm card cao cả trang.
2. Bấm **Edit** thì item đó **xổ ra tại chỗ** thành form edit (inline expand), không render form ở dưới cùng của list nữa. Bấm **New set** thì form hiện thành card ở đầu list.

## Phạm vi
Chỉ `web/src/pages/EnvPage.tsx`. Không đổi API, không đổi shared types, không đổi component UI chung.

## Các bước
1. **Preview clamp 2 dòng**: đổi container preview vars từ `flex flex-wrap` sang block + `line-clamp-2`, spans thành `inline` với `mr-3`. Giữ mask secret `••••••`; bỏ nút eye reveal trong preview (giá trị đầy đủ xem được khi Edit) — eye button bên trong line-clamp bị cắt nửa chừng, không dùng được tử tế.
2. **Tách form edit** thành biến JSX `editorBody` (dùng chung state hiện có: name/description/projectId/vars).
3. **Render inline**:
   - `editing === "new"` → `<Card>` chứa `editorBody` ở **đầu** list (ngay dưới header).
   - `editing === set.id` → thay card preview của set đó bằng `<Card>` chứa `editorBody` (item xổ to ra tại chỗ).
   - Xoá block `{editing && <Card className="mt-5">…}` ở cuối trang.
4. State `revealed` không còn dùng → xoá luôn cùng import Eye/EyeOff.

## Edge cases
- Set không có description: preview vẫn clamp đúng 2 dòng.
- Đang edit set A mà bấm Edit set B: form nhảy sang B (giữ hành vi cũ — state form load lại từ B).
- Cancel/Save → card thu về dạng preview.

## Cần confirm
- Bỏ eye-reveal trong preview (vẫn xem full value khi Edit) — nếu muốn giữ reveal ngoài preview thì báo lại, sẽ thêm nút "show all" riêng.
