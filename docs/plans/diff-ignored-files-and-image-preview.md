# Diff tab: mở được file bị gitignore (`.env`) và xem được ảnh

## Context

Hai bug người dùng báo ở tab Diff:

1. **`.env` không đọc được.** Không phải lỗi đọc — file **không bao giờ xuất hiện** trong cây
   "Project files" nên không có gì để click. `listFiles` (`server/src/services/git.ts:262`) chạy
   `git ls-files -z --cached --others --exclude-standard`: `--exclude-standard` theo định nghĩa loại
   hết file bị ignore, nên `.env`, `.env.local`, `.DS_Store`… không có trong danh sách.
   Bản thân việc đọc thì đã hợp lệ: `assertPathAllowed` + `readTreeFile` không quan tâm git status,
   nên chỉ cần liệt kê ra là mở được.

2. **Ảnh/GIF không xem được.** `readTreeFile` (`git.ts:323`) thấy byte `0` trong 8KB đầu → trả
   `{ binary: true, content: "" }`, và `FileView` (`web/src/features/git/DiffTab.tsx:122`) in
   "Binary file — no preview." Ảnh luôn rơi vào nhánh này vì server không có đường nào trả bytes thô.

Mục tiêu: mở được file bị ignore, và ảnh thì render ra ảnh.

## Bước 1 — Liệt kê file bị ignore (`server/src/services/git.ts`)

`listFiles` thêm pass thứ hai:

```
git ls-files -z --others --ignored --exclude-standard --directory
```

- `--directory` là mấu chốt: thư mục bị ignore được **thu về một entry** (`node_modules/`, `.next/`,
  `.idea/`) thay vì bung ra hàng chục nghìn file — đó chính là lý do `--exclude-standard` tồn tại ngay
  từ đầu. Entry kết thúc bằng `/` bị **bỏ hẳn**: mở `node_modules/` không có giá trị gì, còn liệt kê
  bên trong nó thì làm sập cây.
- Kết quả trên repo FE-ReelMe-film-studio: đúng 6 file đáng quan tâm (`.DS_Store`,
  `film-studio-web/.env.local`, `next-env.d.ts`, `tsconfig.tsbuildinfo`, …) — không có flood.
- Dùng chung `cap = 30_000` với danh sách hiện tại.

Trả về thêm một mảng riêng để client phân biệt được:

```ts
{ files: string[]; ignored: string[]; truncated: boolean }
```

`files` giữ nguyên ý nghĩa cũ nên không có call site nào vỡ.

## Bước 2 — Cây file phân biệt file bị ignore (`web/src/features/git/FileTree.tsx`, `DiffTab.tsx`)

- `FileTree` nhận thêm prop `ignored?: Set<string>`; entry nào thuộc set thì mờ hơn
  (`text-ink-faint`) + `title="ignored by git"`, để không ai nghĩ file đó đang được track.
- Vẫn click/mở/sửa được như file thường (đọc–ghi đã hợp lệ sẵn).

## Bước 3 — Endpoint trả bytes thô (`server/src/routes/git.ts`)

`GET /api/projects/:id/git/file/raw?pathId=…&file=…`

- Cùng `resolveTree` + `assertPathAllowed` như endpoint text — không nới quyền.
- `Content-Type` suy từ đuôi file (png/jpg/jpeg/gif/webp/avif/bmp/ico/svg), còn lại
  `application/octet-stream`; `Content-Length`, `Cache-Control: no-store` (file trên đĩa đổi liên tục).
- Cap 25MB → quá thì 413, để một file dump 2GB không kéo cả server.
- Nhận `rev=worktree|head`: `head` đọc bytes qua `git show HEAD:<file>` (cần cho diff ảnh cũ → mới),
  file chưa có trong HEAD → 404 để client biết đây là ảnh mới thêm.

## Bước 4 — Preview ảnh ở client (`web/src/features/git/DiffTab.tsx`)

- Thêm helper `isImagePath(path)` cho đuôi png/jpg/jpeg/gif/webp/avif/bmp/ico.
- `FileView`: nếu `file.binary && isImagePath(path)` → `<img src={fileUrl(rawUrl)}>` căn giữa,
  `max-h-full max-w-full object-contain`, kèm dòng caption cỡ file. Binary khác giữ nguyên message cũ.
  Dùng `fileUrl()` (`web/src/lib/upload.ts:32`) vì nó append `?t=<token>` — `<img>` không gửi được
  header `x-cs-token`, và server đã nhận token qua query cho đúng lý do này.
- Chỗ xem một file đã chọn trong changelist cũng đi qua nhánh này, nên ảnh bị sửa cũng preview được.
- **Diff ảnh**: file trong changelist mà là ảnh thì thay khung patch bằng hai ảnh cạnh nhau,
  `HEAD` (rev=head) và `Working tree` (rev=worktree). Ảnh mới thêm → chỉ có cột phải; file bị xoá →
  chỉ có cột trái. Không cố diff pixel, chỉ đặt cạnh nhau — đó là thứ người review cần.
- `.svg` là text nên hiện đang render source; giữ nguyên, không thêm toggle Preview/Source (ngoài phạm vi).

## Verification

1. Tab Diff → Project files: `.env` / `.env.local` hiện ra (mờ), click mở thấy nội dung; `node_modules/`
   **không** xuất hiện.
2. Mở một `.png` và một `.gif` trong repo → thấy ảnh; mở một file binary không phải ảnh (ví dụ
   `.tsbuildinfo` nếu có NUL, hoặc một `.zip`) → vẫn là message cũ.
3. `curl` endpoint raw với `file=../../../etc/passwd` → 403 (guard cũ vẫn chặn).
4. `npm run check` (typecheck + eslint + vitest) sạch.
5. Sửa + save một file bị ignore → ghi được, `baseHash` guard vẫn hoạt động.

## Đã chốt với người dùng

- File bị ignore: **hiện luôn, làm mờ** (không toggle).
- Ảnh: preview khi chọn file **và** diff ảnh cũ → mới cạnh nhau trong changelist.

---

## Vòng 2 — tìm kiếm trong Diff + preview vector (SVG / Android XML)

Hai yêu cầu tiếp theo của người dùng.

### Bước 5 — Search: một ô, hai loại kết quả (`server/src/routes/git.ts`, `services/git.ts`)

Endpoint mới `GET /api/projects/:id/git/search?pathId=…&q=…&limit=…`, trả **cả hai** nhóm trong một
lần gọi vì người dùng gõ một từ khoá và không muốn phải chọn trước là tìm tên hay tìm nội dung:

```ts
{ files: string[];                                  // path chứa q (kể cả file bị ignore)
  matches: { path: string; line: number; text: string }[] }  // nội dung
```

- **Tên file**: lọc trên chính `listFiles()` (tracked + untracked + ignored) — không tốn process, và
  gõ `.png` là ra hết ảnh, gõ một phần tên file là ra file.
- **Nội dung**: `git grep -n -I -F -i --untracked -e <q>` trong repo.
  - `-I` bỏ file binary (không ai muốn thấy match trong .png), `-F` coi q là chuỗi thường chứ không
    phải regex (gõ `print(` không được nổ lỗi regex), `-i` không phân biệt hoa thường,
    `--untracked` để file mới thêm cũng được tìm.
  - `git grep` chỉ đi trong repo nên không lạc ra ngoài root — vẫn kèm `assertPathAllowed` cho cwd.
  - Cap `limit` (mặc định 200) + `-m` per-file để một file minified không chiếm hết kết quả.
  - Exit code 1 của grep = "không có match", không phải lỗi → phải bắt riêng.
- Query ngắn hơn 2 ký tự → trả rỗng, khỏi grep cả repo vì một chữ cái.

### Bước 6 — UI search (`web/src/features/git/DiffTab.tsx`)

- Ô input ngay trên khối "Project files", debounce 250ms, `Escape` để xoá.
- Có query → thay cây file bằng danh sách kết quả, hai nhóm có tiêu đề: **FILES** (click → mở file,
  ảnh thì ra preview ảnh luôn) và **MATCHES** (`path:line` + đoạn text, click → mở file đó).
- Không có query → cây file như cũ. Trạng thái rỗng: "No match for …".
- Query nằm trong UI state theo project+path như mọi lựa chọn khác, nên rời tab rồi quay lại vẫn còn.
- *Chưa làm*: cuộn đến đúng dòng khi click một match (cần API scroll của CodeMirror) — mở file là đủ
  cho vòng này.

### Bước 7 — Preview vector

- **`.svg`**: là text nên đang hiện source. Thêm cặp nút **Preview / Source**; mặc định Preview,
  render bằng `<img src={rawSrc(...)}>`. Dùng `<img>` chứ không inline SVG: file trong repo là dữ liệu
  không tin cậy, `<img>` thì script/`<foreignObject>` trong SVG không chạy được.
- **Android vector drawable** (`<vector android:…>` trong `res/drawable/*.xml`): browser không render
  được, nên convert best-effort sang SVG ở client rồi nhét vào `<img src="data:image/svg+xml,…">`:
  - `android:viewportWidth/Height` → `viewBox`, `android:width/height` (dp) → kích thước.
  - mỗi `<path android:pathData>` → `<path d>`, kèm `fillColor`/`strokeColor`/`strokeWidth`/
    `fillAlpha`/`strokeAlpha`/`fillType`(evenOdd → `fill-rule`).
  - `<group android:translateX/Y, scaleX/Y, rotation, pivotX/Y>` → `<g transform>`.
  - `@color/...` hoặc `?attr/...` không resolve được (nằm ở resource khác) → dùng `currentColor` và
    ghi chú trên preview, thay vì vẽ ra màu sai.
  - Không parse được → tự động về Source, không báo lỗi đỏ.
  - Parse bằng `DOMParser` có sẵn của browser; không thêm dependency.

### Verification (bổ sung)

6. Gõ `.png` vào ô search → nhóm FILES liệt kê ảnh; click một cái → hiện ảnh.
7. Gõ `print` → nhóm MATCHES có `path:line` + dòng code; click → mở đúng file.
8. Gõ `print(` → không nổ lỗi regex.
9. Mở một `.svg` → thấy hình, bấm Source → thấy XML.
10. Mở một Android vector drawable → thấy hình; file có `@color/` → hình vẽ bằng `currentColor` + ghi chú.
