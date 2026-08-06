# Nút "Locate in Project files" trên Diff tab

## Mục tiêu

Khi đang mở một file (diff của change, hoặc file thường) ở pane bên phải tab Diff, có nút định vị file đó trong cây PROJECT FILES: tự chuyển bottom view sang "files", expand các thư mục cha, scroll tới và highlight file.

## Các bước

1. `web/src/features/git/FileTree.tsx`
   - Thêm prop `reveal?: { path: string; nonce: number } | null`.
   - Khi `reveal` đổi (theo nonce): thêm toàn bộ thư mục cha của `reveal.path` vào set `open`, rồi scroll nút file tương ứng vào giữa khung nhìn (ref + `scrollIntoView`).
2. `web/src/features/git/DiffTab.tsx`
   - State `reveal` + nonce tăng dần (bấm lại vẫn scroll dù cùng file).
   - Nút icon (LocateFixed) trong header pane phải — hiện khi selection là `change` hoặc `file`: set `bottomView = "files"` + set `reveal`.
   - Truyền `selected={fileSelected ?? changeSelected}` cho FileTree để file đang mở dạng change cũng được highlight trong cây.

## File chạm

- `web/src/features/git/FileTree.tsx`
- `web/src/features/git/DiffTab.tsx`

## Điều chỉnh sau review

- Click file trong cây PROJECT FILES luôn mở **preview** (`type: "file"`), kể cả file đang có change — màn diff chỉ mở từ danh sách Changes. (Trước đó cây route file có change sang diff.)

## Edge case

- File bị xoá (status `D`) không còn trong cây → chỉ expand được thư mục cha, không scroll (không lỗi).
- Bấm nút nhiều lần cùng một file → nonce đảm bảo vẫn re-scroll.
- Cây đang ở tab HISTORY → nút tự chuyển về PROJECT FILES trước khi reveal.
