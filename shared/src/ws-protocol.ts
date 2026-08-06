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
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type TerminalServerMsg = z.infer<typeof terminalServerMsgSchema>;

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
