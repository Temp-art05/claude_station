import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/token";

/**
 * Live build output. Plain <pre> rather than xterm: build logs are append-only
 * and we want text selection + browser find to work.
 */
export function LogPane({ runId }: { runId: string }) {
  const [text, setText] = useState("");
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const boxRef = useRef<HTMLPreElement | null>(null);
  const pinnedRef = useRef(true);

  // Callers mount this with key={runId}, so state starts fresh per run.
  useEffect(() => {
    const socket = new WebSocket(wsUrl(`/ws/command/${runId}`));
    socket.binaryType = "arraybuffer";
    const decoder = new TextDecoder();

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data) as { t: string; code?: number | null };
          if (msg.t === "exit") setExitCode(msg.code ?? null);
        } catch {
          setText((prev) => prev + event.data);
        }
        return;
      }
      const chunk = decoder.decode(new Uint8Array(event.data as ArrayBuffer), { stream: true });
      setText((prev) => prev + chunk);
    };

    return () => socket.close();
  }, [runId]);

  // Follow the tail unless the user scrolled up to read something.
  useEffect(() => {
    const box = boxRef.current;
    if (box && pinnedRef.current) box.scrollTop = box.scrollHeight;
  }, [text]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <pre
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-base px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-muted"
      >
        {text || "waiting for output…"}
      </pre>
      {exitCode !== undefined && (
        <div
          className={`border-t border-edge px-3 py-1.5 font-mono text-[11px] ${
            exitCode === 0 ? "text-ok" : "text-err"
          }`}
        >
          exit {exitCode ?? "signal"}
        </div>
      )}
    </div>
  );
}
