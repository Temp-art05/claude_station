# Tab Diff: realtime + Unversioned Files + changelist + pane kéo được

## Mục tiêu

Hai vấn đề người dùng nêu ở tab Diff:

1. **Không realtime** — phải F5 lại web mới thấy thay đổi.
2. **Thiếu nhóm Unversioned Files** — file chưa add vào git nằm lẫn trong list, không
   có nút Add từng file / Add hết, không tạo được changelist để kéo file vào như
   Android Studio, và các pane nhỏ không kéo giãn được.
3. **Thiếu ô tick all** — phải tick/bỏ tick từng file một.

## Hiện trạng (đã đọc code, không suy đoán)

`web/src/features/git/DiffTab.tsx:150-223` có 6 query:

| Query | refetch |
|---|---|
| `git-status` | poll 5s, **chỉ khi panel active** (`refetchInterval: panelActive ? 5000 : false`) |
| `git-diff`, `git-tree`, `git-file`, `git-log`, `git-commit-files` | **không bao giờ** |

→ Danh sách file bên trái có nhúc nhích sau 5s, nhưng **nội dung diff bên phải đứng
im** cho tới khi F5. Đây chính là triệu chứng "phải F5".

File untracked **có** hiện: `status()` chạy `git status --porcelain -uall`
(`server/src/services/git.ts:55`), entry `??` nằm chung một list phẳng ở
`DiffTab.tsx:340`. Commit thì `git add -A -- <files>` (`git.ts:173`) nên untracked
được stage ngầm lúc commit.

**Git không có khái niệm changelist** — Android Studio tự lưu trong config IDE.
Station cũng phải tự lưu; đã chốt: SQLite.

## Phạm vi

Làm hết 1 lượt, 4 phần: realtime, Unversioned Files + Add, changelist + drag,
pane kéo được.

**Ngoài phạm vi:** không đụng BranchMenu, không đổi luồng commit/push hiện có,
không làm staging area đầy đủ kiểu `git add -p`.

## Thiết kế

### 1. Realtime — watcher + WebSocket

**Server** — `server/src/services/git-watch.ts` (mới):

- `watchRepo(cwd)` dùng `fs.watch(cwd, { recursive: true })` (macOS → FSEvents,
  không tốn 1 watcher/thư mục).
- **Lọc ồn** — đây là chỗ dễ chết nhất với repo Android:
  - Bỏ mọi path trong `.git/` **trừ** `.git/HEAD`, `.git/index`, `.git/refs/**`,
    `.git/MERGE_HEAD` (những thứ đổi khi checkout/commit/merge).
  - Bỏ theo tên thư mục: `node_modules`, `build`, `.gradle`, `.idea`, `dist`,
    `.next`, `DerivedData`, `Pods`.
  - Không dùng `git check-ignore` mỗi event (1 process/event → gục).
- **Debounce 400ms** rồi phát đúng **một** event `{ t: "changed" }`.
- Watcher đếm tham chiếu theo `cwd`: nhiều tab/khách cùng xem một repo dùng chung
  một watcher, đóng hết mới `close()`.
- `fs.watch` recursive có thể ném (giới hạn OS, path lạ) → bọc try/catch, thất bại
  thì chỉ log và để poll dự phòng gánh.

**WS** — `server/src/ws/git-ws.ts` (mới), theo đúng khuôn `command-ws.ts`:
`GET /ws/git/:projectId?pathId=…` → `assertWsAuthorized(req)` → attach watcher →
`socket.on("close", detach)`.

**Client** — `web/src/features/git/useGitWatch.ts` (mới): mở WS khi panel active,
nhận `changed` → `refreshAll()` (đã có sẵn `DiffTab.tsx:225`, đang invalidate đủ 5
query). Tự reconnect khi rớt.

Giữ poll làm lưới an toàn nhưng **hạ tần suất xuống 20s** — watcher là đường chính.

> Vì sao không chỉ hạ poll xuống 2s: `git status` trên repo Android to tốn cả giây,
> chạy mỗi 2s cho mỗi tab đang mở là lãng phí thật sự.

### 2. Nhóm Unversioned Files + Add

**Server** (`services/git.ts` + `routes/git.ts`):

- `status()` giữ nguyên (đã trả `??`).
- Thêm `addFiles(cwd, files)` → `git add -- <files>`, và route
  `POST /api/projects/:id/git/add` `{ pathId, files }`.
- Add xong không cần trả gì: watcher sẽ đẩy `changed`, client tự refresh.

**Client** (`DiffTab.tsx`): list phẳng → **các nhóm gập được**:

```
▾ Changes (3)                    ← status ≠ "??"
▾ Unversioned Files (12)  [Add all]
```

- Mỗi dòng untracked có nút **Add** (icon `FilePlus`) khi hover, giống nút Rollback
  hiện có; header nhóm có **Add all**.
**Tick all:** mỗi header nhóm có một checkbox master, và có một checkbox tổng ở
thanh "Changes" trên cùng:

- 3 trạng thái: tick hết / bỏ hết / **indeterminate** khi chỉ tick một phần
  (`ref.indeterminate = true`, HTML không có thuộc tính này để set trực tiếp).
- Bấm khi đang tick-hết → bỏ hết; các trường hợp còn lại (trống / một phần) → tick hết.
- Chỉ tác động lên **file đang hiển thị trong nhóm đó**, không đụng file ở nhóm
  khác — nếu không, ô tick tổng sẽ âm thầm bật lại những file bạn vừa bỏ ở nhóm kia.
- Cài đặt hiện lưu `unchecked` (mặc định mọi thứ đã tick, `DiffTab.tsx:132`) nên
  "tick hết" = xoá các path đó khỏi set, "bỏ hết" = thêm vào set.

- Checkbox và commit **giữ nguyên hành vi**: file untracked vẫn commit được thẳng
  mà không cần Add trước (vì `commit()` đã `git add -A -- <files>`). Add chỉ là
  đường tắt để đưa file sang nhóm Changes cho gọn.
- Trạng thái gập/mở của từng nhóm lưu qua `useUiState` như các state khác của tab.

### 2b. Xoá file unversioned (nút + phím Delete)

File untracked không "rollback" được — git không có bản gốc nào để trả về. Thứ
tương đương là **xoá khỏi đĩa**, đúng như Android Studio làm với node Unversioned Files.

- Server `deleteUntracked(cwd, files)` + `POST …/git/delete-files`.
- **Chốt chặn ở server:** mỗi path phải đang là `??` trong `git status`, không thì
  400. Không có chốt này thì một `pathId` sai hoặc client cũ có thể xoá vĩnh viễn
  file đang được git theo dõi — mất luôn cả nội dung chưa commit.
- Nút thùng rác trên mỗi dòng unversioned (hiện khi hover, cạnh nút Add).
- **Phím Delete / Backspace**: tác động lên dòng đang chọn, và **chỉ khi dòng đó là
  unversioned**. File tracked cố ý không xoá bằng phím — chúng đã có Rollback, và
  một phím lỡ tay không nên xoá được file đang có trong repo.
- Bỏ qua khi con trỏ đang ở `input`/`textarea`/`contenteditable`, nếu không thì
  Backspace lúc gõ commit message sẽ xoá file.
- Vẫn hỏi `confirm()` như nút Rollback đang làm.

### 3. Changelist (SQLite + drag)

Bảng mới `git_changelists` + `git_changelist_files`:

```
git_changelists:      id, project_id, path_id, name, is_default, created_at
git_changelist_files: id, changelist_id, path        (unique: changelist_id+path)
```

- Migration qua `drizzle-kit generate` (khớp `server/drizzle/00xx_*.sql` sẵn có).
- File **không** thuộc changelist nào → hiện ở nhóm "Changes" mặc định. Không tạo
  row cho mọi file, chỉ lưu file đã được kéo đi — bảng không phình theo repo.
- Route: `GET/POST/PATCH/DELETE /api/projects/:id/git/changelists`, và
  `POST …/changelists/:clId/files` `{ paths }` để chuyển file (xoá mapping cũ trước
  → một file chỉ nằm ở đúng một changelist).
- **Dọn rác:** file đã commit/revert sẽ không còn trong `status` nữa; mapping mồ côi
  bị lọc lúc render và xoá lười khi mở tab, không cần job nền.
- Drag: HTML5 drag-and-drop thuần (`draggable`, `onDragStart/onDragOver/onDrop`) —
  không thêm thư viện. **Kéo từng file một** (sửa so với bản plan đầu: UI này không
  có khái niệm multi-select — checkbox là để chọn file commit, mượn nó làm
  "đang chọn" sẽ khiến kéo 1 file lại chuyển cả chục file khác).
- **Unversioned Files không tham gia changelist**: nhóm đó được định nghĩa bằng
  "git chưa track", và nó sở hữu hành động Add. Cho kéo vào changelist thì file
  rời nhóm và mất luôn nút Add.

### 4. Pane kéo giãn được

- `web/src/components/ui/Splitter.tsx` (mới): thanh kéo dày 4px, `onPointerDown` →
  `setPointerCapture` → cập nhật kích thước. Không thêm dep.
- 3 chỗ áp dụng: chiều rộng cột trái (đang cứng `w-80`), chiều cao khối
  Changes (đang cứng `max-h-[42%]`), chiều cao khối Project files/History.
- Kích thước lưu bằng `useUiState` (đã dùng cho mọi state khác của tab) → sống qua
  chuyển tab và reload.
- Chặn kéo quá tay: min 200px / max 50% cho cột trái, min 120px cho các khối dọc.

## File dự kiến chạm

| File | Việc |
|---|---|
| `server/src/services/git-watch.ts` | mới — watcher + debounce + lọc |
| `server/src/ws/git-ws.ts` | mới — WS endpoint |
| `server/src/index.ts` | đăng ký `gitWs` |
| `server/src/services/git.ts` | `addFiles()`, hàm CRUD changelist |
| `server/src/routes/git.ts` | route add + changelists |
| `server/src/db/schema.ts` + `server/drizzle/*` | 2 bảng mới + migration |
| `web/src/features/git/useGitWatch.ts` | mới — WS client |
| `web/src/features/git/DiffTab.tsx` | nhóm, Add, changelist, drag, splitter |
| `web/src/components/ui/Splitter.tsx` | mới |
| `docs/plans/diff-realtime-and-changelists.md` | chính file này |

## Edge case đã tính

- **Repo Android to** → lọc theo tên thư mục + debounce; không gọi `check-ignore`
  mỗi event.
- **`fs.watch` recursive ném lỗi** → log, để poll 20s gánh, UI không vỡ.
- **Nhiều tab cùng xem 1 repo** → watcher đếm tham chiếu, không mở trùng.
- **Đổi repo trong dropdown** → đóng WS cũ, mở WS mới theo `pathId`.
- **Panel không active** → không mở WS (đúng như poll hiện tại đang làm).
- **File trong changelist bị commit/revert** → biến khỏi `status`, lọc lúc render.
- **Add file đang bị .gitignore** → `git add` báo lỗi; hiện lỗi đó qua `notice` sẵn có.
- **Commit khi đang có changelist** → vẫn commit đúng các file **được tick**, không
  ngầm hiểu "commit cả changelist"; tránh commit nhầm.

## Cần confirm

Không còn — cơ chế realtime (watcher + WS), nơi lưu changelist (SQLite) và phạm vi
(làm hết 1 lượt) đã chốt.

## Đã impl + verify

Chạy thật trên server đang sống, không suy luận từ code:

**Watcher/WS**
- `ready {watching:true}`; ghi file thật trong repo → `changed`.
- **Debounce đúng**: 4 lần ghi liên tiếp (1 lần, rồi 3 lần sát nhau) → đúng **1** event.
- **Lọc đúng**: ghi trong `node_modules` → **0** event. `git add` (đụng `.git/index`)
  → có event, tức là whitelist trong `.git` không chặn nhầm.
- `isNoise`: 11/11 case đúng (`.git/objects`, `.git/index.lock`, `.git/logs/HEAD` là
  nhiễu; `.git/HEAD`, `.git/index`, `.git/refs/heads/main`, `.git/MERGE_HEAD` không).

**Xoá file unversioned**
- Xoá file `??` → 200, file biến mất khỏi đĩa thật, watcher bắn event.
- Xoá file **tracked** → **400**, file còn nguyên (kiểm cả `existsSync` lẫn size).
- Trộn 1 untracked + 1 tracked trong cùng request → **400** và **không xoá nửa vời**:
  file untracked vẫn còn, vì validate chạy hết danh sách trước khi `rm` bất cứ thứ gì.

**API**
- `POST /add`: file `??` → sau add thành `A`/staged.
- Add file bị `.gitignore` → **400** kèm nguyên văn lời git ("paths are ignored by
  one of your .gitignore files").
- Changelist: tạo → kéo 2 file vào → rename → kéo 1 file về default → xoá.
- `clId` không thuộc repo đang xem → **400**.
- Scope theo `pathId`: hỏi bằng `pathId` khác → rỗng.
- Xoá changelist → mapping bị cascade sạch (0 row còn lại).

**Build/lint**
- `tsc --noEmit` sạch cả `web` lẫn `server`; `vite build` OK.
- `eslint` sạch trên toàn bộ file đã đụng.

**Lỗi có sẵn, không phải do thay đổi này** (không sửa vì ngoài phạm vi):
`server/src/lib/__tests__/zip.test.ts` 2 lỗi type; `web/src/features/git/FileTree.tsx`
1 lỗi lint `set-state-in-effect`.
