# Proactive project memory

## Vấn đề quan sát được

`wis555-reelme-film-studio` có 2 memory, cả 2 đều do user bảo Claude ghi.
`aip555-reelme-android`, `iip555-reelme-ios`, `Claude Station` có 0 memory dù đã làm việc.

Bằng chứng từ DB (`data/claude-station.db`):

```
wis555-reelme-film-studio | 2 memories | 15 sessions
iip555-reelme-ios         | 0          | 2
aip555-reelme-android     | 0          | 1
Claude Station            | 0          | 0

select source, count(*) from project_memories → manual | 2
```

**Không có memory nào có `source = 'claude'`.** Tool `memory_write` chưa từng chạy
thành công lần nào kể từ khi feature ra đời. Kể cả 2 memory của wis555 cũng được
tạo qua HTTP route (UI), không qua tool.

## Nguyên nhân gốc (3 tầng, xếp theo mức độ chặn)

### 1. Cold-start deadlock — project 0 memory thì prompt không hề nhắc tới memory

`server/src/services/memory.ts:169`

```ts
export function memoryPromptSection(projectId: string, capBytes: number): string {
  const memories = listMemories(projectId);
  if (memories.length === 0) return "";   // ← đây
```

`buildWorkspaceContext` (`workspace-context.ts:64-65`) chỉ push section khi chuỗi
không rỗng. Nên với project chưa có memory nào, system prompt của session **không
chứa một chữ "memory" nào**. Model không biết project này có memory store →
không bao giờ ghi → vĩnh viễn 0 memory. Đúng cái vòng lặp chết mà aip555/iip555
đang mắc.

wis555 thoát ra được chỉ vì user tự tay tạo memory đầu tiên qua UI.

### 2. Section memory hiện tại chỉ dạy ĐỌC, không dạy GHI

`memory.ts:167-194` sinh ra:

```
## Project memory
### <title>
<body>

Also available (read with the memory_get tool when relevant):
- <title>
```

Không có một dòng nào nói *khi nào thì nên ghi memory mới*. Thứ duy nhất gợi ý
việc ghi là description của tool `memory_write` (`mcp/server.ts:231`) — mà tool
description thì model chỉ đọc khi đã có ý định gọi tool, nó không tạo ra ý định.
Đây là lý do memory luôn bị động: phải user gõ "ghi cái này vào memory" thì mới có.

### 3. `memory_write` bị permission chặn, và bị DENY thẳng khi không ai xem

`server/src/services/claude-session.ts:226` chỉ auto-allow `mcp__station__workflow_*`.
`memory_write` rơi vào `requestPermission` → hiện modal. Và nếu session không có
listener nào (tab đóng, workflow chạy nền) thì `claude-session.ts:230-243` trả
`behavior: "deny"` luôn.

Nghĩa là: kể cả khi model muốn ghi, ở phần lớn tình huống chạy nền nó sẽ ăn deny
và bỏ luôn ý định đó.

### 4. Phụ trợ: không có `memory_update` / `memory_delete` tool

MCP chỉ có `memory_list`, `memory_get`, `memory_search`, `memory_write`
(`mcp/server.ts:194-252`). REST route có PATCH/DELETE nhưng Claude không chạm được.
→ Nếu bật ghi chủ động mà không có sửa/xoá, memory sẽ chỉ phình ra bản trùng.

## Mục tiêu

Claude tự nạp memory trong lúc làm việc, không cần user nhắc; memory giữ được
convention / quyết định / gotcha thay vì log task; không sinh rác trùng lặp.
Rule dùng chung cho mọi project sống ở một chỗ duy nhất (global memory).

## Quyết định đã chốt (2026-08-17)

1. **Mức ghi: vừa** — ghi khi user correct cách làm, khi chốt quyết định
   kiến trúc/quy trình, khi phát hiện convention riêng của project, và gotcha
   *chỉ khi* nó thực sự làm mất thời gian. Không ghi task log.
2. **Quyền:** `memory_write` + `memory_update` auto-allow; `memory_delete` vẫn
   hiện modal xin phép.
3. **Phạm vi rule chung:** làm **global memory** — memory không thuộc project nào,
   được nạp vào prompt của mọi project.

## Phạm vi

Server (schema + migration + service + routes + prompt + MCP tools) và một trang
UI global `/memory`. Tab Memory trong project giữ nguyên hành vi.

## Các bước

### B0 — Global memory: schema + migration
`server/src/db/schema.ts`, `server/drizzle/` (drizzle-kit generate)

- `project_memories.project_id` → **nullable**. `NULL` = memory global.
  Giữ nguyên FK `onDelete: cascade` (NULL không bị ràng buộc).
- SQLite phải rebuild bảng để bỏ `NOT NULL` → để `npm run db:generate` sinh
  migration `0013_*`, kiểm tra file SQL sinh ra có copy đủ dữ liệu 2 row hiện có.
- Index `idx_project_memories_project` giữ nguyên; thêm partial/thường cho
  `project_id IS NULL` nếu drizzle hỗ trợ, không thì bỏ qua (số row rất nhỏ).

Chọn cách này thay vì tạo bảng `global_memories` riêng vì toàn bộ service /
route / component UI đang khoá theo `projectId`; nullable cho phép tái dùng
nguyên vẹn, còn `eq(projectId, id)` sẵn có tự động loại global ra khỏi list
của project (đúng ý muốn).

### B0.1 — Service & routes cho global
`server/src/services/memory.ts`, `server/src/routes/memory.ts`

- `createMemory(projectId: string | null, ...)`.
- `listGlobalMemories()` dùng `isNull(projectMemories.projectId)`.
- `searchMemories(projectId, query)` → thêm cờ để search cả global.
- `workHistory` yêu cầu `projectId` → với memory global thì **bỏ qua** entry
  history (hoặc ghi vào project đang thao tác nếu gọi từ session). Chọn: bỏ qua,
  tránh FK lỗi.
- Routes mới: `GET/POST /api/memory/global`, `POST /api/memory/global/import`.
  `PATCH/DELETE/export /api/memory/:id` dùng lại nguyên vẹn.

### B0.2 — Seed rule chung
- Migration data-seed một lần: tạo global memory **pinned** tên
  `Plan & scope rules` với nội dung: task lớn / bug khó / refactor to → lên plan
  trước; task nhỏ → làm thẳng; file plan để trong `docs/plans/` và **phải được
  gitignore**; mọi thay đổi so với plan → sửa plan trước rồi mới sửa code.
- Seed chạy idempotent (check theo title, không tạo lại nếu đã có).

### B0.3 — UI trang global `/memory`
`web/src/main.tsx`, `web/src/pages/MemoryPage.tsx`, `MemoryTab.tsx`

- `MemoryTab` nhận `projectId: string | null`; `null` → gọi endpoint global,
  `projectKey()` dùng khoá `"global"` cho ui-state.
- Thêm route `/memory` + mục sidebar cạnh Knowledge / Agents / Workflows.
- Tab Memory của project hiện thêm dòng gợi ý "rule chung nằm ở trang Memory".

### B1 — Prompt luôn có section memory + capture policy
`server/src/services/memory.ts`, `server/src/services/workspace-context.ts`

- Bỏ early-return rỗng. Luôn xuất, theo thứ tự:
  1. `## Global memory` — rule chung mọi project (pinned inline, còn lại titles-only).
  2. `## Project memory` — như hiện tại; khi 0 memory thì ghi rõ "project này chưa
     có memory nào — tự tạo khi gặp thứ đáng nhớ".
  3. `### Khi nào ghi memory` — capture policy (text tĩnh, luôn có mặt).
- Nội dung capture policy (mức "vừa" đã chốt):
  - **Ghi khi:** user sửa/correct cách làm; chốt quyết định kiến trúc hoặc quy trình;
    phát hiện convention riêng của project mà code không nói ra; gotcha **chỉ khi**
    nó đã làm mất thời gian đáng kể.
  - **Không ghi:** log việc đã làm, thứ đọc được từ code/git/CLAUDE.md, thứ chỉ
    đúng trong một session.
  - **Trước khi ghi:** `memory_search` để tránh trùng; trùng thì `memory_update`
    chứ không tạo mới.
  - **Format:** ngắn, durable, kèm *lý do* để session sau áp dụng đúng.
  - **Scope:** rule đúng cho mọi project → `scope: "global"`; còn lại → project.
  - **Pin:** chỉ pin thứ mọi session đều cần.
  - Ghi ngay lúc phát hiện, không dồn tới cuối session (session có thể bị đóng
    giữa chừng).

### B2 — MCP: `memory_update`, `memory_delete`, và tham số `scope`
`server/src/mcp/server.ts`

- `memory_write(title, body, tags?, pinned?, scope?)` — `scope: "project" | "global"`,
  mặc định `"project"`.
- `memory_update(id, title?, body?, tags?, pinned?)` — gộp/sửa memory cũ.
- `memory_delete(id)` — xoá memory đã sai/hết hạn.
- `memory_list` / `memory_search` trả cả global lẫn project, có cột `scope` để
  Claude biết cái nào là rule chung.
- Guard ownership: cho phép id thuộc project hiện tại **hoặc** id global
  (`projectId === null`); id của project khác → từ chối (hiện `memory_get` đã có
  guard này ở `mcp/server.ts:219`, `updateMemory`/`deleteMemory` thì chưa).
- `updateMemory` bổ sung entry `workHistory` kind `memory_updated` (chỉ khi memory
  thuộc project — global thì bỏ qua).

### B3 — Quyền tool memory trong `canUseTool`
`server/src/services/claude-session.ts:226`

- Auto-allow `mcp__station__memory_list|get|search|write|update`.
- **`memory_delete` giữ nguyên modal** (xoá là mất dữ liệu — đã chốt).
- Lý do auto-allow: chỉ ghi vào SQLite của app, không đụng file repo / mạng /
  external service; user review & xoá được ở tab Memory; và nếu bắt modal thì
  session chạy nền ăn deny thẳng → chính là lỗi gốc #3.
- Lưu ý: session không có listener sẽ vẫn deny `memory_delete` — chấp nhận được,
  Claude chỉ mất khả năng dọn rác khi chạy nền.

### B4 — Cập nhật docs
- `README.md`: mục Memory mô tả lại là Claude chủ động ghi + có global memory.
- Plan này là single source of truth cho phạm vi.

## Thứ tự thực hiện

B0 → B0.1 → B0.2 → B1 → B2 → B3 → B0.3 (UI) → B4 (docs).
Sau B1+B2+B3 là đã fix xong lỗi gốc; B0.3 chỉ để quản lý bằng tay.

## Edge cases

- **Cap prompt:** capture policy là text tĩnh (~15 dòng) và phải **luôn đứng ngoài
  cap** — `capBytes` chỉ áp cho phần body memory. Nếu policy bị cắt thì fix này vô
  nghĩa.
- **Global + project cùng tranh cap:** global pinned ưu tiên trước, project pinned
  sau; phần vượt cap chuyển thành dòng "(too long to inline — read it with
  memory_get)" như logic hiện tại.
- **Project mới, 0 memory:** section vẫn hiện → workspace context không bao giờ rỗng
  hoàn toàn nữa, chấp nhận được (vài trăm byte).
- **Sub-agent / workflow step:** dùng chung `buildWorkspaceContext` nên tự hưởng.
- **Spam memory:** policy nhấn "không ghi task log" + bắt `memory_search` trước khi
  ghi. Nếu thực tế vẫn spam → siết policy, không sửa code.
- **Migration rebuild bảng:** SQLite bỏ `NOT NULL` phải tạo bảng mới + copy. Backup
  `data/claude-station.db` trước khi chạy; verify 2 row cũ còn nguyên sau migrate.
- **`workHistory` với memory global:** cột `projectId` là `NOT NULL` + FK → bỏ ghi
  history cho thao tác global thay vì nhét project id giả.
- **Ownership guard:** `updateMemory`/`deleteMemory` ở service không check project.
  Guard phải nằm ở tầng MCP tool trước khi gọi service.

## Đã chốt, không còn câu hỏi mở

Xem mục "Quyết định đã chốt" ở trên.

## Đã impl — khác biệt so với plan

Toàn bộ B0 → B4 đã xong. Ba chỗ làm khác plan:

1. **Seed idempotent bằng marker, không bằng title** (B0.2). Plan định check
   "đã có note tên này chưa". Như vậy xoá note seed đi thì restart nó mọc lại.
   Thực tế: ghi cờ `memory.seeded.<title>` vào `app_settings` (key không nằm
   trong `appSettingsSchema` nên zod strip, không hiện ở Settings UI). Xoá là xoá
   hẳn — đã verify bằng cách xoá rồi restart server.
2. **Cách bảo vệ capture policy khỏi cap** (B1). Plan chỉ nói "policy ngoài cap".
   Cụ thể: `buildWorkspaceContext` cắt riêng phần index repo/knowledge trước, rồi
   mới nối khối memory vào sau — trước đây cắt cả chuỗi từ đuôi, mà memory nằm
   cuối nên chính nó là thứ bị cắt đầu tiên.
3. **Sửa thêm một bug ngoài plan:** `searchMemories` áp `limit` trước rồi mới lọc
   theo project bằng JS — memory của project khác ăn hết quota nên search có thể
   trả rỗng dù có match. Đã chuyển bộ lọc scope vào SQL.

Bỏ qua: index riêng cho `project_id IS NULL` (số row quá nhỏ, không cần).

Chưa làm, cần quyết định riêng: `source` của note seed đang là `manual` nên UI
hiện badge "you". Muốn đúng thì phải thêm giá trị `builtin` vào enum `source`
(shared schema + UI label + service) — chưa đáng ở thời điểm này.
