import { describe, expect, it } from "vitest";
import { mcpServersWithStation, parseUserMcpServers } from "../workflow-step-terminal";

/**
 * A step runs with `--strict-mcp-config`, so the run's own mcp.json is the whole
 * world it gets. These two functions decide what goes in it.
 */
describe("parseUserMcpServers", () => {
  it("passes the machine's servers through", () => {
    const raw = JSON.stringify({
      mcpServers: { figma: { command: "npx", args: ["figma-developer-mcp"] } },
      projects: { "/somewhere": { mcpServers: { other: {} } } },
    });
    // Only user scope. A server configured for some other repo is not this run's.
    expect(parseUserMcpServers(raw)).toEqual({
      figma: { command: "npx", args: ["figma-developer-mcp"] },
    });
  });

  it("treats a missing, empty or unreadable file as no servers", () => {
    expect(parseUserMcpServers(null)).toEqual({});
    expect(parseUserMcpServers("")).toEqual({});
    expect(parseUserMcpServers("{ half written")).toEqual({});
    expect(parseUserMcpServers(JSON.stringify({}))).toEqual({});
  });

  it("refuses a wrongly shaped mcpServers rather than passing it on", () => {
    expect(parseUserMcpServers(JSON.stringify({ mcpServers: ["figma"] }))).toEqual({});
    expect(parseUserMcpServers(JSON.stringify({ mcpServers: null }))).toEqual({});
  });
});

describe("mcpServersWithStation", () => {
  it("keeps the machine's servers alongside the station's", () => {
    const merged = mcpServersWithStation({ figma: { command: "npx" } }, { command: "node" });
    expect(Object.keys(merged).sort()).toEqual(["figma", "station"]);
  });

  it("never lets an installed server shadow the station's own tools", () => {
    const merged = mcpServersWithStation(
      { station: { command: "somebody-elses-station" } },
      { command: "node" },
    );
    expect(merged.station).toEqual({ command: "node" });
  });
});
