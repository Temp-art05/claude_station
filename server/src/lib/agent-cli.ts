/**
 * Running an agent CLI that is not Claude Code.
 *
 * The infrastructure this app has — PTY, tmux, env sets, worktrees, project
 * context, the History tab — is agent-agnostic. What is Claude-specific is the
 * part above it: the transcript follower, the session ledger, the MCP tools
 * (`jira_*`, `run_project_command`, `memory_*`), and the approval modal.
 *
 * So a preset here buys the terminal and nothing else, and the UI says so. That
 * is the honest version of "multi-agent support": Codex runs, in the right repo,
 * with the right environment, next to everything else — but it has none of this
 * app's hands, and nothing it does reaches the ledger.
 *
 * Presets are a list rather than a registry that downloads binaries (Atlas
 * fetches official binaries off an ACP registry). Installing somebody's binary
 * on demand is a different risk, taken in a different conversation.
 */
import { execFileSync } from "node:child_process";
import { shq } from "./claude-cli";

export interface AgentPreset {
  id: string;
  label: string;
  /** The binary, looked up on PATH. */
  bin: string;
  /** Arguments always passed. Kept minimal — a preset is a launcher, not a config. */
  args: string[];
  /** How to install it, shown when the binary is missing. */
  install: string;
  /** What this app cannot do for it, shown once in the UI. */
  limits: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    args: [],
    install: "npm i -g @openai/codex",
    limits: "No station MCP tools, no turn record, no approval modal.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    args: [],
    install: "brew install sst/tap/opencode",
    limits: "No station MCP tools, no turn record, no approval modal.",
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent",
    bin: "cursor-agent",
    args: [],
    install: "curl https://cursor.com/install -fsS | bash",
    limits: "No station MCP tools, no turn record, no approval modal.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    args: [],
    install: "npm i -g @google/gemini-cli",
    limits: "No station MCP tools, no turn record, no approval modal.",
  },
];

export function presetById(id: string): AgentPreset | null {
  return AGENT_PRESETS.find((preset) => preset.id === id) ?? null;
}

export interface PresetStatus extends AgentPreset {
  installed: boolean;
  /** First line of `--version`, or why it could not be asked. */
  version: string;
  path: string;
}

/**
 * Is this agent actually on the machine?
 *
 * `which` through the login shell rather than `process.env.PATH`: the server is
 * often started from a launcher that never sourced a profile, so a tool the user
 * can run in their own terminal is invisible here otherwise.
 */
export function statusOf(preset: AgentPreset): PresetStatus {
  let path: string;
  try {
    path = execFileSync("/bin/zsh", ["-lc", `command -v ${shq(preset.bin)}`], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    path = "";
  }
  if (!path) {
    return { ...preset, installed: false, version: "not on PATH", path: "" };
  }

  let version: string;
  try {
    version =
      execFileSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 8_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")[0]
        ?.trim() ?? "";
  } catch {
    // Some CLIs have no `--version` and print help to stderr instead. Being on
    // PATH is the fact that matters; the version is decoration.
    version = "installed";
  }
  return { ...preset, installed: true, version: version || "installed", path };
}

export function presetStatuses(): PresetStatus[] {
  return AGENT_PRESETS.map(statusOf);
}

/** The command a terminal runs for this preset. */
export function presetCommand(preset: AgentPreset): string {
  return [preset.bin, ...preset.args.map(shq)].join(" ");
}
