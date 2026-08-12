import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { useUiState } from "./uiStore";

/**
 * A single query param read and written like `useState`.
 *
 * The URL is the source of truth for *what is open* — which tab, which PR,
 * which file. That is what makes a reload, a Back press, and a pasted link all
 * land in the same place. Everything else (toggles, filters, drafts) belongs in
 * the persisted UI store instead; putting it here would just make links noisy.
 *
 * Writes go through the functional form of `setSearchParams`, so two hooks
 * updating in the same tick don't clobber each other with a stale snapshot.
 */

interface Options {
  /**
   * `true` (default) rewrites the current entry — right for switching tabs,
   * which shouldn't fill the Back stack. Pass `false` when opening something
   * (a PR, an issue, a file) so Back closes it again.
   */
  replace?: boolean;
}

interface StickyOptions extends Options {
  /**
   * Whether this page is the one on screen. Kept-alive pages stay mounted
   * while you're somewhere else, and a hidden page must not read or write the
   * URL: it would answer with the *visible* page's params, and its backfill
   * would rewrite an address bar the user is looking at — two pages fighting
   * over one param, one of them invisible. When `false` the store alone
   * decides, and nothing is written.
   */
  enabled?: boolean;
}

/**
 * Write several params in one navigation. Two separate writes in the same tick
 * would be two history entries; changes that belong together (pick a repo *and*
 * drop the open PR) have to travel as one.
 */
export function useUrlPatch({ replace = true }: Options = {}) {
  const [, setParams] = useSearchParams();
  return useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) params.delete(key);
            else params.set(key, value);
          }
          return params;
        },
        { replace },
      );
    },
    [replace, setParams],
  );
}

function useWrite(key: string, replace: boolean) {
  const patch = useUrlPatch({ replace });
  return useCallback((next: string | null) => patch({ [key]: next }), [key, patch]);
}

/** Required value: absent in the URL reads as `fallback`, and writing it clears the param. */
export function useUrlState(
  key: string,
  fallback: string,
  { replace = true }: Options = {},
): [string, (next: string) => void] {
  const [params] = useSearchParams();
  const write = useWrite(key, replace);
  const set = useCallback(
    (next: string) => write(next === fallback ? null : next),
    [write, fallback],
  );
  return [params.get(key) ?? fallback, set];
}

/** Optional value: `null` means "nothing selected" and drops the param entirely. */
export function useUrlStateOptional(
  key: string,
  { replace = false }: Options = {},
): [string | null, (next: string | null) => void] {
  const [params] = useSearchParams();
  const write = useWrite(key, replace);
  return [params.get(key), write];
}

/**
 * URL state that also survives arriving without a URL.
 *
 * The URL alone is not enough: clicking "Projects" in the sidebar navigates to
 * a bare `/projects`, and re-entering a project lands on `/projects/:id` with
 * no `?tab=` at all — so a URL-only tab silently resets to its default. That
 * is the whole complaint about "losing state on switching", and neither layer
 * fixes it alone.
 *
 * So the two cooperate: a param in the URL always wins (pasted links, Back and
 * reload keep working), and when it is absent the last value used here fills in
 * and is written back to the URL so the next reload agrees. Writes update both.
 */
/**
 * Returns `[value, set, setStore]`.
 *
 * `set` writes both the store and the URL and is what you want almost always.
 * `setStore` touches only the store — reach for it when one action changes
 * several params at once (pick a repo *and* close the open PR): every URL write
 * must then be folded into a single `useUrlPatch` call, because two
 * `setSearchParams` calls in one handler do **not** compose. Each is handed the
 * same pre-render snapshot, so the second silently reverts the first.
 */
export function useStickyUrlState(
  param: string,
  storeKey: string,
  fallback: string,
  { replace = true, enabled = true }: StickyOptions = {},
): [string, (next: string) => void, (next: string) => void] {
  const [params] = useSearchParams();
  const [stored, setStored] = useUiState(storeKey, fallback);
  const write = useWrite(param, replace);
  // Backfilling is not a user action, so it always replaces — restoring a
  // remembered tab must never add a history entry nobody asked for.
  const backfill = useWrite(param, true);
  const fromUrl = enabled ? params.get(param) : null;
  const value = fromUrl ?? stored;

  // Put the remembered value into the address bar so a later reload agrees.
  useEffect(() => {
    if (enabled && fromUrl === null && stored !== fallback) backfill(stored);
  }, [enabled, fromUrl, stored, fallback, backfill]);

  const set = useCallback(
    (next: string) => {
      setStored(next);
      if (enabled) write(next === fallback ? null : next);
    },
    [setStored, write, fallback, enabled],
  );

  return [value, set, setStored];
}

/** Sticky variant for "nothing selected" state — an open PR, a chosen issue. */
export function useStickyUrlStateOptional(
  param: string,
  storeKey: string,
  { replace = false, enabled = true }: StickyOptions = {},
): [
  string | null,
  (next: string | null) => void,
  (next: string | null) => void,
] {
  const [params] = useSearchParams();
  const [stored, setStored] = useUiState<string | null>(storeKey, null);
  const write = useWrite(param, replace);
  const backfill = useWrite(param, true);
  const fromUrl = enabled ? params.get(param) : null;
  const value = fromUrl ?? stored;

  useEffect(() => {
    if (enabled && fromUrl === null && stored !== null) backfill(stored);
  }, [enabled, fromUrl, stored, backfill]);

  const set = useCallback(
    (next: string | null) => {
      setStored(next);
      if (enabled) write(next);
    },
    [setStored, write, enabled],
  );

  return [value, set, setStored];
}
