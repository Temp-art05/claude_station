# Sửa file ngay trong tab Diff (CodeMirror 6)

## Mục tiêu

Khung phải của tab Diff hiện chỉ đọc (`FileView` trong `DiffTab.tsx`). Muốn sửa một
dòng phải mở IDE. Thêm chế độ Edit vào **khung xem file** (selection `type: "file"`,
mở từ Project files), dùng CodeMirror 6.

Đã chốt: CodeMirror 6 (có syntax highlight), và **chỉ** khung xem file — không sửa
trực tiếp trên cột phải của side-by-side diff (phải map dòng diff ↔ dòng file thật,
dễ ghi sai chỗ). Từ một diff đang chọn sẽ có nút **Edit** để nhảy sang khung sửa của
đúng file đó.

## Rủi ro chính: file bị ghi bởi thứ khác trong lúc đang sửa

Đây là điểm khác biệt của Station so với một editor thường: **agent Claude đang chạy
cũng ghi vào chính những file này**, và tab Diff giờ có watcher nên mọi lần ghi đều
refetch. Nếu làm hồn nhiên thì sẽ có hai kiểu mất dữ liệu:

1. Query `git-file` trả nội dung mới → ghi đè buffer đang gõ.
2. Bấm Save → ghi đè nội dung agent vừa viết, không ai biết.

Nên cơ chế chống ghi đè là phần bắt buộc, không phải tuỳ chọn:

- `GET …/git/file` trả thêm `hash` (sha256 nội dung lúc đọc).
- `PUT …/git/file` gửi kèm `baseHash`. Server đọc lại file, hash khác → **409**,
  không ghi gì. Trả về hash hiện tại để client xử lý.
- Client: buffer chỉ được seed lại khi **không dirty**. Đang dirty mà hash trên đĩa
  đổi → hiện banner "file đã đổi trên đĩa" kèm 2 lựa chọn rõ ràng: *Reload* (mất
  thay đổi của bạn) hoặc *Overwrite* (ghi đè, gửi lại với hash mới).

## Sửa đổi sau khi dùng thử: bỏ nút Edit, khung xem file **luôn** là editor

Bấm Edit mỗi lần muốn sửa một dòng là thừa. Khung xem file (selection `type: "file"`)
giờ **luôn** ở chế độ sửa được; chỉ còn **Save** hiện ra khi có thay đổi chưa lưu.

Vẫn read-only ở: khung diff (`type: "change"`), khung commit (`type: "commit"`),
file binary và file bị cắt ở 1 MB (những chỗ này dùng lại `FileView` cũ). `.md` giữ
toggle Preview/Source như cũ — Preview là bản render read-only, Source là editor.

Hệ quả về state (chỗ dễ sai nhất khi bỏ nút Edit):

- Buffer chỉ tồn tại **khi đang dirty**; sạch thì hiển thị thẳng nội dung từ query,
  nên thay đổi từ đĩa tự vào editor mà không cần logic reseed riêng.
- Buffer là **map theo path**, không phải một buffer duy nhất: sửa file A rồi nhảy
  sang sửa file B mà chỉ có một buffer thì thay đổi ở A bị mất im lặng.
- Lưu xong **ghi thẳng kết quả vào cache của query** (`setQueryData`) thay vì chờ
  refetch. Không làm thế thì trong khoảng chờ, query vẫn trả nội dung cũ với hash cũ
  — trông y như "có người khác vừa ghi file" — và editor sẽ nháy về bản cũ.
- Header hiện thêm "N unsaved" khi còn file khác đang dirty, để đừng đóng tab mất bài.

## Sửa đổi tiếp: autosave khi dừng gõ, **không có chrome nào**

Lưu sau **1.2s** không gõ thêm. Luôn bật, không toggle.

**Không hiện** Save / "• unsaved" / "saved" / Discard / chip auto. Chúng xuất hiện
rồi biến mất theo từng nhịp gõ nên header nhảy qua nhảy lại — vừa giật vừa vô ích khi
lưu đã là tự động. ⌘S giữ lại vì nó không chiếm pixel nào.

Thứ duy nhất còn được phép cắt ngang là **banner conflict**, vì nó là cái chặn mất
dữ liệu khi agent ghi cùng file — và nó chỉ hiện đúng lúc conflict, không phải lúc gõ.

Hệ quả: bỏ chỉ báo "N unsaved elsewhere" thì phải **flush buffer khi đổi file**, nếu
không rời file trong vòng 1.2s sau lần gõ cuối sẽ mất thay đổi mà không có gì báo.
Buffer đang conflict thì không flush — nó chỉ 409 lần nữa, và banner vẫn chờ ở đó khi
quay lại.

**Bẫy chính — vòng lặp 409.** Autosave gặp conflict sẽ tự thử lại mỗi 1.2s, mỗi lần
một lỗi, banner không bao giờ kịp xuất hiện đúng. Lý do là `conflicted` được suy từ
`fileContent.hash ≠ baseHash`, mà ngay sau 409 thì query **chưa** refetch nên hash
còn khớp → autosave lại chạy. Nên:

- 409 → ghi path vào `conflictPaths` và **chặn autosave cho path đó**, đồng thời
  invalidate `git-file` để bản trên đĩa về cho nút Reload.
- Banner conflict hiện khi `dirty && (hash lệch || path bị chặn)`.
- Chỉ Reload (bỏ buffer) hoặc Overwrite (lưu thành công) mới xoá chặn.

Ngoài ra: không autosave khi đang có save chạy dở, và **autosave không hiện toast**
"Saved …" — 1.2s một toast trong lúc gõ là nhiễu; chỉ ⌘S/nút Save mới báo.

## Phạm vi

- Khung xem file luôn sửa được; autosave 1.2s + ⌘S/Save + Discard khi dirty.
- Chỉ file text đang tồn tại. Không tạo file mới, không sửa binary, không sửa
  file > 1 MB (đúng trần `FILE_CAP` mà `readTreeFile` đang dùng).
- `.md` đang có toggle Preview/Source — vào Edit thì hiển thị source.

**Ngoài phạm vi:** sửa trong diff, tạo/đổi tên/di chuyển file, multi-file save,
sửa file ở commit đã qua (khung commit vẫn read-only).

## Thiết kế

### Dependency + bundle

Bundle hiện đã 1.2 MB và vite đang cảnh báo, nên CodeMirror **phải** nằm ngoài chunk
đầu: component editor load bằng `React.lazy` + `import()`, chỉ tải khi bấm Edit lần
đầu. Ai không sửa file thì không tải gì thêm.

Package: `codemirror` (gói state/view/commands/search/autocomplete + `basicSetup`),
`@codemirror/theme-one-dark`, và language pack chọn theo repo mà Station thực sự
đang phục vụ:

| Pack | Cho |
|---|---|
| `@codemirror/lang-javascript` | js, jsx, ts, tsx |
| `@codemirror/lang-json` | json |
| `@codemirror/lang-markdown` | md |
| `@codemirror/lang-css`, `-html`, `-xml`, `-yaml` | web + config + AndroidManifest/layout |
| `@codemirror/lang-python` | py |
| `@codemirror/lang-java` | java, gradle (đủ gần) |
| `@codemirror/legacy-modes` | kotlin, swift, objc (`mode/clike`), sh (`mode/shell`) |

Không có pack → vẫn sửa được, chỉ là không highlight. Đó là hành vi mong muốn, không
phải lỗi.

### Server

`services/git.ts`:

- `readTreeFile()` trả thêm `hash: string` (sha256 hex của buffer; `""` khi binary).
- `writeTreeFile(cwd, file, content, baseHash)`:
  - `assertPathAllowed` ở route như mọi endpoint file khác.
  - Phải là file đang tồn tại, không phải thư mục, không binary.
  - `content` ≤ `FILE_CAP`.
  - Hash hiện tại ≠ `baseHash` → `409` (dùng `conflict()` mới, cùng khuôn `badRequest`).
  - Ghi **temp + rename** trong cùng thư mục: process chết giữa lúc ghi thì file cũ
    còn nguyên, thay vì còn một nửa. Đây không phải sự cẩn thận thừa — file này là
    source code người dùng.
  - Trả `{ hash }` mới để client sửa tiếp không phải reload.

`routes/git.ts`: `PUT /api/projects/:id/git/file`, ghi `work_history` kind
`git_file_edited`.

### Client

`features/git/FileEditor.tsx` (mới, được lazy-load):

- Khởi tạo `EditorView` một lần cho mỗi (path, hash lúc mở); `onChange` báo dirty +
  nội dung ra ngoài.
- `Prec.highest` keymap cho `Mod-s` → gọi save, `preventDefault` để không kích hoạt
  "Save page" của trình duyệt.
- Theme one-dark; `EditorView.lineWrapping` để dòng dài không tràn ngang.

`DiffTab.tsx`:

- State: `editing` (bool), `buffer` (string | null), `baseHash`.
- Header khung file thêm: **Edit** (khi read-only) → **Save** + **Cancel** (khi đang
  sửa), kèm dấu • khi dirty.
- Diff đang chọn: thêm nút **Edit** → `setSelected({ type: "file", path })` rồi bật
  editing.
- Cancel khi dirty → `confirm()`.
- Save xong: cập nhật `baseHash`, thoát dirty, `refreshAll()` (diff/status đổi theo).
- 409 → banner conflict như mô tả ở trên.

## File dự kiến chạm

| File | Việc |
|---|---|
| `web/package.json` | thêm codemirror + lang packs |
| `web/src/features/git/FileEditor.tsx` | mới, lazy |
| `web/src/features/git/DiffTab.tsx` | Edit/Save/Cancel, dirty, conflict banner |
| `server/src/services/git.ts` | `hash` trong `readTreeFile`, `writeTreeFile` |
| `server/src/routes/git.ts` | `PUT …/git/file` |
| `server/src/lib/path-safety.ts` | thêm `conflict()` (409) |
| `docs/plans/diff-file-editing.md` | chính file này |

## Edge case đã tính

- **Agent ghi file lúc đang sửa** → banner + 409, không ghi đè im lặng.
- **Watcher refetch liên tục** → chỉ seed lại buffer khi không dirty.
- **File bị xoá lúc đang sửa** → Save trả 400 "not a file"; hiện lỗi, không tạo lại.
- **Binary / > 1 MB** → nút Edit không hiện (đã có `binary`/`truncated` từ server).
  Cho sửa file đã truncate sẽ **mất phần đuôi bị cắt** — nên chặn hẳn.
- **CRLF / không có newline cuối** → gửi nguyên xi những gì editor giữ, không tự
  thêm/bớt newline, để diff không phình ra vì thay đổi vô hình.
- **Chunk CodeMirror tải lỗi** (mạng rớt) → `Suspense` fallback báo lỗi, khung vẫn
  về read-only chứ không trắng.
- **Sửa file ngoài git repo** (Station cho phép path không phải repo) → vẫn ghi được;
  chỉ là không có diff để xem.

## Cần confirm

Không còn — editor (CodeMirror 6) và phạm vi (chỉ khung xem file) đã chốt.

## Đã impl + verify

Chạy thật qua API trên server đang sống:

**Ghi file**
- `GET file` trả `hash`; `PUT` với hash đúng → 200 + hash mới, nội dung trên đĩa
  khớp từng ký tự.
- **Không tự thêm newline cuối**: file gốc không có `\n` cuối → sau khi lưu vẫn không có.
- Watcher bắn event sau khi lưu (diff/status tự cập nhật theo).

**Chống ghi đè (phần quan trọng nhất)**
- `PUT` với hash **cũ** → **409** và **file không bị đụng** (so lại nội dung y nguyên).
- Hash là của **cả file**, không phải phần 1 MB bị cắt: file 1.5 MB chỉ khác nhau ở
  phần đuôi ngoài 1 MB → hash **vẫn đổi**. Nếu hash chỉ tính phần cắt thì guard này
  sẽ mù đúng vào trường hợp nguy hiểm nhất.

**Từ chối đúng chỗ**
- Binary: `GET` trả `binary:true` + `hash:""`; `PUT` → 400 "Refusing to edit a binary file".
- File > 1 MB → 400, file giữ nguyên kích thước (không bị cắt còn 1 MB).
- File không tồn tại → 400 "Not a file".
- Không sót file tạm `.station-tmp-*` nào sau tất cả các case.

**Luồng mới (không có nút Edit)** — mô phỏng đúng chuỗi thao tác UI:
- Mở file → gõ → ⌘S ngay: 200.
- Gõ tiếp → ⌘S lần 2 với hash vừa được trả về: 200, tức **sửa liên tục không cần reload**.
- Agent ghi file trong lúc đang gõ → save **409**, **nội dung của agent còn nguyên**.
- Bấm Overwrite (gửi lại với hash hiện tại trên đĩa) → 200, đĩa nhận bản của người dùng.

**Bug đã sửa: autosave làm editor nhảy về đầu file**

Nguyên nhân: editor được `key` theo `${path}:${hash}`. Autosave xong thì hash đổi →
**React remount cả editor** → mất scroll và mất cả vị trí con trỏ.

Sửa: `key` chỉ theo **path**. Nội dung mới không còn remount nữa mà được **đẩy vào
view bằng transaction**, và chỉ đẩy khi nội dung thực sự khác. Hai lớp chặn, cần cả hai:

- `doc === emitted` — chính string mình vừa emit quay lại qua state của parent.
  Parent giữ đúng object đó nên so sánh này là reference-equal, O(1), không phải
  đọc lại cả document mỗi lần gõ.
- `current !== doc` — refetch sau khi lưu trả **string mới** cùng nội dung, nên chỉ
  so identity là chưa đủ. Lớp này chỉ chạy khi refetch, không chạy mỗi keystroke.

Tách ra `shouldPushDoc` trong `autosave.ts` để test được: **5/5 case đúng**, gồm
"refetch trả string mới cùng nội dung → không đẩy" (chính ca gây nhảy scroll) và
"agent ghi file thật → phải đẩy".

**Autosave**
- Quy tắc bật/tắt timer tách ra `features/git/autosave.ts` (`shouldAutosave`) đúng vì
  luật chặn 409 là chỗ dễ vỡ nhất — thành hàm thuần thì test được thật. **6/6 case
  đúng**, gồm "conflict + vẫn gõ tiếp → vẫn ngưng" (đây là ca sinh vòng lặp nếu sai).
- Autosave hoàn toàn im lặng: không toast, không chỉ báo trạng thái. Chỉ khi **lỗi**
  mới hiện notice.
- Header khung file giờ chỉ còn: đường dẫn, nút Locate, toggle Preview/Source cho
  `.md`, và nhãn read-only cho binary/truncated. Không có gì xuất hiện/biến mất theo
  nhịp gõ nữa.

**Bundle**
- CodeMirror ra chunk riêng `FileEditor-*.js` 762 kB (gzip 270 kB), chỉ tải khi mở
  một file text. Chunk chính 1196 → **1202 kB**, tức +6 kB cho người chỉ xem diff.
- `tsc` sạch cả 2 package, `eslint` sạch, `vite build` OK.

**Giới hạn đã biết:** autosave chỉ chạy cho file **đang mở**. Rời sang file khác
trong vòng 1.2s sau lần gõ cuối thì buffer cũ còn dirty — header hiện
"N unsaved elsewhere" để không mất bài; quay lại file đó sẽ thấy nguyên buffer.
