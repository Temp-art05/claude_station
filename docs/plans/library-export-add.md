# Library export / Add — chia sẻ thư viện giữa các station

Thay cho [backup-migrate.md](backup-migrate.md).

## Vì sao
- Import v1 **thay thế** toàn bộ data: import nhầm (hoặc import 2 lần) là data cũ bị đẩy vào `data/backups/`, user tưởng mất hết.
- Export v1 mang theo project, nhưng project trỏ vào repo trên máy cũ (`/Users/<other>/...`) — sang máy khác thì hỏng, export ra cũng không dùng được.

## Thiết kế
- **Export** (`GET /api/export`, manifest `version: 2, kind: "library"`): DB snapshot (`sqlite.backup`) rồi lọc theo **whitelist** bảng
  (`knowledge_items`, `agents`, `workflows`, `workflow_steps`, `workflow_inputs`, `project_memories`, `env_sets`, `env_vars`, `integrations`).
  Bảng khác bị xoá rỗng, kể cả bảng thêm sau này. Dòng gắn với project (knowledge/memory/env set) bị loại. Trigger và bảng FTS bị drop.
  Archive chỉ chứa đúng những file mà các dòng còn lại trỏ tới (skill dir, global knowledge, agent bundle).
- **Add** (`POST /api/library/add`): gộp vào DB đang chạy trong một transaction, **không ghi đè**:
  trùng id/tên thì skip và báo lại. Đường dẫn cũ (dataDir của máy nguồn) được map sang DATA_DIR hiện tại, skill được link lại vào `~/.claude/skills`, knowledge được reindex.
  Đọc được cả archive v1 (chỉ lấy phần thư viện, báo số project bị bỏ). Không cần restart.
- Bỏ import kiểu thay thế (`POST /api/import`) và `releaseAllWorktrees`.
