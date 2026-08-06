import { and, asc, eq } from "drizzle-orm";
import yaml from "js-yaml";
import {
  workflowInputSchema,
  type Workflow,
  type WorkflowInput,
  type WorkflowStep,
} from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";

type WorkflowRow = typeof schema.workflows.$inferSelect;
type StepRow = typeof schema.workflowSteps.$inferSelect;

function toStep(row: StepRow): WorkflowStep {
  return {
    id: row.id,
    workflowId: row.workflowId,
    sortOrder: row.sortOrder,
    key: row.key,
    type: row.type as WorkflowStep["type"],
    title: row.title,
    agentName: row.agentName,
    instruction: row.instruction,
    commandName: row.commandName,
    requiresConfirm: row.requiresConfirm,
    permissionMode: row.permissionMode as WorkflowStep["permissionMode"],
    maxRetries: row.maxRetries,
    condition: row.condition,
  };
}

function stepsOf(workflowId: string): WorkflowStep[] {
  return db
    .select()
    .from(schema.workflowSteps)
    .where(eq(schema.workflowSteps.workflowId, workflowId))
    .orderBy(asc(schema.workflowSteps.sortOrder))
    .all()
    .map(toStep);
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folder: row.folder,
    source: row.source === "imported" ? "imported" : "manual",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    steps: stepsOf(row.id),
  };
}

export function listWorkflows(folder?: string): Workflow[] {
  return db
    .select()
    .from(schema.workflows)
    .orderBy(asc(schema.workflows.folder), asc(schema.workflows.name))
    .all()
    .filter((r) => folder === undefined || r.folder === folder)
    .map(toWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
  return row ? toWorkflow(row) : null;
}

/** Step keys are how conditions and run bookkeeping refer to steps, so enforce uniqueness. */
function assertUniqueKeys(input: WorkflowInput): void {
  const seen = new Set<string>();
  for (const step of input.steps) {
    if (seen.has(step.key)) throw badRequest(`Duplicate step key "${step.key}"`);
    seen.add(step.key);
  }
  for (const step of input.steps) {
    if (step.type === "agent" && !step.agentName) {
      throw badRequest(`Step "${step.key}" is an agent step but names no agent`);
    }
    if (step.type === "command" && !step.commandName) {
      throw badRequest(`Step "${step.key}" is a command step but names no command`);
    }
  }
}

function writeSteps(workflowId: string, input: WorkflowInput): void {
  const now = nowIso();
  input.steps.forEach((step, i) => {
    db.insert(schema.workflowSteps)
      .values({
        id: newId(),
        workflowId,
        sortOrder: i,
        key: step.key,
        type: step.type,
        title: step.title,
        agentName: step.agentName,
        instruction: step.instruction,
        commandName: step.commandName,
        requiresConfirm: step.requiresConfirm,
        permissionMode: step.permissionMode,
        maxRetries: step.maxRetries,
        condition: step.condition,
        createdAt: now,
      })
      .run();
  });
}

export function createWorkflow(
  input: WorkflowInput,
  source: "manual" | "imported" = "manual",
): Workflow {
  assertUniqueKeys(input);
  const clash = db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.name, input.name))
    .get();
  if (clash) throw badRequest(`A workflow named "${input.name}" already exists`);

  const id = newId();
  const now = nowIso();
  db.transaction(() => {
    db.insert(schema.workflows)
      .values({
        id,
        name: input.name,
        description: input.description,
        folder: input.folder,
        source,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    writeSteps(id, input);
  });
  return getWorkflow(id)!;
}

export function updateWorkflow(id: string, input: WorkflowInput): Workflow {
  assertUniqueKeys(input);
  const existing = db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
  if (!existing) throw badRequest("Workflow not found");
  if (input.name !== existing.name) {
    const clash = db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.name, input.name))
      .get();
    if (clash) throw badRequest(`A workflow named "${input.name}" already exists`);
  }

  // Steps are edited as one list, so replace them wholesale in a transaction:
  // a rejected step must not leave the workflow half-rewritten.
  db.transaction(() => {
    db.update(schema.workflows)
      .set({
        name: input.name,
        description: input.description,
        folder: input.folder,
        updatedAt: nowIso(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
    db.delete(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, id)).run();
    writeSteps(id, input);
  });
  return getWorkflow(id)!;
}

export function deleteWorkflow(id: string): void {
  db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
}

export function setWorkflowFolder(id: string, folder: string): void {
  const existing = db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
  if (!existing) throw badRequest("Workflow not found");
  db.update(schema.workflows)
    .set({ folder, updatedAt: nowIso() })
    .where(eq(schema.workflows.id, id))
    .run();
}

export function listWorkflowFolders(): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of db.select().from(schema.workflows).all()) {
    counts.set(row.folder, (counts.get(row.folder) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => (a.folder === "" ? 1 : b.folder === "" ? -1 : a.folder.localeCompare(b.folder)));
}

// ── Project import ────────────────────────────────────────────────────────────

export function listProjectWorkflows(projectId: string): Workflow[] {
  const importedIds = new Set(
    db
      .select()
      .from(schema.projectWorkflows)
      .where(eq(schema.projectWorkflows.projectId, projectId))
      .all()
      .map((r) => r.workflowId),
  );
  return listWorkflows().map((w) => ({ ...w, imported: importedIds.has(w.id) }));
}

export function importWorkflowsToProject(
  projectId: string,
  opts: { workflowIds?: string[]; folder?: string },
): number {
  const ids =
    opts.folder !== undefined
      ? listWorkflows(opts.folder).map((w) => w.id)
      : (opts.workflowIds ?? []);
  let added = 0;
  db.transaction(() => {
    for (const workflowId of ids) {
      const exists = db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.id, workflowId))
        .get();
      if (!exists) continue;
      const already = db
        .select()
        .from(schema.projectWorkflows)
        .where(
          and(
            eq(schema.projectWorkflows.projectId, projectId),
            eq(schema.projectWorkflows.workflowId, workflowId),
          ),
        )
        .get();
      if (already) continue;
      db.insert(schema.projectWorkflows).values({ id: newId(), projectId, workflowId }).run();
      added += 1;
    }
  });
  if (added > 0) {
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId,
        kind: "workflow_imported",
        refId: null,
        summary: `Imported ${added} workflow(s)${opts.folder !== undefined ? ` from folder "${opts.folder || "unfiled"}"` : ""}`,
        createdAt: nowIso(),
      })
      .run();
  }
  return added;
}

export function removeWorkflowFromProject(projectId: string, workflowId: string): void {
  db.delete(schema.projectWorkflows)
    .where(
      and(
        eq(schema.projectWorkflows.projectId, projectId),
        eq(schema.projectWorkflows.workflowId, workflowId),
      ),
    )
    .run();
}

// ── Portable YAML ─────────────────────────────────────────────────────────────

/** Round-trips through `workflowInputSchema`, so an export always re-imports. */
export function exportWorkflowYaml(workflow: Workflow): string {
  return yaml.dump(
    {
      name: workflow.name,
      description: workflow.description,
      folder: workflow.folder,
      steps: workflow.steps.map((s) => ({
        key: s.key,
        type: s.type,
        title: s.title,
        ...(s.agentName ? { agentName: s.agentName } : {}),
        ...(s.commandName ? { commandName: s.commandName } : {}),
        ...(s.instruction ? { instruction: s.instruction } : {}),
        ...(s.requiresConfirm ? { requiresConfirm: true } : {}),
        ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
        ...(s.maxRetries ? { maxRetries: s.maxRetries } : {}),
        ...(s.condition ? { condition: s.condition } : {}),
      })),
    },
    { lineWidth: 100, noRefs: true },
  );
}

/**
 * Render a workflow as a "runbook" prompt for an interactive claude terminal.
 * The engine's stepper is replaced by the conversation itself: the CLI session
 * announces each step, pauses on ⏸ steps, and the user steers by chatting
 * (skip a step, change course, answer questions inline).
 */
export function renderWorkflowRunbook(
  workflow: Workflow,
  goal?: string,
  /** Set for terminal-mode runs: the session curls step transitions back to the stepper. */
  progress?: { runId: string },
): string {
  const steps = workflow.steps
    .map((s, i) => {
      const gate = s.requiresConfirm ? " ⏸ (dừng chờ tôi duyệt xong step này rồi mới đi tiếp)" : "";
      const head = `### Step ${i + 1}/${workflow.steps.length} — [${s.key}] ${s.title}${gate}`;
      const meta =
        s.type === "command" && s.commandName
          ? `Chạy command của project: \`${s.commandName}\` (dùng run_project_command nếu có, không thì chạy trực tiếp).`
          : s.type === "manual"
            ? "Step thủ công: nhắc tôi làm, chờ tôi báo xong rồi mới đi tiếp."
            : "";
      return [head, meta, s.instruction ?? ""].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return [
    `Chạy workflow **${workflow.name}** ngay trong phiên này, chế độ tương tác (dynamic).`,
    ...(workflow.description ? [`> ${workflow.description}`] : []),
    "",
    "## Goal",
    goal?.trim() || "(chưa nhập — hỏi tôi goal trước khi bắt đầu step 1)",
    "",
    "## Các step",
    steps,
    "",
    "## Luật điều khiển (quan trọng)",
    "- Trước khi BẮT ĐẦU mỗi step: in một dòng `▶ Step k/n — <title>` + 1-2 câu bạn sắp làm gì.",
    "- Kết thúc step: tóm tắt kết quả (file đã tạo/sửa, kết luận). Step có ⏸ thì DỪNG HẲN, chờ tôi trả lời rồi mới sang step sau.",
    "- Câu hỏi cần tôi chốt → hỏi thẳng trong chat và chờ; không tự đoán.",
    "- Tôi có thể điều khiển bằng chat bất cứ lúc nào: \"bỏ qua step X\", \"quay lại step Y\", \"sửa yêu cầu: …\", \"đang ở step nào?\" — làm theo và xác nhận lại kế hoạch.",
    "- Chỉ làm việc của step đang chạy; không tự ý gộp/nhảy step trừ khi tôi bảo.",
    "- Instruction có thể nhắc các tool `workflow_ask` / `workflow_emit_artifact` / `workflow_note` (chỉ có ở chế độ engine). Trong phiên này quy đổi: workflow_ask = hỏi tôi trực tiếp trong chat; workflow_emit_artifact = ghi ra file và nói rõ đường dẫn; workflow_note = in một dòng tóm tắt.",
    ...(progress
      ? [
          "",
          "## Báo tiến độ cho stepper (BẮT BUỘC — station đang hiển thị các step của run này phía trên terminal)",
          "Mỗi lần một step đổi trạng thái, chạy lệnh Bash sau (thay `<key>` và `<status>`):",
          "```bash",
          `curl -s -X POST "$CLAUDE_STATION_URL/api/workflow-runs/${progress.runId}/terminal-progress" \\`,
          `  -H "x-cs-token: $CLAUDE_STATION_TOKEN" -H 'Content-Type: application/json' \\`,
          `  -d '{"step":"<key>","status":"<status>"}'`,
          "```",
          '- Bắt đầu làm một step → `"status":"running"`. Xong → `"done"`. Tôi bảo bỏ qua → `"skipped"`. Bế tắc/dừng vì lỗi → `"failed"` (thêm `"note":"lý do ngắn"`).',
          "- Gọi NGAY tại thời điểm chuyển trạng thái, đừng dồn về cuối. Hai biến env `$CLAUDE_STATION_URL` / `$CLAUDE_STATION_TOKEN` đã được set sẵn trong terminal này.",
        ]
      : []),
  ].join("\n");
}

/** Imports never fail on a name clash — they get a -2/-3 suffix instead. */
export function uniqueWorkflowName(base: string): string {
  const taken = new Set(db.select().from(schema.workflows).all().map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function importWorkflowYaml(contents: string, filename?: string): Workflow {
  return importWorkflowYamlDetailed(contents, filename).workflow;
}

export function importWorkflowYamlDetailed(
  contents: string,
  filename?: string,
): { workflow: Workflow; renamedFrom: string | null } {
  let parsed: unknown;
  try {
    parsed = yaml.load(contents);
  } catch (err) {
    throw badRequest(`Not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw badRequest("Empty workflow file");

  const raw = parsed as Record<string, unknown>;
  if (!raw.name && filename) {
    raw.name = filename
      .replace(/\.(workflow\.)?(ya?ml|json)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const result = workflowInputSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(
      `Invalid workflow: ${first ? `${first.path.join(".")} — ${first.message}` : "unknown field"}`,
    );
  }
  const requested = result.data.name;
  const finalName = uniqueWorkflowName(requested);
  const workflow = createWorkflow({ ...result.data, name: finalName }, "imported");
  return { workflow, renamedFrom: finalName === requested ? null : requested };
}
