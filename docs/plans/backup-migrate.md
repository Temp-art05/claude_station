# Backup / Migrate — export & import toàn bộ data

## Mục tiêu
Người dùng export toàn bộ data (projects, sessions, knowledge, skills, agents bundle, env sets, memories...) thành 1 file archive, đem sang máy khác chạy cùng app và import lại.

## Thiết kế
- **Export** (`GET /api/export` → download `claude-station-export-<date>.tar.gz`):
  - DB snapshot bằng `better-sqlite3 backup()` (an toàn với WAL, không copy file sống).
  - Gồm: `claude-station.db` (snapshot), `knowledge/`, `skills/`, `agents/`, `attachments/`, `manifest.json` (version, exportedAt, dataDir cũ), `station.env` (bản sao `.env` của repo — chỉ để tham khảo, KHÔNG tự apply khi import).
  - Loại: `worktrees/` (checkout theo máy), `logs/` (rác), `.token` (mỗi máy token riêng).
  - Nén bằng `tar` hệ thống (macOS/Linux có sẵn, không thêm dependency).
- **Import** (`POST /api/import`, multipart, cap 4GB):
  1. Giải nén vào staging trong DATA_DIR.
  2. Validate `manifest.json`.
  3. **Rewrite prefix đường dẫn tuyệt đối** trong DB staged: dataDir cũ → DATA_DIR mới, cho các cột `knowledge_items.stored_path/parsed_path`, `agents.bundle_dir/view_path`, `command_runs.log_path`, `terminals.cwd`; `chat_sessions.worktree_path` → NULL (worktree không mang theo). `project_paths.path` GIỮ NGUYÊN (repo nằm chỗ khác trên máy mới — user sửa trong UI, item hiện "missing").
  4. Backup data hiện tại sang `data-backup-<timestamp>/` cạnh DATA_DIR rồi swap staging vào chỗ.
  5. Relink skills vào `~/.claude/skills`.
  6. Trả về hướng dẫn: **restart server** để nạp DB mới (connection cũ vẫn giữ inode cũ — mọi ghi sau import vào bản cũ sẽ mất, nên restart ngay).
- **UI**: Settings → section "Backup & migrate": nút Export (tải file) + Import (chọn file, confirm ghi đè, hiện đường backup + nhắc restart).

## File
- `server/src/services/backup.ts` (MỚI), `server/src/routes/backup.ts` (MỚI, đăng ký trong index.ts)
- `web/src/pages/SettingsPage.tsx` — thêm section.

## Edge case
- Archive lạ/thiếu manifest → 400. bsdtar mặc định chặn path `..`/tuyệt đối.
- Import trên chính máy cũ (prefix trùng) → rewrite no-op, vẫn chạy.
- DB đang mở khi swap: file cũ vẫn sống qua fd đến khi restart — chấp nhận với cảnh báo restart ngay (v1).
