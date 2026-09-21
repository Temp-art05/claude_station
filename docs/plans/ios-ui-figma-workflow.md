# Plan — workflow impl UI iOS bám Figma (`impl-ios-ui-workflow`)

Trạng thái: **đã làm xong**. Ngày: 2026-09-17.

## 1. Mục tiêu

Một workflow trong nhóm `ios` chuyên để **dựng UI**: đọc design thẳng từ Figma qua MCP, impl, rồi
mở **thẳng màn vừa làm** trên simulator, chụp ảnh, đặt cạnh design và sửa cho tới khi khớp. Vòng
lặp screenshot ↔ so sánh chạy bằng **model rẻ** để không đốt token.

## 2. Quyết định đã chốt (user, 2026-09-17)

| #   | Quyết định                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Figma MCP vào step bằng cách **merge `mcpServers` global của `~/.claude.json`** vào mcp.json của run, **vẫn giữ `--strict-mcp-config`** |
| Q2  | Model rẻ khai bằng **field `model` trên từng step** → truyền `--model` cho CLI của step                                                 |
| Q3  | Workflow **generic cho mọi project iOS**, không hardcode riêng BetterMe                                                                 |
| Q4  | Vòng lặp chụp-so-chấm chạy **sonnet** (không phải haiku)                                                                                |
| Q5  | Có bước **`pr`** ở cuối: commit dưới tên user + mở PR tiếng Việt                                                                        |

## 3. Vì sao phải sửa code trước

Hai yêu cầu của user hiện **không** làm được bằng data thuần:

- `server/src/lib/claude-cli.ts:44-48` — mỗi step chạy `claude --mcp-config <run>/mcp.json
--strict-mcp-config`, mà `writeMcpConfig()` (`workflow-step-terminal.ts:52-72`) chỉ ghi đúng
  server `station`. `figma` / `figma-mcp-go` trong `~/.claude.json` bị cắt sạch.
- `workflow-runner.ts:379-383` — `agentName` của step chỉ được **kiểm tra tồn tại** rồi thôi. Ở
  terminal-mode, prompt/tools/`agents.model` của agent đều không được dùng, và không có flag
  `--model` nào được truyền. Không có đường nào khai "step này chạy haiku".

## 4. Phạm vi

### A. Sửa station (3 việc nhỏ)

**A1 — Merge MCP global vào mcp.json của run**

- `server/src/services/workflow-step-terminal.ts` → `writeMcpConfig()`: đọc `~/.claude.json`, lấy
  `mcpServers` top-level, merge vào dưới `station`. **`station` thắng khi trùng tên** — tool của
  workflow không được để máy ghi đè.
- File hỏng / không tồn tại / JSON lỗi → bỏ qua, chỉ log. Không được làm chết run.
- `chmod 600` cho `<run>/mcp.json`: nó sẽ chứa env của server global (ví dụ `FIGMA_API_KEY`).
  `data/` đã gitignore nên không rò ra git, nhưng quyền file vẫn phải siết.
- Giữ nguyên `--strict-mcp-config`: step nhận đúng station + server global, **không** nhận
  server scope-project của repo đang đứng.

**A2 — `model` cho từng step**

| File                                            | Sửa gì                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `server/drizzle/0023_step-model.sql`            | `ALTER TABLE workflow_steps ADD model text;` + 3 cột ở A3                                            |
| `server/drizzle/meta/_journal.json`             | đăng ký migration mới                                                                                |
| `server/src/db/schema.ts`                       | `model: text("model")` trong `workflowSteps`                                                         |
| `shared/src/types.ts`                           | `model: z.string().nullable().default(null)` ở `workflowStepSchema` **và** `workflowStepInputSchema` |
| `server/src/services/workflows.ts`              | 4 chỗ, đối xứng với `isolate`: map row→obj (~~:37), insert (~~:173), export yaml (~:399 và ~:405)    |
| `server/src/services/workflow-step-terminal.ts` | `terminalForStep` truyền `model: step.model` vào `createTerminal`                                    |
| `server/src/services/terminals.ts`              | `createTerminal` + `claudeCommand` nhận `model?: string`                                             |
| `server/src/lib/claude-cli.ts`                  | thêm `--model <alias>` khi có                                                                        |
| `web/src/features/workflows/WorkflowEditor.tsx` | select model cho step (mặc định "theo cài đặt")                                                      |

`null` = dùng model mặc định của máy — mọi workflow đang có chạy y như cũ.

**A3 — Giữ flag qua revive** (nếu không làm thì A1+A2 im lặng mất tác dụng sau khi restart server)

`terminals.command` để NULL với tab claude, nên `reviveTerminal` (`terminals.ts:281`) dựng lại lệnh
**không có** `--mcp-config`, `--permission-mode`. Tức step được hồi sinh mất sạch tool station —
lỗi đã có sẵn, và `--model` sẽ dính y hệt.

→ Thêm 3 cột vào `terminals`: `model`, `mcp_config_file`, `permission_mode`; `createTerminal` lưu,
`reviveTerminal` đọc lại và truyền vào `claudeCommand(true, …)`.

**Test:** `claude-cli.test.ts` thêm case `--model`; `workflow-step-terminal` thêm test merge MCP
(station thắng khi trùng tên, file hỏng thì không ném).

### B. Asset mới

**B1 — Agent `ui-design-checker`** (`model: haiku`, read-only): người chấm UI, không sửa code.
_Lưu ý thật thà:_ terminal-mode hiện bỏ qua definition của agent, nên agent này mới chỉ là khai
báo + điều kiện để run khởi động được. Model thật đến từ field `model` của step (A2).

**B2 — Workflow `impl-ios-ui-workflow`**, folder `ios`, file
`docs/workflows/impl-ios-ui-workflow.workflow.yaml` + import vào station.

### C. Không làm (ngoài phạm vi)

- Không đụng `impl-ios-workflow` đang chạy.
- Không nối agent definition (prompt/tools/model) vào terminal-mode — việc riêng, to hơn nhiều.
- Không có bước Jira: workflow này là vòng lặp UI, không phải vòng đời task. Bước `pr` có, Jira không.
- Không dùng XcodeBuildMCP / skill `/ios-debugger-agent`: server đó **không** có trong
  `~/.claude.json`, merge xong vẫn không có. Dùng `xcodebuild` + `xcrun simctl` qua Bash.

## 5. Hình dạng workflow

```
recon ──► impl ──► capture-compare ──► fix ──► ui-gate ──┬──► pr
                        ▲                                │
                        └────────────────────────────────┘ onFail (tối đa 3 vòng)
```

| key               | type  | model        | agent               | việc                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----- | ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recon`           | agent | _(mặc định)_ | `ios-dev`           | Đọc Figma node qua `mcp__figma__get_figma_data`; đọc DesignSystem + component sẵn có của repo; tìm cách mở thẳng màn (grep launch argument). Ra artifact `ui-spec.md`: **bảng Figma → token repo** cho từng màu/size/spacing/radius/font, component tái dùng được, giá trị Figma chưa có token → câu hỏi `workflow_ask`. `requiresConfirm`, `readOnly` |
| `impl`            | agent | _(mặc định)_ | `ios-dev`           | Dựng UI theo `ui-spec.md`. Cấm literal màu/size/spacing. `requiresConfirm`                                                                                                                                                                                                                                                                             |
| `capture-compare` | agent | **sonnet**   | `ui-design-checker` | build → `simctl install/launch` **kèm flag mở thẳng màn** → screenshot; `mcp__figma__download_figma_images` lấy ảnh node; so 2 ảnh theo checklist (thứ tự phần tử, spacing, cỡ chữ, màu, radius, state). Ghi verdict `MATCH`/`DIFF` + danh sách lệch ra `{{verdictFile}}`. **Không sửa code.** `readOnly`                                              |
| `fix`             | agent | **sonnet**   | `ios-dev`           | Sửa đúng danh sách lệch, không nhân tiện refactor. Chỗ nào cho là chấm sai thì ghi một dòng lý do                                                                                                                                                                                                                                                      |
| `ui-gate`         | gate  | —            | —                   | Chạy project command `{{gateCommand}}` (đọc verdict file). Fail → quay lại `capture-compare`. `maxLoops: 3`, `condition: inputs.gateCommand`                                                                                                                                                                                                           |
| `pr`              | agent | _(mặc định)_ | `ios-dev`           | Double-check diff, commit dưới tên user (không dấu vết AI), hỏi xác nhận rồi push + mở PR tiếng Việt kèm ảnh design ⨯ ảnh chụp thật                                                                                                                                                                                                                    |

**Vì sao người chấm phải là step riêng, model riêng:** con vừa viết UI tự chấm ảnh của nó thì lần
nào cũng "khớp rồi" — cùng lý do repo đã tách `review` khỏi `impl`. Và chính vòng lặp chụp-so-chấm
là phần lặp nhiều nhất, nên đó mới là chỗ đáng để model rẻ.

**Gate an toàn cho project chưa khai command:** `condition: inputs.gateCommand` → project nào không
điền thì gate **skip**, và instruction của `fix` mang sẵn phương án dự phòng (tự lặp tối đa 3 vòng
và đính screenshot mỗi vòng). Đúng cái bẫy `docs/workflows/README.md` đã cảnh báo.

### Inputs

| key            | type | bắt buộc | ghi chú                                                                 |
| -------------- | ---- | -------- | ----------------------------------------------------------------------- |
| `figmaUrl`     | text | ✓        | Link Figma của node/màn cần dựng (có `node-id`)                         |
| `screenLaunch` | text |          | Cách mở thẳng màn, vd `-BMScreen plan`. Trống → `recon` tự đi tìm       |
| `buildScheme`  | text |          | Scheme build, vd `BetterMe-DebugDev`. Trống → dùng project command      |
| `gateCommand`  | text |          | Tên project command cho gate, vd `ui-verdict`. Trống → gate skip        |
| `verdictFile`  | text |          | Mặc định `/tmp/ui-verdict.txt`. Để ngoài repo cho khỏi bẩn working tree |

## 6. Edge case

- **Figma node là frame rỗng / link không có `node-id`** → `recon` phải `workflow_ask`, không tự đoán màn.
- **Không có simulator booted** → báo và dừng; CLAUDE.md của repo iOS cấm `simctl boot`/`create`.
- **Không mở thẳng được màn** (repo chưa có launch flag) → `recon` ghi rõ, `capture-compare` điều
  hướng tay bằng `simctl` và nói rõ trong artifact là đã phải đi vòng.
- **Figma chỉ có light, repo có dark** → chấm trên light; dark ghi vào "chưa verify".
- **Lệch vì design chưa chốt** (đúng case ISI668: HealYoung ⨯ Luminous Longevity) → `recon` dừng
  hỏi trước, không tự đổi token của DesignSystem.
- **Server restart giữa run** → A3 giữ `--model`/`--mcp-config`; không có A3 thì vòng lặp lặng lẽ
  nhảy về model đắt.

## 7. Đã chốt (thay cho mục "cần confirm")

1. `capture-compare` chạy **sonnet** — user chốt, không dùng haiku.
2. `fix` **sonnet**; `recon` / `impl` / `pr` để **mặc định** (theo `~/.claude/settings.json`).
3. **Có** bước `pr` ở cuối, theo đúng khuôn của `impl-ios-workflow`: commit mang tên user, tuyệt đối
   không trailer `Co-Authored-By: Claude` hay dòng `Generated with Claude Code` (repo iOS ISI668 cấm
   thẳng trong `CLAUDE.md` §9), PR body tiếng Việt, kèm ảnh design ⨯ ảnh chụp thật.

## 8. Đã lệch so với plan (ghi lại vì plan là source of truth)

- `capture-compare` **không** gắn `readOnly` như plan viết ban đầu: nó chạy `xcodebuild` thật, khai
  là không chạm gì sẽ cho scheduler quyền xếp một step khác vào cùng repo.
- Gate không đọc tên command từ input được — `step.commandName` **không** qua `interpolate`
  (`workflow-runner.ts` resolve nó theo tên literal). Nên tên command cố định là `ui-verdict`, còn
  input `uiGate` chỉ là công tắc bật/tắt qua `condition`.
- Thêm một dọn dẹp nhỏ ngoài plan: `exportWorkflowYaml` đang lặp lại nguyên một cụm key
  (`dependsOn` / `onFail` / `maxLoops` / `cwdLabel` / `isolate`) do paste nhầm — xoá bản trùng.
- `workflow-library.test.ts` có một luật "step `impl`/`fix` phải kéo Jira In Progress → Resolved",
  áp cho MỌI workflow trong `docs/workflows/`. Workflow này cố ý không đụng Jira, nên luật được siết
  lại đúng phạm vi của nó: chỉ áp cho workflow thật sự có dùng Jira (có step `jira-pm` hoặc có input
  kiểu `jira-*`). Bắt một workflow không mở board phải nói "In Progress" là bắt nó nói dối.

## 9. Sửa sau run thật đầu tiên (2026-09-17)

Run `mu5as4qx` chết ở `ui-gate`: `No command named "ui-verdict" in this project`. Chữa cả triệu
chứng lẫn nguyên nhân:

1. **Thêm command `ui-verdict`** cho path `IOS source` của `isi668-betterme-ios`. Nó đọc
   `${UI_VERDICT_FILE:-/tmp/ui-verdict.txt}`, và có hai cái chặn mà bản trong README chưa có:
   verdict cũ hơn 6 tiếng bị từ chối (một `MATCH` cũ lọt qua = PR mở trên một màn chưa ai nhìn), và
   `BLOCKED` được nói rõ là "lặp lại không giải quyết được".
2. **`BLOCKED` tách khỏi `DIFF`.** Run này ghi `DIFF` cho một tình huống _không chấm được_ (không có
   simulator booted) — gate sẽ đá về 3 vòng mà vòng nào cũng chặn ở đúng chỗ đó. Ranh giới mới:
   `DIFF` = lặp lại sẽ sửa được (kể cả build đỏ); `BLOCKED` = lặp bao nhiêu cũng thế ⇒ `workflow_ask`
   dừng trước mặt người. Step `fix` gặp `BLOCKED` thì KHÔNG sửa mò.
3. **Preflight dời lên `recon`.** Thiếu simulator booted, hoặc bật gate mà project chưa có command
   `ui-verdict` → hỏi ngay ở step 1, thay vì phát hiện ở step 5 sau khi đã impl xong.
4. **Xoá verdict file ở đầu `capture-compare`**, để verdict lần trước không bị đọc thành kết quả
   lần này.
5. `figmaUrl` nhận nhiều link (user dán 4 màn một lúc ngay lần chạy đầu).

Định nghĩa của một run được snapshot lúc bắt đầu (`workflow_runs.definition`), nên 4 thay đổi trên
KHÔNG áp vào run đang dở — chúng áp cho run sau.
