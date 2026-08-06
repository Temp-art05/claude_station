import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatServerMsg } from "@claude-station/shared";
import { api } from "@/lib/api";
import { wsUrl } from "@/lib/token";

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  timeoutSec: number;
}

export interface ChatEntry {
  seq: number;
  type: string;
  role: string;
  /** Raw SDKMessage (or our own user_input) — the renderer decides what to show. */
  message: unknown;
}

export interface ResultInfo {
  costUsd: number | null;
  durationMs: number | null;
  isError: boolean;
}

/**
 * History comes from our own DB (hydrate by seq), live updates from the socket.
 * A reconnect therefore never loses messages, even mid-turn.
 */
export function useChatSocket(sessionId: string | null) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [lastResult, setLastResult] = useState<ResultInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // Switching sessions resets everything. Done during render (React's documented
  // "adjust state when a prop changes" pattern) rather than in an effect, so the
  // stale session's messages never paint.
  const [tracked, setTracked] = useState(sessionId);
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setEntries([]);
    setStreaming("");
    setError(null);
    setPermission(null);
    setLastResult(null);
  }

  /** Merge by seq so hydrate and live frames can arrive in any order. */
  const mergeEntry = useCallback((entry: ChatEntry) => {
    setEntries((prev) =>
      prev.some((e) => e.seq === entry.seq)
        ? prev
        : [...prev, entry].sort((a, b) => a.seq - b.seq),
    );
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    void api
      .get<ChatMessage[]>(`/api/sessions/${sessionId}/messages?afterSeq=0`)
      .then((rows) => {
        if (cancelled) return;
        for (const r of rows) {
          mergeEntry({
            seq: r.seq,
            type: r.type,
            role: r.role,
            message: JSON.parse(r.content) as unknown,
          });
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    const socket = new WebSocket(wsUrl(`/ws/chat/${sessionId}`));
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ChatServerMsg;
      switch (msg.t) {
        case "message":
          setStreaming("");
          mergeEntry({
            seq: msg.seq,
            type: (msg.message as { type?: string }).type ?? "unknown",
            role: "",
            message: msg.message,
          });
          break;
        case "delta":
          setStreaming((prev) => prev + msg.text);
          break;
        case "status":
          setRunning(msg.value === "running");
          if (msg.value === "idle") setStreaming("");
          break;
        case "permission_request":
          setPermission(msg);
          break;
        case "permission_timeout":
          setPermission((prev) => (prev?.requestId === msg.requestId ? null : prev));
          break;
        case "result":
          setLastResult(msg);
          // The tab is often in the background during long turns.
          if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            new Notification(msg.isError ? "Claude session failed" : "Claude finished", {
              body: msg.costUsd !== null ? `$${msg.costUsd.toFixed(4)}` : "",
            });
          }
          break;
        case "error":
          setError(msg.message);
          break;
        case "session":
          break;
      }
    };
    socket.onclose = () => setRunning(false);

    return () => {
      cancelled = true;
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId, mergeEntry]);

  const send = useCallback((text: string, attachmentIds: string[] = []) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError("Not connected");
      return;
    }
    setError(null);
    setLastResult(null);
    socket.send(JSON.stringify({ t: "user_message", text, attachmentIds }));
  }, []);

  const interrupt = useCallback(() => {
    socketRef.current?.send(JSON.stringify({ t: "interrupt" }));
  }, []);

  const respondPermission = useCallback(
    (requestId: string, behavior: "allow" | "deny", message?: string) => {
      socketRef.current?.send(
        JSON.stringify({ t: "permission_response", requestId, behavior, message }),
      );
      setPermission(null);
    },
    [],
  );

  return {
    entries,
    streaming,
    running,
    permission,
    lastResult,
    error,
    send,
    interrupt,
    respondPermission,
  };
}
