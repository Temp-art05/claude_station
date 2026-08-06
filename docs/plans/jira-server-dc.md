# Jira integration: hỗ trợ Jira self-hosted (Server/DC) bên cạnh Cloud

## Mục tiêu
`server/src/services/jira.ts` hiện chỉ chạy với Jira Cloud (Basic auth email+token,
REST API v3, ADF). Jira self-hosted (vd `jira.apero.vn`) cần **PAT + Bearer** và chỉ
có **API v2** (description/comment là text, không phải ADF) → hiện tại luôn 401.
Thêm lựa chọn deployment để cả hai cùng chạy.

## Thiết kế

### `shared/src/types.ts` — jiraConfigSchema
- Thêm `deployment: z.enum(["cloud", "server"]).default("cloud")` (default giữ
  back-compat với config đã lưu).
- `email`: optional (`""` cho phép) + `superRefine`: bắt buộc khi `deployment=cloud`.

### `server/src/services/jira.ts`
- `jiraFetch`: auth theo deployment — cloud `Basic base64(email:apiToken)`,
  server `Bearer <apiToken>` (PAT). API version: cloud `/rest/api/3`, server `/rest/api/2`.
  Path truyền vào bỏ prefix version, hàm tự ghép.
- `searchIssues`: cloud `POST /rest/api/3/search/jql` (như cũ);
  server `POST /rest/api/2/search` (body cùng shape `{jql, maxResults, fields}`).
- `getIssue`: description server là string (wiki markup) → nếu `typeof === "string"`
  dùng thẳng, ngược lại `adfToMarkdown` (check này an toàn cho cả hai).
- `addComment` / `addWorklog`: server gửi text thường, cloud gửi ADF.
- `getTransitions` / `transitionIssue`: chỉ khác version path.

### `server/src/routes/integrations.ts`
- `/api/jira/status` trả thêm `deployment`.

### `web/src/pages/SettingsPage.tsx` — JiraForm
- Thêm `<select>` deployment: "Jira Cloud" / "Self-hosted (Server/DC)".
- `server`: ẩn field Email, help text đổi sang "Personal Access Token (Jira →
  Profile → Personal Access Tokens)"; nút Save không đòi email.
- PUT body thêm `deployment`; `JiraStatus` + key của form thêm deployment.

## Bổ sung: ô tìm kiếm nhận text thường
- `searchIssues` (`jira.ts`): input trống → my-open-issues (như cũ); trùng dạng
  issue key (`ABC-123`) → `key = "ABC-123"`; chứa toán tử/keyword JQL
  (`= ~ < > ! AND OR NOT ORDER BY IS IN WAS CHANGED EMPTY`) → chạy như JQL thô;
  còn lại → `text ~ "<query>" ORDER BY updated DESC` (escape `"` `\`).
- `JiraPage`: debounce 400ms trước khi query, placeholder mới.

## File chạm
`shared/src/types.ts`, `server/src/services/jira.ts`,
`server/src/routes/integrations.ts`, `web/src/pages/SettingsPage.tsx`.

## Edge cases
- Config cũ đã lưu (không có `deployment`) → default `"cloud"`, hành vi y nguyên.
- Server/DC: email không nhập → schema vẫn pass; cloud thiếu email → lỗi validate rõ.
- MCP tools (`jira_*`) dùng chung service nên tự hưởng, không sửa.

## Verify
- `tsc` shared/server/web pass; test hiện có (`pure.test.ts` adfToMarkdown) pass.
- Test tay với jira.apero.vn: save config deployment=server + PAT → tab Jira list issue.
