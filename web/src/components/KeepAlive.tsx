import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Keeps a tab's panel mounted while another tab is on screen.
 *
 * Conditional rendering (`{tab === "diff" && <DiffTab/>}`) destroys the panel
 * on every switch: scroll positions, xterm viewports and open WebSockets all
 * go with it. Hiding instead of unmounting is what makes returning to a tab
 * feel like coming back rather than starting over.
 *
 * It is not free — every retained panel keeps its sockets and timers — so the
 * caller decides *which* panels are worth it and `useRetainedKeys` caps how
 * many stay alive at once.
 */

const HIDDEN = { display: "none" } as const;

/**
 * True unless the surrounding panel is currently hidden. Hidden panels should
 * stop polling: a background `refetchInterval` costs requests for pixels no
 * one can see.
 */
const ActiveContext = createContext(true);

export function usePanelActive(): boolean {
  return useContext(ActiveContext);
}

interface Props {
  /** Is this the panel on screen right now? */
  active: boolean;
  /** Has the LRU decided to keep it mounted? `false` unmounts it outright. */
  retained: boolean;
  children: ReactNode;
}

export function KeepAlive({ active, retained, children }: Props) {
  // These nest: a project page is one KeepAlive and each of its tabs another.
  // A hidden project's "active" tab is still not on screen, so the inner one
  // must not report itself as active — otherwise it keeps polling for a view
  // nobody can see.
  const parentActive = useContext(ActiveContext);
  if (!retained) return null;
  return (
    // Inline `display:none` rather than the `hidden` attribute: a child with a
    // Tailwind display utility would otherwise win the cascade and stay visible.
    <div style={active ? undefined : HIDDEN} className="h-full min-h-0">
      <ActiveContext.Provider value={active && parentActive}>{children}</ActiveContext.Provider>
    </div>
  );
}

/**
 * The most-recently-visited keys, newest first, capped at `limit`.
 *
 * Pass `Infinity` to retain everything. A finite cap trades memory for
 * fidelity: an evicted panel loses only its view, since the PTY lives on the
 * server and reopening it reconnects. The caller owns that trade-off.
 */
export function useRetainedKeys(active: string | null, limit: number): Set<string> {
  const [keys, setKeys] = useState<string[]>([]);
  const [seen, setSeen] = useState<string | null>(null);

  // Adjusted during render, not in an effect: the render that switches tabs is
  // when the new panel must already be retained. Deferring it to an effect
  // mounts the panel a frame late, which reads as a flash of empty space.
  // React re-runs this component before committing, so no extra frame is shown.
  if (active !== seen) {
    setSeen(active);
    if (active && keys[0] !== active) {
      setKeys([active, ...keys.filter((key) => key !== active)].slice(0, limit));
    }
  }

  return new Set(keys);
}
