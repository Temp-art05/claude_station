# Folder import — Knowledge / Agents / Workflows

## Mục tiêu
Cho phép import **cả một thư mục** (chọn qua picker hoặc kéo-thả từ Finder) ở 3 khu vực: Knowledge, Agents, Workflows. Lý do: một agent/skill thường được đóng gói nhiều file (định nghĩa .md + tài liệu/template kèm theo).

## Semantics đã chốt với người dùng
1. **Knowledge**: cả folder = **1 knowledge item** (`kind: "folder"`, `storedPath` trỏ tới directory, giữ nguyên cấu trúc bên trong). Nếu root folder có `SKILL.md` (import global) → import cả cây làm **1 skill bundle** (`linkSkillTree` copy toàn bộ cây, không chỉ SKILL.md).
2. **Agents**: folder chứa 1 file .md định nghĩa agent (frontmatter + body) + file kèm theo. File .md → agent record; các file còn lại copy vào `data/agents/<tên>/` (cột mới `bundle_dir`), và dir đó được thêm vào `additionalDirectories` khi agent chạy; prompt được append thêm mục "Companion files" trỏ tới path.
3. **Workflows**: folder = batch import — mỗi `.yaml/.yml/.json` (quét đệ quy) thành 1 workflow riêng; trả về summary per-file (imported/renamed/skipped/error).
4. **Trùng tên** (agent/workflow/skill/dir): tự đổi tên hậu tố `-2`, `-3`… — không fail, không ghi đè.

## Thiết kế chính
- Web SPA (không phải Electron) → folder picker dùng `<input type="file" webkitdirectory>`; kéo-thả folder dùng `DataTransferItem.webkitGetAsEntry()` (loop `readEntries()` tới khi rỗng — Chrome trả tối đa 100 entry/lần).
- Đường truyền relative path: mỗi part multipart dùng **filename = relPath** (`form.append("files", file, relPath)`), server sanitize bằng `sanitizeRelPath` (chặn `..`, path tuyệt đối, NUL; bỏ `.DS_Store`, `Thumbs.db`, `.git/`).
- Endpoint mới, giữ nguyên endpoint 1-file cũ: `POST /api/knowledge/folder`, `POST /api/agents/import-folder`, `POST /api/workflows/import-folder`.
- Download route trả 400 rõ ràng cho item kind `folder`; UI ẩn nút download.
- Fix bug sẵn có: `attachedAssetDirs()` (library.ts) slice string → sai khi `storedPath` là directory; đổi sang `statSync().isDirectory()`.

## File đụng tới
**Server**
- `server/src/lib/multipart.ts` (MỚI): `readSinglePart`, `readUploadParts`, `sanitizeRelPath`.
- `server/src/index.ts`: register multipart với limits (`files: 2000, parts: 2100` — default 1000 parts chặn folder to).
- `server/src/services/knowledge.ts`: `importFolder`, `importSkillBundle`, `textBodyOf` walk directory cho kind folder (cap 1MB/file, 2MB/item, allowlist TEXTUAL).
- `server/src/services/skills.ts`: `linkSkillTree` (ghi cả cây + de-conflict + rewrite frontmatter `name:` khi đổi tên); `linkSkill` thành wrapper.
- `server/src/services/library.ts`: fix `attachedAssetDirs`.
- `server/src/services/agents.ts`: refactor `parseAgentMarkdown`; `uniqueAgentName`; `importAgentFolder` (rule chọn file định nghĩa: `agent.md` → `<root>.md` → duy nhất 1 candidate, nhiều hơn → 400); `agentBundleDirs`; `deleteAgent` xoá bundle dir.
- `server/src/services/workflows.ts`: `uniqueWorkflowName`; `importWorkflowYamlDetailed` (báo renamedFrom).
- `server/src/services/claude-session.ts`: thêm bundle dirs vào `additionalDirectories`.
- `server/src/routes/{knowledge,agents,workflows}.ts`: endpoint mới + dùng helper multipart chung.
- `server/src/db/schema.ts`: cột `agents.bundle_dir`; migration drizzle mới (`npm run db:generate -w server`).
**Shared**
- `shared/src/types.ts`: `agentSchema.bundleDir`; `folderImportResultSchema` / `folderImportSummarySchema`.
**Web**
- `web/src/lib/folder-upload.ts` (MỚI): `filesFromDirectoryInput`, `collectDropped`, `uploadFiles`, `directoryInputProps`.
- `web/src/features/knowledge/KnowledgePanel.tsx`: kind `folder` (icon, ẩn download), mutation upload folder, drop handler nhận folder, nút "Import folder".
- `web/src/pages/AgentsPage.tsx`: nút "Import folder".
- `web/src/pages/WorkflowsPage.tsx`: nút "Import folder" + panel summary kết quả batch.

## Edge case
- Folder > 2000 file hoặc > 256MB tổng → 400 rõ ràng (chặn OOM vì part buffer trong RAM).
- FTS chỉ index file text theo allowlist extension, cap dung lượng.
- Symlink trong folder: browser không gửi; request giả mạo bị chặn bởi `sanitizeRelPath`.
- Thư mục rỗng không tồn tại qua browser API — chấp nhận.
- Đổi tên skill khi trùng → rewrite `name:` trong SKILL.md để Claude Code không thấy 2 skill trùng tên.
- Đổi tên agent sau import → `bundle_dir` giữ path cũ (vẫn hoạt động) — chấp nhận.

## Verify
- Unit: `server/src/lib/__tests__/multipart.test.ts` (sanitizeRelPath), cập nhật `agent-markdown.test.ts` (field bundleDir).
- `npm run typecheck -w server` + web build/typecheck, `npm run test -w server`.
- Manual: kéo folder vào Knowledge (item kind folder, đúng cây trên disk, search thấy nội dung); folder có SKILL.md → skill bundle + symlink; import folder agent (bundle dir + agent đọc được file kèm; 2 file định nghĩa → 400; delete agent xoá dir); folder workflows → summary imported/renamed/error/skipped; regression các luồng import 1 file cũ.
