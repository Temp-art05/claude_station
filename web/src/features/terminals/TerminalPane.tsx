import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
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
  /** Typed into the PTY once it produces output — bracketed paste, never submitted. */
  seedText?: string;
  onSeedSent?: () => void;
}

export function TerminalPane({ terminalId, onExit, seedText, onSeedSent }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refs so a changing seed never recreates the terminal (effect deps stay stable).
  const seedRef = useRef(seedText);
  const onSeedSentRef = useRef(onSeedSent);
  useEffect(() => {
    seedRef.current = seedText;
    onSeedSentRef.current = onSeedSent;
  }, [seedText, onSeedSent]);

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
    // Cmd+click still selects; a plain click on a URL opens it in the browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank")));
    term.open(host);
    try {
      term.loadAddon(new WebglAddon()); // falls back to canvas/DOM if unsupported
    } catch {
      /* no webgl — default renderer is fine */
    }
    fit.fit();

    let socket: WebSocket;
    let disposed = false;
    let closedByServer = false;
    // Server sends {t:"error"} only for a dead PTY / malformed input — states a
    // reconnect can't fix, so it also stops the retry loop.
    let fatal = false;
    let attempt = 0;
    let everConnected = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let seedSent = false;
    let seedTimer: ReturnType<typeof setTimeout> | undefined;

    // Sending at socket-open is racy: the program hasn't drawn its input yet and
    // would read the paste markers as garbage. Wait for its first output instead.
    const maybeSendSeed = () => {
      if (seedSent || !seedRef.current) return;
      seedSent = true;
      seedTimer = setTimeout(() => {
        const seed = seedRef.current;
        if (!seed || socket.readyState !== WebSocket.OPEN) return;
        const paste = `\x1b[200~${seed.replace(/\r\n?/g, "\n")}\x1b[201~`;
        socket.send(JSON.stringify({ t: "input", data: paste }));
        onSeedSentRef.current?.();
      }, 300);
    };

    const connect = () => {
      socket = new WebSocket(wsUrl(`/ws/terminal/${terminalId}`));
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        setError(null);
        attempt = 0;
        fit.fit();
        socket.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        // Only steal focus on the first connect, not on background reconnects.
        if (!everConnected) term.focus();
        everConnected = true;
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
              fatal = true;
              setError(msg.message);
            }
          } catch {
            term.write(event.data);
          }
          return;
        }
        term.write(new Uint8Array(event.data as ArrayBuffer));
        maybeSendSeed();
      };

      socket.onerror = () => setError("Connection failed");
      socket.onclose = () => {
        if (disposed || closedByServer || fatal) return;
        if (attempt === 0) term.writeln("\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m");
        setError("Connection lost — reconnecting…");
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt++;
        reconnectTimer = setTimeout(connect, delay);
      };
    };
    connect();

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
      disposed = true;
      if (seedTimer) clearTimeout(seedTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
