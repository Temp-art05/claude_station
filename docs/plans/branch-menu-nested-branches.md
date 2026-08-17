# Branch menu: fix checkout branch có `/` + group theo folder + search

## Bug gốc (đã xác định)

`server/src/services/git.ts:355-366` — `checkout()` đoán "remote ref" bằng **hình dạng tên**:

```ts
const remoteMatch = /^[^/]+\/(.+)$/.exec(branch);   // bất kỳ tên có "/" đều bị coi là remote
if (remoteMatch) {
  const local = remoteMatch[1]!;                    // "version/4.0.0" -> "4.0.0"
  const hasLocal = git(cwd, ["branch", "--list", local]).trim() !== "";
  return hasLocal ? switch local : switch -c local --track branch;
}
```

Nên click branch **local** `version/4.0.0` → regex khớp → `local = "4.0.0"` → chưa có local `4.0.0`
→ chạy `git switch -c 4.0.0 --track version/4.0.0` → **tạo branch mới `4.0.0`** track `version/4.0.0`
đúng như screenshot (LOCAL có cả `4.0.0` đang là current và `version/4.0.0`).

Ảnh hưởng: mọi branch local dạng `<a>/<b>` (`feature/x`, `release/1.2`, `version/4.0.0`, `cuongngd/fixbug`).
FE không có lỗi ở đây — `branchRow` đã gửi đúng full name; lỗi 100% ở server.

## Mục tiêu

1. Checkout **đúng ref** cho branch có `/` (local đi đường local, remote mới tạo tracking branch).
2. Danh sách branch **gom theo folder** (kiểu Android Studio): `version/` → `4.0.0`; remote gom theo remote name rồi tới folder.
3. Search: input đã có sẵn ở `BranchMenu.tsx:189` — nâng để filter xuyên tree (match cả full path), auto-expand nhóm khớp, Esc để clear.

## Phạm vi

- Sửa logic phân giải ref ở server (không thêm endpoint mới, không đổi contract API).
- Sửa render danh sách trong `BranchMenu.tsx` (tree group), giữ nguyên toàn bộ action hiện có (Fetch/Pull/Pull --rebase/Push/New branch, hover Merge/Rebase/Delete, banner Abort).
- Thêm helper pure `buildBranchTree` vào `shared/` + unit test.

Ngoài phạm vi (chỉ báo, không tự làm): xoá branch rác `4.0.0` mà bug đã tạo trong repo người dùng — họ tự xoá bằng nút Delete trong menu.

## Các bước

### 1. Server — `server/src/services/git.ts`

- Thêm helper `refExists(cwd, fullRef)`: `git show-ref --verify --quiet <fullRef>` trong try/catch → boolean.
- Thêm helper `remoteNames(cwd)`: `git remote` → string[].
- Viết lại `checkout(cwd, branch, create)`:
  1. `create` → giữ nguyên `git switch -c <branch>`.
  2. `refs/heads/<branch>` tồn tại → `git switch <branch>` (**ưu tiên local trước**, giống git thật).
  3. `refs/remotes/<branch>` tồn tại → local name = bỏ đúng prefix `<remote>/` lấy từ `remoteNames()`
     (không dùng regex đoán đoạn đầu) → có local rồi thì `git switch <local>`, chưa có thì
     `git switch -c <local> --track <branch>`.
  4. Không khớp ref nào → `git switch <branch>` để git tự báo lỗi (giữ message của git).
- Đổi thứ tự đoán → thứ tự tra ref: không còn khả năng tự tạo branch ngoài ý muốn.

### 2. Shared — `shared/src/branch-tree.ts` (MỚI)

- `buildBranchTree(names: string[]): BranchNode[]` với `BranchNode = { kind: "leaf", name, label } | { kind: "folder", label, path, children }`.
  - `name` = full ref (dùng để checkout), `label` = segment cuối (dùng để hiển thị).
  - Folder chỉ sinh khi prefix có ≥2 branch; branch một mình (`version/4.0.0` duy nhất) vẫn hiển thị leaf full name → không phát sinh folder 1 con vô nghĩa.
  - Sort: folder trước, leaf sau, mỗi nhóm sort theo label (localeCompare, numeric để `4.0.0` < `4.0.10`).
- Export trong `shared/src/index.ts`.

### 3. Web — `web/src/features/git/BranchMenu.tsx`

- Filter: match `name.toLowerCase().includes(q)` trên **full name** (giữ như hiện tại) rồi mới build tree từ list đã filter.
- Render đệ quy: folder row có chevron + `Folder` icon + label + số con; leaf row = `branchRow` hiện tại nhưng **hiển thị `label`**, `title` là full name, click vẫn gửi `node.name` (full).
- Expand state: `Set<string>` path folder trong `useState`; có filter (`q !== ""`) → coi như expand hết; clear filter → về state cũ.
- Remote: build tree từ list remote như trên (segment đầu là remote name → thành folder `origin` khi có ≥2 branch) — không tách case riêng.
- Esc trong input search: clear filter nếu đang có chữ, ngược lại đóng popup.
- Giữ `max-h-64 overflow-y-auto` và style hiện tại (font-mono 11px, hover actions opacity).

### 4. Test

- `server/src/services/__tests__/git-checkout.test.ts` (MỚI, vitest + git thật trong `mkdtempSync(tmpdir())`):
  - init repo, 1 commit, tạo `version/4.0.0` → `checkout(cwd, "version/4.0.0")` → current đúng là `version/4.0.0` **và** `git branch --list 4.0.0` rỗng (regression test của bug này).
  - clone thành remote → `checkout(cwd, "origin/feature/x")` tạo local `feature/x` có upstream `origin/feature/x`.
  - checkout lại local đã tồn tại → không tạo thêm branch.
- `pure.test.ts`: case cho `buildBranchTree` (nested, folder 1 con, sort numeric).
- `npm run check` (typecheck + eslint + test) và `npm run build`.

### 5. Docs

- Thêm changelog `rev15` vào `docs/plans/claude-station.md` (mô tả bug + fix + group/search).
- Ghi chú vào `docs/plans/git-panel.md` §Phase 2: câu "remote chưa có local → `switch -c --track`" giờ điều kiện là **ref tồn tại ở `refs/remotes`**, không phải "tên có `/`".

## Edge case

- Branch local trùng tên shorthand remote (local `origin/foo` — hợp lệ với git): ưu tiên `refs/heads` → checkout local, đúng ý nhất.
- Remote name có `/`: dùng `git remote` để cắt prefix nên vẫn đúng.
- Detached HEAD: `current = "(detached)"` → không branch nào là current, list vẫn checkout được.
- Working tree dirty làm `switch` fail: giữ nguyên hành vi — `gitOr400` trả stderr của git lên notice.
- Branch >2 cấp (`cuongngd/fixbug/crash`): tree lồng nhiều tầng, checkout vẫn full name.
- Local branch đã có nhưng không track remote (case 3 rẽ nhánh `hasLocal`): chỉ `switch`, **không** tự set upstream — không đổi hành vi cũ.

## Đã chốt với người dùng (2026-08-14)

1. Folder **chỉ sinh khi ≥2 branch cùng prefix** — `version/4.0.0` đứng một mình vẫn là leaf full name.
2. Folder **collapse hết** khi mở menu (hiện số con bên cạnh); có search → auto-expand nhóm khớp; folder chứa branch current → expand sẵn để thấy branch đang đứng.
