#!/usr/bin/env node
/**
 * The station's tools, for a `claude` CLI that runs outside the app's process.
 *
 * A workflow step runs in a real terminal so you can watch it, and that CLI
 * cannot load an in-process MCP server. This bridge is deliberately dumb: it
 * advertises whatever the app says it has and forwards every call back to the
 * app, where the one implementation lives. Writing the tools a second time here
 * is how "create a Jira issue" ends up meaning two different things.
 *
 * Configured by env, because `--mcp-config` gives no other channel:
 *   CLAUDE_STATION_URL      where the app listens
 *   CLAUDE_STATION_TOKEN    the app's API token
 *   CLAUDE_STATION_PROJECT  which project's tools to expose
 *   CLAUDE_STATION_SESSION  a label for auditing (optional)
 *   CLAUDE_STATION_STEP     the workflow run step, when a step is what's running
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const base = (process.env.CLAUDE_STATION_URL ?? "").replace(/\/$/, "");
const token = process.env.CLAUDE_STATION_TOKEN ?? "";
const projectId = process.env.CLAUDE_STATION_PROJECT ?? "";
const sessionId = process.env.CLAUDE_STATION_SESSION ?? "bridge";
const runStepId = process.env.CLAUDE_STATION_STEP ?? null;
/** The run, when this CLI is a workflow step's terminal — the step is resolved app-side. */
const runId = process.env.CLAUDE_STATION_RUN ?? null;

if (!base || !token || !projectId) {
  // stderr, never stdout: stdout is the MCP channel and anything else on it
  // corrupts the first handshake in a way that reads as "the server is broken".
  process.stderr.write("station-mcp-bridge: missing CLAUDE_STATION_URL/TOKEN/PROJECT\n");
  process.exit(1);
}

const headers = {
  "x-cs-token": token,
  // The app checks Origin on every request; a bridge has none of its own.
  Origin: base,
  "Content-Type": "application/json",
};

const scope = new URLSearchParams({ projectId, sessionId });
if (runStepId) scope.set("runStepId", runStepId);
if (runId) scope.set("runId", runId);

async function listTools() {
  const res = await fetch(`${base}/api/mcp/tools?${scope}`, { headers });
  if (!res.ok) throw new Error(`tool list failed: ${res.status} ${await res.text()}`);
  const { tools } = await res.json();
  return tools;
}

async function callTool(name, args) {
  const res = await fetch(`${base}/api/mcp/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId, sessionId, runStepId, runId, tool: name, args: args ?? {} }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { isError: true, content: [{ type: "text", text: `station: ${res.status} ${text}` }] };
  }
  return res.json();
}

const server = new Server(
  { name: "station", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments),
);

await server.connect(new StdioServerTransport());
