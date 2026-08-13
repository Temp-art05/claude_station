import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/token";

/**
 * Live refresh for the Diff tab: the server watches the working tree and says
 * "changed", we re-run the queries.
 *
 * Returns whether a real watcher is behind the socket. When it isn't — the OS
 * refused the recursive watch, or the socket is down — the caller keeps its
 * slower poll so the tab degrades to "a bit late" instead of "silently stale".
 */
export function useGitWatch(
  projectId: string,
  pathId: string,
  active: boolean,
  onChange: () => void,
): boolean {
  const [socketWatching, setSocketWatching] = useState(false);
  // The callback is rebuilt every render; keeping it in a ref means the socket
  // isn't torn down and reopened on each one.
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });

  useEffect(() => {
    if (!active || !projectId || !pathId) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(wsUrl(`/ws/git/${projectId}`, { pathId }));
      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as { t: string; watching?: boolean };
          if (msg.t === "ready") setSocketWatching(!!msg.watching);
          else if (msg.t === "changed") cb.current();
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        setSocketWatching(false);
        if (closed) return;
        // Back off so a server restart doesn't turn into a reconnect storm.
        attempt += 1;
        retry = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 15000));
      };
      socket.onopen = () => {
        attempt = 0;
        // A drop means we missed every event while away — resync on reconnect.
        cb.current();
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [projectId, pathId, active]);

  // Derived rather than reset inside the effect: a hidden panel has no socket,
  // so the last value the socket left behind must not read as "still watching".
  return active && socketWatching;
}
