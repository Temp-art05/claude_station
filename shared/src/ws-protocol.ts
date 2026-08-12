import { z } from "zod";
import { permissionModeSchema } from "./types";

// ── Terminal WS (/ws/terminal/:id) ────────────────────────────────────────────
// Server → client output is sent as BINARY frames (raw PTY bytes).
// Everything else is JSON text frames typed below.

export const terminalClientMsgSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("input"), data: z.string() }),
  z.object({ t: z.literal("resize"), cols: z.number().int().min(2), rows: z.number().int().min(2) }),
  z.object({ t: z.literal("kill") }),
]);
export type TerminalClientMsg = z.infer<typeof terminalClientMsgSchema>;

export const terminalServerMsgSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("exit"), code: z.number().nullable() }),
  // retryable: the PTY may well be alive and we simply could not reach it yet
  // (daemon still booting). Only a non-retryable error means "this shell is gone".
  z.object({ t: z.literal("error"), message: z.string(), retryable: z.boolean().optional() }),
  // Scrollback could not be resumed from the client's byte offset — wipe the
  // screen and treat `offset` as the new base for the client's byte counter.
  z.object({ t: z.literal("reset"), offset: z.number().int().min(0) }),
]);
export type TerminalServerMsg = z.infer<typeof terminalServerMsgSchema>;

// ── PTY daemon (station server ↔ pty-daemon, over a unix socket) ──────────────
// PTYs outlive the server process, so they live in a separate daemon. Bump this
// when the daemon's HTTP/WS contract changes shape.

export const PTY_PROTOCOL = 1;

export const ptyStartOptionsSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  shell: z.string().optional(),
  /** Run this instead of an interactive shell; the PTY exits when it does. */
  command: z.string().optional(),
  cols: z.number().int().min(2).optional(),
  rows: z.number().int().min(2).optional(),
});
export type PtyStartOptions = z.infer<typeof ptyStartOptionsSchema>;

export interface PtyHealth {
  ok: true;
  protocol: number;
  pid: number;
  sessions: number;
  startedAt: string;
}

/** Daemon → server, on /ws/events. Keeps the server's `isRunning` mirror honest. */
export type PtyEventMsg =
  | { t: "hello"; ids: string[] }
  | { t: "session_started"; id: string }
  | { t: "session_exited"; id: string; code: number | null };

// ── Chat WS (/ws/chat/:sessionId) ─────────────────────────────────────────────

export const chatClientMsgSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("user_message"),
    text: z.string().min(1),
    /** Uploaded via POST /api/sessions/:id/attachments before sending. */
    attachmentIds: z.array(z.string()).optional(),
  }),
  z.object({ t: z.literal("interrupt") }),
  z.object({
    t: z.literal("permission_response"),
    requestId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
  }),
  z.object({
    t: z.literal("set_options"),
    permissionMode: permissionModeSchema.optional(),
    model: z.string().nullable().optional(),
  }),
]);
export type ChatClientMsg = z.infer<typeof chatClientMsgSchema>;

export type ChatServerMsg =
  | { t: "session"; sdkSessionId: string; cwd: string; model: string | null }
  | { t: "message"; seq: number; message: unknown } // full SDKMessage
  | { t: "delta"; text: string } // partial assistant text
  | {
      t: "permission_request";
      requestId: string;
      toolName: string;
      input: unknown;
      timeoutSec: number;
    }
  | { t: "permission_timeout"; requestId: string }
  | { t: "status"; value: "running" | "idle" }
  | { t: "result"; costUsd: number | null; durationMs: number | null; isError: boolean }
  | { t: "error"; message: string };

// ── Command log WS (/ws/command/:runId) ───────────────────────────────────────
// Server → client output is BINARY (raw build log); JSON frames are control.

export type CommandServerMsg =
  | { t: "exit"; code: number | null }
  | { t: "error"; message: string };
