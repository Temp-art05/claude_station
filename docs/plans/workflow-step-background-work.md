# Step bị đánh `done` khi còn việc chạy nền, và step sau không đẩy được về

## Bối cảnh

Run `mudjshot-1adcd31d-525` (`impl-android-parity-workflow`, Remoria Android):

| step                | status  | started  | finished | note                                                        |
| ------------------- | ------- | -------- | -------- | ----------------------------------------------------------- |
| impl                | done    | 07:38:08 | 07:48:16 | "…Đang chạy 4 lát cắt UI song song … sẽ merge + build lại." |
| test                | done    | 07:48:16 | 07:49:05 | (49 giây)                                                   |
| parity-check        | done    | 07:49:05 | 07:54:34 | "CHƯA chấm — impl vẫn đang ghi … session impl còn sống"     |
| review / fix-review | done    |          |          |                                                             |
| pr                  | running |          |          | tự quyết "đợi impl xong", không tạo PR                      |

Lúc này terminal của `impl` (`cs-mudsjooa-308aed93-197`) vẫn đang làm:

```
✻ Waiting for 2 background agents to finish
❯
  ⏵⏵ bypass permissions on · 1 monitor · ← 2 agents · ↓ to manage
  ◯ fork  Rewriting SettingsViewModel for reengage toggle        11m 22s
  ◯ fork  Writing WelcomeStep, ValuePropsStep, PersonalizeStep   11m 5s
```

## Nguyên nhân gốc

### R1 — Engine coi "composer rảnh" là hết turn, kể cả khi còn agent chạy nền

`runTurnInTerminal` (`server/src/services/workflow-step-terminal.ts`) trả `ok: true` ngay khi
`sawWork && isComposerReady(screen)` và `!isBusy(screen)`. Khi agent chính spawn subagent chạy nền
rồi ngồi chờ, CLI hiện `✻ Waiting for N background agents to finish` với composer `❯` rảnh và dòng
`bypass permissions on` → khớp `COMPOSER`, không khớp `BUSY`
(`server/src/lib/claude-screen.ts:18,39`). Step bị chấm xong khi mới làm được nền `:data`.

### R2 — Step agent không có cách nói "chưa xong / sai", step sau không có cách đẩy về

Kết quả của step agent chỉ đến từ màn hình: turn kết thúc = `ok`. MCP chỉ có `workflow_ask`,
`workflow_emit_artifact`, `workflow_note` (`server/src/mcp/server.ts`). Nên `test` và `parity-check`
thấy rõ impl chưa xong nhưng chỉ ghi được một **note**, rồi vẫn bị đánh `done`. Vòng lặp quay về
(`onFail` + `settleGate`) chỉ tồn tại cho step `gate` chạy command.

## Phạm vi

- **A** (sửa R1): nhận diện "còn agent chạy nền" là đang bận.
- **B** (sửa R2): tool `workflow_step_result` cho agent tự báo kết quả; step có `onFail` thì báo
  fail sẽ đẩy run về step đó, dùng lại đúng luật vòng lặp của gate.
- Không đụng: pty-manager, UI (ngoài hiển thị lý do đã có sẵn), định nghĩa workflow trong repo
  khác ngoài phần docs mẫu.

## Các bước

1. **A — marker việc nền** — `server/src/lib/claude-screen.ts`
   - Thêm `hasBackgroundAgents(screen)`: dòng `Waiting for N background agent(s) to finish` là
     **dòng tin nhắn cuối cùng** trên màn (sau nó không còn dòng `⏺` nào, trừ dòng thông báo
     `⏺ Agent "…" finished`). Dòng cũ còn nằm trong scrollback sau khi agent chính viết tiếp thì
     không tính.
   - **Không** dùng footer `← N agents`: màn hình vừa mở của CLI (test `READY_PANE`) cũng có
     `2 agents` ở footer, nên footer không nói gì về việc đang chạy.
   - `runTurnInTerminal`: nếu `hasBackgroundAgents` → coi như `isBusy` (đặt `sawWork`, `continue`).
     Timeout của turn giữ nguyên, nên agent nền treo vẫn dừng ở deadline như cũ.
   - Chỉ tính **agent**, không tính background shell / `monitor`: shell nền thường là emulator,
     dev server — không bao giờ tự tắt, tính vào thì mọi step có emulator sẽ treo tới timeout.
2. **B — tool `workflow_step_result`** — `server/src/mcp/server.ts`, `workflow-runner.ts`
   - Tham số: `{ status: "done" | "failed", reason: string }`. Giữ **trong bộ nhớ** (Map theo
     `runStepId`, kèm `generation` lúc gọi) giống `pendingAsks` — không cần migration: báo cáo chỉ
     có nghĩa với turn đang được `await`, mà turn đó mất theo server khi restart. `settleStep` chỉ
     đọc báo cáo có generation khớp, rồi xoá.
   - `settleStep`: turn `ok` nhưng agent đã báo `failed` → xử lý như `ok: false` với
     `error = reason`.
   - Step agent khai `onFail: <key>` → failed đi qua `settleGate` (tách phần chung ra): reset
     `<key>` + mọi step phía sau về `pending`, đếm `loops`, phanh `maxLoops` (mặc định 3) và phanh
     "hai vòng cùng lý do". Step bị đẩy về giữ session, prompt retry kèm lý do của step đã đẩy nó về.
   - Không khai `onFail` → như fail thường (`maxRetries`, rồi fail run).
   - Lời nhắc trong system prompt của step (chỗ `server.ts:87`): "Chưa xong hoặc kiểm thấy sai thì
     gọi `workflow_step_result` failed kèm lý do — đừng kết thúc turn như thể đã xong. Đừng kết thúc
     turn khi còn agent nền."
3. **Docs** — `docs/workflows/README.md`: mục mới "Step tự báo kết quả và đẩy về"; cập nhật dòng
   ngôn ngữ step (`onFail` giờ dùng được cho step agent).
4. **Test** — `server/src/lib/__tests__/claude-screen.test.ts`, `server/src/services/__tests__/`
   - Màn hình mẫu ở trên → `hasBackgroundAgents` true; màn không có agent nền → false.
   - `runTurnInTerminal` không trả ok khi còn agent nền (theo kiểu test hiện có).
   - `settleStep`: báo `failed` + `onFail` → target và downstream về `pending`, `loops+1`; vượt cap
     → fail run; không `onFail` → nhánh retry/fail thường.
   - Generation guard vẫn chặn kết quả cũ.

## Edge case

- Khoảnh khắc giữa `⏺ Agent "…" finished` và lúc agent chính chạy lại: vẫn tính là còn việc nền
  (dòng thông báo không phải lời kết của agent chính), nên không chốt nhầm trong 1 giây đó.
- Agent gọi `workflow_step_result` nhiều lần trong một turn → lấy lần cuối.
- `test` và `parity-check` chạy song song / sau nhau cùng đẩy về `impl`: lần đẩy thứ hai gặp
  generation đã bump → bị loại như luật hiện có.

## Đã chốt (2026-09-23)

1. Làm cả A + B.
2. Thêm `onFail: impl` cho `test` và `parity-check` của workflow `impl-android-parity-workflow`
   (sửa trong DB qua API/editor sau khi server có bản mới — validation hiện tại còn chặn `onFail`
   ở step agent, `server/src/services/workflows.ts:135`, nên bước này phải chạy sau code).
3. Bỏ chặn đó: `onFail` hợp lệ cho `gate` và `agent`; step `command`/`confirm` vẫn không.

## Run đang dở (không cần code)

Đợi terminal `impl` hết agent nền và merge xong, rồi bấm **Retry** ở step `impl` — `retryStep` đưa
`impl` và mọi step sau về `pending`, turn mới vào đúng session cũ nên agent biết nó đã làm gì.
