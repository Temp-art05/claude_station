import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

/**
 * A server-side copy of what a plain PTY's screen looks like.
 *
 * Without tmux there is nothing to ask "what is on screen", and the byte log is
 * not an answer: a TUI like `claude` draws by moving the cursor and rewriting only
 * the cells that changed. The last few KB of bytes therefore still hold spinner
 * frames the program has long since overwritten, and miss the composer it drew
 * once and never touched again. A workflow step read exactly that, believed the
 * turn was still running, and only moved on when a reload forced a full redraw.
 *
 * Feeding the same bytes through a real terminal emulator gives the screen the
 * user would see, which is what `claude-screen` was written to read.
 */
export class ScreenMirror {
  private readonly term: InstanceType<typeof Terminal>;

  constructor(cols: number, rows: number, scrollback = 200) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  }

  write(data: string | Uint8Array, done?: () => void): void {
    this.term.write(data, done);
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      /* disposed */
    }
  }

  /**
   * The visible screen plus up to `historyLines` above it, as plain text — the
   * same shape `tmux capture-pane -S -N` returns, so callers read both alike.
   */
  text(historyLines = 80): string {
    const buf = this.term.buffer.active;
    const start = Math.max(0, buf.baseY - historyLines);
    const lines: string[] = [];
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const s = line.translateToString(true);
      // A wrapped row continues the one above it, as capture-pane -J would join.
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += s;
      else lines.push(s);
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  dispose(): void {
    this.term.dispose();
  }
}
