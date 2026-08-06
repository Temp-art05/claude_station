import yaml from "js-yaml";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_PRESETS, workflowInputSchema, type Workflow } from "@claude-station/shared";

// Export is pure; import writes to the DB, so only the export side is unit-tested
// here and the round-trip is checked by re-parsing with the same schema.
vi.mock("../../db", () => ({ db: {}, schema: {} }));

const { exportWorkflowYaml } = await import("../workflows");

function asWorkflow(preset: (typeof WORKFLOW_PRESETS)[number]): Workflow {
  return {
    id: "w1",
    name: preset.name,
    description: preset.description,
    folder: preset.folder,
    source: "manual",
    createdAt: "now",
    updatedAt: "now",
    steps: preset.steps.map((s, i) => ({ ...s, id: `s${i}`, workflowId: "w1", sortOrder: i })),
  };
}

describe("exportWorkflowYaml", () => {
  it("round-trips every preset back through the input schema", () => {
    for (const preset of WORKFLOW_PRESETS) {
      const text = exportWorkflowYaml(asWorkflow(preset));
      const parsed = workflowInputSchema.parse(yaml.load(text));

      expect(parsed.name).toBe(preset.name);
      expect(parsed.folder).toBe(preset.folder);
      expect(parsed.steps.map((s) => s.key)).toEqual(preset.steps.map((s) => s.key));
      expect(parsed.steps.map((s) => s.type)).toEqual(preset.steps.map((s) => s.type));
      expect(parsed.steps.map((s) => s.agentName)).toEqual(preset.steps.map((s) => s.agentName));
      expect(parsed.steps.map((s) => s.condition)).toEqual(preset.steps.map((s) => s.condition));
      expect(parsed.steps.map((s) => s.maxRetries)).toEqual(preset.steps.map((s) => s.maxRetries));
      expect(parsed.steps.map((s) => s.requiresConfirm)).toEqual(
        preset.steps.map((s) => s.requiresConfirm),
      );
    }
  });

  it("keeps per-step permissionMode — the whole point of unattended steps", () => {
    const ios = WORKFLOW_PRESETS.find((p) => p.name === "ios-feature")!;
    const parsed = workflowInputSchema.parse(yaml.load(exportWorkflowYaml(asWorkflow(ios))));
    const impl = parsed.steps.find((s) => s.key === "impl-fe");
    const plan = parsed.steps.find((s) => s.key === "plan");
    expect(impl?.permissionMode).toBe("acceptEdits");
    expect(plan?.permissionMode).toBe("default");
  });

  it("omits fields that are unset instead of writing nulls", () => {
    const text = exportWorkflowYaml(
      asWorkflow({
        label: "x",
        name: "minimal",
        description: "",
        folder: "",
        steps: [
          {
            key: "only",
            type: "manual",
            title: "Do the thing",
            agentName: null,
            instruction: null,
            commandName: null,
            requiresConfirm: false,
            permissionMode: null,
            maxRetries: 0,
            condition: null,
          },
        ],
      }),
    );
    expect(text).not.toContain("agentName");
    expect(text).not.toContain("condition");
    expect(text).not.toContain("null");
  });
});
