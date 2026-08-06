import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { wsUrl } from "@/lib/token";

const THEME = {
  background: "#0e1013",
  foreground: "#c9cdd6",
  cursor: "#0e1013", // read-only: hide the cursor by blending it away
  selectionBackground: "#2dd4bf40",
  black: "#15181d",
  brightBlack: "#5c6270",
  red: "#fb7185",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#2dd4bf",
  white: "#e7e9ee",
};

/**
 * Live build output in a real (read-only) terminal: ANSI colours render
 * instead of leaking escape codes, and URLs are clickable via the web-links
 * addon — handy for `next dev`'s http://localhost:3000.
 */
export function LogPane({ runId }: { runId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  // Callers mount this with key={runId}, so everything starts fresh per run.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'JetBrains Mono, "SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      disableStdin: true,
      cursorBlink: false,
      convertEol: true, // build logs use bare \n
      allowProposedApi: true,
      theme: THEME,
      scrollback: 20_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri, "_blank")));
    term.open(host);
    try {
      term.loadAddon(new WebglAddon()); // falls back to canvas/DOM if unsupported
    } catch {
      /* renderer fallback */
    }
    fit.fit();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    const socket = new WebSocket(wsUrl(`/ws/command/${runId}`));
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data) as { t: string; code?: number | null };
          if (msg.t === "exit") setExitCode(msg.code ?? null);
        } catch {
          term.write(event.data);
        }
        return;
      }
      term.write(new Uint8Array(event.data as ArrayBuffer));
    };

    return () => {
      socket.close();
      observer.disconnect();
      term.dispose();
    };
  }, [runId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 bg-[#0e1013] px-2 py-1.5" />
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
