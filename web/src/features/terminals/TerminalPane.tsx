import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { wsUrl } from "@/lib/token";

/**
 * `"… Variable"` is the family @fontsource actually declares (`index.css:110`); the
 * bare `JetBrains Mono` matches no `@font-face` and silently falls through to the
 * system mono. It arrives asynchronously, which xterm has to be told about — see
 * the `document.fonts` handling below.
 */
const FONT_STACK = '"JetBrains Mono Variable", "SF Mono", ui-monospace, Menlo, monospace';
const FONT_SIZE = 12.5;

/** Mirrors the M3 tokens in index.css — the terminal is a surface too. */
const THEME = {
  background: "#1c1c1d",
  foreground: "#f2f2f3",
  cursor: "#3fd898",
  selectionBackground: "#3fd89840",
  black: "#252527",
  brightBlack: "#7b7b7d",
  red: "#ff6259",
  green: "#3fd898",
  yellow: "#ffb020",
  blue: "#5aa9ff",
  magenta: "#b79cf8",
  cyan: "#5ad8c0",
  white: "#ffffff",
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
  // Status lives here, never in the terminal buffer: writing into xterm while a
  // full-screen program owns the screen scrolls and overwrites *its* rows, and the
  // leftovers survive until something repaints (see the tmux repaint on reconnect).
  const [notice, setNotice] = useState<{ tone: "err" | "info"; text: string } | null>(null);
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
      fontFamily: FONT_STACK,
      fontSize: FONT_SIZE,
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
    // The DOM renderer builds an element per cell; at 215x32 that is ~7000 of
    // them re-touched on every frame, and it is what made a fast-scrolling pane
    // feel nothing like a real terminal. This was pulled out earlier as a suspect
    // for the screen going stale — measurement cleared it: the painted rows always
    // matched the buffer exactly, so the renderer never lost anything. On the GPU.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      // A lost GL context (GPU sleep, tab throttling, driver reset) leaves the
      // addon painting into nothing while the buffer keeps updating — the screen
      // goes stale in patches. xterm requires the addon be disposed so it can fall
      // back to the DOM renderer; without this the tab renders half a screen.
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = undefined;
        term.refresh(0, term.rows - 1);
      });
      term.loadAddon(webgl); // falls back to canvas/DOM if unsupported
    } catch {
      webgl = undefined; /* no webgl — the default renderer is still correct */
    }
    fit.fit();

    let socket: WebSocket | undefined;
    let disposed = false;
    let closedByServer = false;
    // Server sends {t:"error"} only for a dead PTY / malformed input — states a
    // reconnect can't fix, so it also stops the retry loop.
    let fatal = false;
    let attempt = 0;
    let everConnected = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let seedSent = false;
    // Set on every (re)connect: the next chunk carries the repaint, and the
    // renderer has to be pushed over the whole screen when it arrives.
    let awaitingRepaint = false;
    let seedTimer: ReturnType<typeof setTimeout> | undefined;

    // Sending at socket-open is racy: the program hasn't drawn its input yet and
    // would read the paste markers as garbage. Wait for its first output instead.
    const maybeSendSeed = () => {
      if (seedSent || !seedRef.current) return;
      seedSent = true;
      seedTimer = setTimeout(() => {
        const seed = seedRef.current;
        if (!seed || socket?.readyState !== WebSocket.OPEN) return;
        const paste = `\x1b[200~${seed.replace(/\r\n?/g, "\n")}\x1b[201~`;
        socket.send(JSON.stringify({ t: "input", data: paste }));
        onSeedSentRef.current?.();
      }, 300);
    };

    // A pane kept alive behind another tab measures 0×0. Fitting to *that* would
    // resize the PTY to a garbage geometry and reflow the program's output, so a
    // hidden pane is never fitted — but it still has to report the grid it has.
    // Staying silent was the bug: the PTY kept drawing at a geometry this
    // emulator never had (absolute cursor moves past its last row scroll the
    // screen away, past its last column pile up at the edge), and the server
    // repaints on the first size it hears — so no size meant no frame, ever.
    const sendResizeNow = () => {
      if (host.clientWidth && host.clientHeight) {
        try {
          fit.fit();
        } catch {
          /* transient layout — the next observation will settle it */
        }
      }
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    /**
     * Only the geometry the pane *settles* on is worth telling the server about.
     * Every observation used to be sent, and every one resized the real tmux
     * window: a panel animating out to full width reported 88×29, then 90×29,
     * then 215×32, and Claude Code reflowed its whole screen for each. tmux keeps
     * the last size's screen and sends only differences against it, so the two
     * emulators end up describing different screens — tmux full, this one blank —
     * with no way back. Waiting out the animation is what keeps them one screen.
     */
    const RESIZE_QUIET_MS = 250;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let reportedOnce = false;
    const sendResize = () => {
      // The *first* geometry is the opposite case and must not wait: the server
      // holds this tab's output until it knows the size, so every millisecond of
      // debounce here is a millisecond of blank pane. There is nothing to settle
      // yet either — the flapping this guards against comes from later layout.
      if (!reportedOnce) {
        reportedOnce = true;
        sendResizeNow();
        return;
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResizeNow, RESIZE_QUIET_MS);
    };

    /** Repaints every row from the buffer — the cure for a stale renderer. */
    const redrawAll = () => {
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* terminal already disposed */
      }
    };

    /**
     * Everything that can put a screen back. The buffer is usually still right and
     * only the canvas is gone, so the local repaint comes first and covers the
     * common case on its own; the server frame covers the rest — rows this
     * emulator never received, because tmux only ever sends the difference against
     * the screen it believes the client already has.
     */
    const requestRepaint = () => {
      redrawAll();
      if (socket?.readyState === WebSocket.OPEN) {
        awaitingRepaint = true;
        socket.send(JSON.stringify({ t: "repaint" }));
      }
    };

    // xterm measures one cell when it opens and lays every row out on that metric.
    // @fontsource loads our mono face asynchronously, so opening first measures the
    // *fallback* face; when the real one lands, glyphs are drawn at the wrong
    // advance and cells go unpainted. Re-measure once it is here — assigning a
    // different family first is what makes xterm redo the measurement, setting the
    // same value back is a no-op.
    const font = `${FONT_SIZE}px "JetBrains Mono Variable"`;
    if (!document.fonts.check(font)) {
      void document.fonts
        .load(font)
        .then(() => {
          if (disposed) return;
          term.options.fontFamily = "monospace";
          term.options.fontFamily = FONT_STACK;
          webgl?.clearTextureAtlas();
          sendResize();
          redrawAll();
        })
        .catch(() => {
          /* font never arrived — the fallback metrics are already in place */
        });
    }

    const connect = () => {
      socket = new WebSocket(wsUrl(`/ws/terminal/${terminalId}`));
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        setNotice(null);
        attempt = 0;
        awaitingRepaint = true;
        // The server repaints on this first resize, so it has to go out even when
        // the geometry is unchanged — that is what fills a reconnecting tab.
        sendResize();
        // Only steal focus on the first connect, not on background reconnects.
        if (!everConnected) term.focus();
        everConnected = true;
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as
              { t: "exit"; code: number | null } | { t: "error"; message: string };
            if (msg.t === "exit") {
              closedByServer = true;
              setNotice({ tone: "info", text: `Process exited with code ${msg.code ?? "?"}` });
              onExit?.(msg.code);
            } else {
              fatal = true;
              setNotice({ tone: "err", text: msg.message });
            }
          } catch {
            term.write(event.data);
          }
          return;
        }
        // The server's answer to the reconnect is one full frame. Force the
        // renderer over every row once it is parsed: the buffer is right either
        // way, but a renderer that only repaints what it thinks changed will keep
        // showing fragments of the frame it drew before the tab went away.
        if (awaitingRepaint) {
          awaitingRepaint = false;
          term.write(new Uint8Array(event.data as ArrayBuffer), redrawAll);
        } else {
          term.write(new Uint8Array(event.data as ArrayBuffer));
        }
        maybeSendSeed();
      };

      socket.onerror = () => setNotice({ tone: "err", text: "Connection failed" });
      socket.onclose = () => {
        if (disposed || closedByServer || fatal) return;
        setNotice({ tone: "err", text: "Connection lost — reconnecting…" });
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt++;
        reconnectTimer = setTimeout(connect, delay);
      };
    };
    connect();

    const dataSub = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "input", data }));
      }
    });

    // Keep the PTY's viewport in sync with the pane, not the window. The 0×0
    // observation is also how we learn the panel was hidden: KeepAlive switches
    // tabs with `display:none`, which drops the renderer's canvas while the
    // buffer survives. Re-showing paints only what changed since — a blank
    // screen with fragments of a live line on it — until something repaints.
    let wasHidden = false;
    const observer = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) {
        wasHidden = true;
        return;
      }
      sendResize();
      if (wasHidden) {
        wasHidden = false;
        requestRepaint();
      }
    });
    observer.observe(host);

    // Same problem, different cause: a backgrounded tab can have its canvas
    // dropped without the pane ever changing size.
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestRepaint();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      if (seedTimer) clearTimeout(seedTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      dataSub.dispose();
      socket?.close();
      term.dispose();
    };
  }, [terminalId, onExit]);

  return (
    <div className="relative h-full min-h-0">
      {notice && (
        <div
          className={`absolute inset-x-0 top-0 z-10 px-3 py-1.5 text-xs ${
            notice.tone === "err"
              ? "bg-err/15 text-err"
              : "bg-surface-container-highest text-ink-muted"
          }`}
        >
          {notice.text}
        </div>
      )}
      <div ref={hostRef} className="terminal-host h-full w-full" />
    </div>
  );
}
