# Fix: Diff tab hiển thị thư mục untracked là `?? <dir>` và không mở được diff

## Mục tiêu

Khi một thư mục hoàn toàn untracked (vd `docs/plans/`), tab Diff hiện đúng từng file bên trong (mở diff được) thay vì một entry thư mục `?? docs/plans/` click vào chỉ thấy "No changes against HEAD."

## Nguyên nhân

- `git status --porcelain=v1` mặc định gom cả thư mục untracked thành một entry duy nhất (`?? docs/plans/`).
- `diff()` fallback sang `untrackedPatch()` chạy `git diff --no-index /dev/null <path>` — lỗi với thư mục → trả chuỗi rỗng → UI hiện "No changes against HEAD."
- Tab PROJECT FILES không bị vì `listFiles()` dùng `git ls-files --others` (liệt kê từng file).

## Các bước

1. Thêm cờ `-uall` (`--untracked-files=all`) vào lệnh status trong `server/src/services/git.ts` (hàm `status()`), để git expand thư mục untracked thành từng file.

## File chạm

- `server/src/services/git.ts` — 1 dòng.

## Edge case

- Thư mục untracked chứa nhiều file → mỗi file thành một entry `??` riêng, commit/revert theo từng file hoạt động như file untracked bình thường.
- `-uall` có thể chậm hơn chút trên repo có rất nhiều file untracked — chấp nhận được, cùng độ lớn với `ls-files --others` đang dùng ở project tree.

## Ngoài phạm vi (chưa làm)

- Đổi badge `??` thành nhãn thân thiện hơn (vd `U`) ở UI — cosmetic, làm sau nếu cần.
