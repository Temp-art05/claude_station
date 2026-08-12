import { useCallback, useEffect, useRef } from "react";

/**
 * Remembers how far a scroll container was scrolled, per key.
 *
 * Deliberately `sessionStorage`, not the persisted UI store: a scroll offset is
 * only meaningful while you still remember what you were reading. Restoring
 * yesterday's position reads as the app being stuck, not as continuity.
 */

const STORAGE_KEY = "cs.scroll";

function readAll(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, number>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* full or unavailable — scroll memory is the first thing worth dropping */
  }
}

/**
 * Attach to a scrollable element via the returned ref.
 *
 * Pass `key: null` to disable — useful while the identity of the content is
 * still loading, so a half-rendered list can't record a meaningless offset.
 */
export function useScrollMemory<T extends HTMLElement>(key: string | null) {
  const ref = useRef<T | null>(null);
  const restoredFor = useRef<string | null>(null);

  // Written on every scroll, so it must not touch storage per event: a fast
  // trackpad flick fires these faster than JSON.stringify can keep up.
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    if (key === null || pending.current === null) return;
    const map = readAll();
    map[key] = pending.current;
    writeAll(map);
  }, [key]);

  useEffect(() => {
    const el = ref.current;
    if (!el || key === null) return;

    // Restore once per key. Re-running on every render would fight the user
    // mid-scroll; running after paint means the content has its real height.
    if (restoredFor.current !== key) {
      restoredFor.current = key;
      const saved = readAll()[key];
      if (saved) el.scrollTop = saved;
    }

    const onScroll = () => {
      pending.current = el.scrollTop;
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // The unmount itself is the last chance to record where we were.
      flush();
    };
  }, [key, flush]);

  return ref;
}
