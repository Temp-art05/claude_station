import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { wsUrl } from "@/lib/token";

const THEME = {
  background: "#0e1013",
  foreground: "#e7e9ee",
  cursor: "#2dd4bf",
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

interface Props {
  terminalId: string;
  onExit?: (code: number | null) => void;
}

export function TerminalPane({ terminalId, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'JetBrains Mono, "SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon()); // falls back to canvas/DOM if unsupported
    } catch {
      /* no webgl — default renderer is fine */
    }
    fit.fit();

    const socket = new WebSocket(wsUrl(`/ws/terminal/${terminalId}`));
    socket.binaryType = "arraybuffer";
    let closedByServer = false;

    socket.onopen = () => {
      fit.fit();
      socket.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      term.focus();
    };

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data) as
            | { t: "exit"; code: number | null }
            | { t: "error"; message: string };
          if (msg.t === "exit") {
            closedByServer = true;
            term.writeln(`\r\n\x1b[90m[process exited with code ${msg.code ?? "?"}]\x1b[0m`);
            onExit?.(msg.code);
          } else {
            setError(msg.message);
          }
        } catch {
          term.write(event.data);
        }
        return;
      }
      term.write(new Uint8Array(event.data as ArrayBuffer));
    };

    socket.onerror = () => setError("Connection failed");
    socket.onclose = () => {
      if (!closedByServer) term.writeln("\r\n\x1b[90m[disconnected]\x1b[0m");
    };

    const dataSub = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "input", data }));
      }
    });

    // Keep the PTY's viewport in sync with the pane, not the window.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* pane hidden — ignore */
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      socket.close();
      term.dispose();
    };
  }, [terminalId, onExit]);

  return (
    <div className="relative h-full min-h-0">
      {error && (
        <div className="absolute inset-x-0 top-0 z-10 bg-err/15 px-3 py-1.5 text-xs text-err">
          {error}
        </div>
      )}
      <div ref={hostRef} className="terminal-host h-full w-full" />
    </div>
  );
}
