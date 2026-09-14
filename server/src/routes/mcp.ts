import type { FastifyInstance } from "fastify";
import { z as zod } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { stationMcpServer } from "../mcp/server";
import { badRequest } from "../lib/path-safety";

/**
 * The same tools, reachable from outside this process.
 *
 * A workflow step now runs in a real `claude` terminal rather than an in-process
 * SDK session, and that CLI cannot load an in-process MCP server. Rather than
 * write the tools a second time for it — two implementations of "create a Jira
 * issue" is how they drift — a thin stdio bridge proxies every call back here,
 * where the single implementation lives.
 *
 * The tool list is derived from the very same server object the SDK sessions get,
 * so a tool added for one surface exists on the other by construction.
 */

/** The SDK's McpServer keeps its registry here; nothing public exposes it. */
interface RegisteredTool {
  description?: string;
  inputSchema?: unknown;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

function registry(projectId: string, sessionId: string, stepId: string | null) {
  const server = stationMcpServer(projectId, sessionId, stepId);
  const instance = server.instance as unknown as {
    _registeredTools?: Record<string, RegisteredTool>;
  };
  const tools = instance._registeredTools;
  if (!tools) {
    throw badRequest("This build of the agent SDK does not expose its tool registry");
  }
  return tools;
}

export function mcpRoutes(app: FastifyInstance): void {
  const scope = zod.object({
    projectId: zod.string().min(1),
    sessionId: zod.string().min(1).default("bridge"),
    /** Set while a workflow step is running — what unlocks the workflow tools. */
    runStepId: zod.string().nullable().default(null),
    /**
     * A bridge lives as long as the terminal, which outlives any one step, so it
     * passes the run and the current step is resolved here. Passing the step id
     * at spawn would pin the CLI to whichever step happened to be first.
     */
    runId: zod.string().nullable().default(null),
  });

  /** Whichever step of this run is running now — that is the one asking. */
  const currentStep = (runId: string | null, given: string | null): string | null => {
    if (given) return given;
    if (!runId) return null;
    const rows = db
      .select()
      .from(schema.workflowRunSteps)
      .where(eq(schema.workflowRunSteps.runId, runId))
      .all();
    return (
      rows.find((r) => r.status === "running")?.id ??
      rows.find((r) => r.status === "awaiting_input")?.id ??
      null
    );
  };

  /** What the bridge advertises to the CLI. */
  app.get("/api/mcp/tools", async (req) => {
    const { projectId, sessionId, runStepId, runId } = scope.parse(req.query ?? {});
    const tools = registry(projectId, sessionId, currentStep(runId, runStepId));
    return {
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: t.description ?? "",
        inputSchema: t.inputSchema
          ? zod.toJSONSchema(t.inputSchema as zod.ZodType)
          : { type: "object", properties: {} },
      })),
    };
  });

  /**
   * One call. Errors come back as a tool result rather than an HTTP error: a
   * failed tool is something the agent should read and react to, not something
   * that should look like the bridge itself broke.
   */
  app.post("/api/mcp/call", async (req) => {
    const { projectId, sessionId, runStepId, runId, tool, args } = scope
      .extend({
        tool: zod.string().min(1),
        args: zod.record(zod.string(), zod.unknown()).default({}),
      })
      .parse(req.body);

    const entry = registry(projectId, sessionId, currentStep(runId, runStepId))[tool];
    if (!entry) throw badRequest(`No tool named "${tool}"`);

    try {
      return await entry.handler(args, { signal: new AbortController().signal });
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });
}
