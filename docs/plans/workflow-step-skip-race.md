# Workflow bị "skip step" khi rời tab / restart app

## Bối cảnh

Run thật đã dính lỗi: `muc63i2x-4d9b6669-1a5` (`impl-android-parity-workflow`, project Android Remoria).

Graph là một chuỗi tuyến tính sạch:

```
study-spec → study-be → study-ios → plan → confirm-plan → impl → test → {parity-check, review} → fix-review → pr
```

Trạng thái trong DB sau khi run `failed`:

| step | status | attempt | maxRetries | started_at | finished_at |
|---|---|---|---|---|---|
| confirm-plan | done | 1 | 0 | 04:59:27 | 04:59:45 |
| **impl** | **pending** | **12** | **0** | 07:01:25 | **NULL** |
| test | pending | 1 | 1 | 07:03:50 | NULL |
| parity-check | pending | 1 | 0 | 07:04:08 | NULL |
| review | pending | 1 | 0 | 07:04:09 | NULL |
| fix-review | pending | 1 | 0 | 08:05:35 | NULL |
| pr | failed | 1 | 0 | 08:05:48 | 08:07:20 |

Hai điều không thể xảy ra nếu engine đúng:

1. `impl` có `maxRetries=0`. `settleStep` chỉ đưa step về `pending` khi `attempt <= step.maxRetries`, tức không bao giờ. Vậy `attempt=12` **chỉ có thể** đến từ `retryStep()`.
2. `test` phụ thuộc `impl`. `readySteps` đòi dependency ∈ {done, skipped}. Vậy mà `test` có `started_at` trong khi `impl` chưa bao giờ `finished`.

Kết luận: `impl` đã bị đánh dấu xong bởi một outcome **cũ**, engine đi tiếp, rồi retry đẩy nó về `pending` — nhưng đoàn tàu đã chạy. Đúng triệu chứng người dùng mô tả.

## Nguyên nhân gốc

### R1 — Outcome cũ ghi đè trạng thái mới (`workflow-runner.ts`)

`advanceRun` capture `attempt` **trước** khi `await runAgentStep(...)`, một turn dài hàng chục phút:

```ts
const rs = run.runSteps.find((r) => r.stepKey === step.key);
const attempt = rs?.attempt ?? 1;
const result = await runAgentStep(run, step, index, attempt);   // ← nhiều phút
...
settleStep(after, step, attempt, result);
```

Trong lúc `await`, `retryStep` / `skipStep` / `restartRun` đổi trạng thái step trong DB. Khi turn cũ về đích, `settleStep` gọi `upsertRunStep(..., { status: "done" })` — và `upsertRunStep` là ghi đè mù, **không có guard nào** so `attempt` hay generation. Turn cũ thắng.

Hệ quả: bấm Retry → turn cũ kết thúc → step bị đánh `done` → engine dispatch step kế → **step retry không bao giờ chạy**.

### R2 — `advanceRun` nuốt yêu cầu advance (`workflow-runner.ts:887`)

```ts
if (advancing.has(runId)) return getRun(runId)!;
```

Guard giữ suốt vòng lặp dispatch, tức suốt cả turn. Mọi `void advanceRun(runId)` phát ra từ `retryStep` (:1317), `continueStep` (:1412), `skipStep` (:1444), `restartRun` (:1456), `answer` (:1279) trong khoảng đó **bị bỏ im lặng**. Comment ở hàm nói "Safe to call twice: the second call returns while the first is still working" — an toàn thật, nhưng yêu cầu bị mất, không được chạy lại.

### R3 — `reconcileRunsOnBoot`: biến đếm toàn cục dùng như cờ per-run (`workflow-runner.ts:1510-1540`)

```ts
let touched = 0;
for (const run of stale) {
  for (const step of steps) { ...; touched += 1; }
  if (touched > 0) {                       // ← touched cộng dồn qua mọi run
    db.update(schema.workflowRuns).set({ status: "awaiting_input" })...
  }
}
```

Run đầu tiên có step đang chạy làm `touched > 0`; **mọi run sau đó** trong danh sách bị đẩy sang `awaiting_input` dù không có step nào thật sự mid-flight. Đây chính là phần "thoát app ra rồi mở lại thì run loạn".

### R4 — `skipStep` không kiểm tra gì (`workflow-runner.ts:1448`)

```ts
export function skipStep(runId, stepKey) {
  upsertRunStep(runId, stepKey, { status: "skipped", ... });
  void advanceRun(runId);
}
```

Skip được một step đang `running` mà không interrupt turn của nó (khác hẳn `cancelRun`, có gọi `interrupt`). Turn cũ vẫn chạy rồi ghi đè `skipped` → `done` (R1). Nút Skip ở `RunView.tsx:404-413` cũng **không có confirm**, trong khi "Chạy lại từ đầu" thì có (`RunView.tsx:242`).

## Phạm vi

Chỉ sửa engine + guard. **Không** đụng vào heuristic đọc màn hình (`claude-screen.ts`), không đụng `pty-manager`, không đổi UI ngoài nút Skip.

## Các bước

1. **Generation guard cho step** — `server/src/services/workflow-runner.ts`
   - `settleStep` nhận thêm `attempt` đã capture; trước khi ghi, đọc lại `stepRow` và **bỏ qua outcome** nếu `stepRow.attempt !== attempt` hoặc `stepRow.status` không còn là `running`. Ghi log + `emit` để người dùng thấy "outcome cũ bị loại".
   - Đây là fix lõi: nó chặn cả R1 lẫn hệ quả của R4.

2. **`advanceRun` không được nuốt yêu cầu** — cùng file
   - Đổi `advancing: Set<string>` thành cờ 2 trạng thái: đang chạy + có yêu cầu chờ (`rerun`). Khi loop hiện tại kết thúc, nếu có yêu cầu chờ thì chạy thêm một vòng.

3. **`skipStep` phải interrupt turn đang chạy** — cùng file
   - Nếu step đang `running` và có `sessionId` còn sống → `await interrupt(...)` như `cancelRun` làm, rồi mới đánh `skipped`. Hàm chuyển thành `async`, cập nhật route `workflows.ts`.

4. **`reconcileRunsOnBoot` đếm theo từng run** — cùng file
   - Thay `touched` bằng biến cục bộ trong vòng lặp run; vẫn trả về tổng để `index.ts` log.

5. **Confirm cho nút Skip** — `web/src/features/workflows/RunView.tsx`
   - Dùng `useConfirm` sẵn có, cùng kiểu với "Chạy lại từ đầu".

6. **Test** — `server/src/services/__tests__/`
   - Outcome cũ (attempt lệch) không ghi đè trạng thái mới.
   - `advanceRun` gọi trong lúc đang bận → chạy lại một vòng sau đó.
   - `reconcileRunsOnBoot`: run không có step mid-flight giữ nguyên status.
   - `readySteps` không dispatch step khi dependency đang `pending` (regression cho chính ca này).

7. **Docs** — `docs/workflows/README.md`: ghi lại luật "outcome của turn cũ bị loại theo attempt" và hành vi mới của Skip.

## Edge case

- Step `gate` có vòng lặp `loops` riêng (`settleGate`) — guard theo `attempt` phải không phá loop-back của gate.
- `restartRun` đặt `attempt: 1`; guard phải coi đó là generation mới, không phải trùng với attempt 1 cũ. Cần một cột generation riêng, hoặc so cả `(attempt, startedAt)`. **Chọn: thêm cột `generation` tăng đơn điệu** — an toàn hơn so ghép.
- Parallel batch (`workflows.maxParallel` mặc định 2): guard áp per-step nên không ảnh hưởng.

## Đã chốt (2026-09-22)

1. **Thêm cột `generation`** vào `workflow_run_steps` + migration drizzle mới. `settleStep` chỉ ghi khi generation khớp; lệch thì loại outcome và `emit` cho người dùng thấy.
2. Run `muc63i2x-4d9b6669-1a5`: **restart resume** sau khi sửa — giữ 5 step study/plan đã xong, chạy lại từ `impl`.
3. Nút Skip: **thêm confirm**, cùng kiểu với "Chạy lại từ đầu".
