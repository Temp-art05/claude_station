import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { appSettingsPatchSchema } from "@claude-station/shared";
import { settings, updateSettings, env as envConfig } from "../lib/config";
import { DATA_DIR, CLAUDE_SKILLS_LINK_DIR } from "../lib/data-dir";
import { REPO_ROOT } from "../lib/repo-root";
import { runningIds } from "../services/pty-manager";

const exec = promisify(execFile);

async function probe(cmd: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return { ok: true, detail: stdout.trim().split("\n")[0] ?? "" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function settingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings", async () => settings());

  app.patch("/api/settings", async (req) => {
    const patch = appSettingsPatchSchema.parse(req.body);
    return updateSettings(patch);
  });

  /** Doctor panel: everything that silently breaks the app if missing. */
  app.get("/api/doctor", async () => {
    const [claudeCli, gh, git] = await Promise.all([
      probe("claude", ["--version"]),
      probe("gh", ["auth", "status"]),
      probe("git", ["--version"]),
    ]);

    let dataDirWritable = true;
    try {
      accessSync(DATA_DIR, constants.W_OK);
    } catch {
      dataDirWritable = false;
    }

    let ptyOk = true;
    let ptyDetail = "spawn-helper executable";
    try {
      const { spawn } = await import("node-pty");
      const p = spawn("/bin/echo", ["ok"], { cols: 40, rows: 10 });
      p.kill();
    } catch (err) {
      ptyOk = false;
      // The usual cause: npm skipped node-pty's install script, so
      // prebuilds/<platform>/spawn-helper is not +x. `npm run fix:pty` fixes it.
      ptyDetail = `${err instanceof Error ? err.message : String(err)} — try: npm run fix:pty`;
    }

    // The SDK's exports map hides its package.json, so report the version we
    // pinned — that pin is what must stay in lockstep with the CLI build.
    const sdkVersion = (() => {
      try {
        const pkg = JSON.parse(
          readFileSync(join(REPO_ROOT, "server/package.json"), "utf8"),
        ) as { dependencies?: Record<string, string> };
        return pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"] ?? "unknown";
      } catch {
        return "unknown";
      }
    })();

    return {
      node: process.version,
      repoRoot: REPO_ROOT,
      dataDir: DATA_DIR,
      dataDirWritable,
      skillsLinkDir: CLAUDE_SKILLS_LINK_DIR,
      port: envConfig.port,
      sdkVersion,
      claudeCli,
      gh,
      git,
      pty: { ok: ptyOk, detail: ptyDetail },
      runningTerminals: runningIds().length,
    };
  });
}
