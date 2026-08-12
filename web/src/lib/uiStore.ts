import { useCallback, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Persisted UI state — the toggles, selections and unsent drafts that used to
 * die with every route change.
 *
 * The URL owns *what is open* (see `useUrlState`); this owns everything that
 * would only make a link noisy. It is one flat key→value map rather than a
 * typed slice per feature: the shapes are all "one small value someone edits",
 * and eight near-identical slices would be more code guarding less.
 *
 * Nothing here is trusted on read. A stored selection can point at a terminal
 * that was killed or a file that was committed, so every caller re-checks its
 * value against the live list before using it.
 */

const STORAGE_KEY = "cs.ui.v1";

/** Above this, a draft stays in memory but is not written to disk — see `partialize`. */
const DRAFT_MAX_BYTES = 64 * 1024;

/** Project-scoped key. Deleting the project drops every key under this prefix. */
export const projectKey = (projectId: string, ...parts: string[]) =>
  `p/${projectId}/${parts.join("/")}`;

/** Key for state that isn't tied to a project. */
export const globalKey = (...parts: string[]) => `g/${parts.join("/")}`;

interface UiStore {
  values: Record<string, unknown>;
  setValue: (key: string, value: unknown) => void;
  clearPrefix: (prefix: string) => void;
  reset: () => void;
}

/**
 * localStorage can throw — quota exceeded, or Safari private mode where it
 * exists but rejects writes. UI state is a convenience; losing a write is
 * always better than a crash on the way to rendering.
 */
const safeStorage = {
  getItem: (name: string) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      /* full or unavailable — this session keeps its in-memory state */
    }
  },
  removeItem: (name: string) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* nothing to do */
    }
  },
};

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      values: {},
      setValue: (key, value) =>
        set((state) => {
          if (Object.is(state.values[key], value)) return state;
          const values = { ...state.values };
          // `undefined` is the erase signal — keeping the key would persist a
          // hole that reads back as "set to nothing".
          if (value === undefined) delete values[key];
          else values[key] = value;
          return { values };
        }),
      clearPrefix: (prefix) =>
        set((state) => {
          const values = Object.fromEntries(
            Object.entries(state.values).filter(([key]) => !key.startsWith(prefix)),
          );
          return { values };
        }),
      reset: () => set({ values: {} }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      // Oversized drafts (a long workflow prompt, a pasted log) would push the
      // whole store past quota and cost every other key its persistence.
      partialize: (state) => ({
        values: Object.fromEntries(
          Object.entries(state.values).filter(
            ([, value]) => typeof value !== "string" || value.length <= DRAFT_MAX_BYTES,
          ),
        ),
      }),
      // A shape we don't recognise is not worth salvaging — an empty store
      // costs the user a few toggles, a half-migrated one can break the page.
      migrate: (persisted, version) =>
        version === 1 && persisted && typeof persisted === "object"
          ? (persisted as { values: Record<string, unknown> })
          : { values: {} },
    },
  ),
);

/**
 * `useState` that survives unmount, route changes and reload.
 *
 * The value is only ever as trustworthy as what was stored last session —
 * validate it against live data before acting on it.
 */
export function useUiState<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const stored = useUiStore((state) => state.values[key]);
  const value = stored === undefined ? fallback : (stored as T);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const { values, setValue } = useUiStore.getState();
      const prev = values[key] === undefined ? fallback : (values[key] as T);
      setValue(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
    },
    // `fallback` is read through getState at call time, so a new object literal
    // on each render must not churn this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, set];
}

/** A text draft. Empty clears the key outright rather than storing `""` forever. */
export function useUiDraft(key: string): [string, (next: string) => void] {
  const [value, setValue] = useUiState<string>(key, "");
  const set = useCallback(
    (next: string) => setValue(next === "" ? (undefined as unknown as string) : next),
    [setValue],
  );
  return [value, set];
}

/**
 * A whole form's unsaved contents, kept across close/reopen and reload.
 *
 * Restoring silently would be dangerous: the record may have moved on
 * server-side since, and saving a week-old draft over it looks like data loss
 * to whoever made the newer edit. So the caller gets `restored` and is expected
 * to say so on screen and offer `discard`.
 */
export function useRestorableDraft<T>(key: string, initial: T) {
  const [value, set] = useUiState<T>(key, initial);
  // Read once at mount: typing calls `set`, which would otherwise make this
  // true from the first keystroke and label fresh input as "restored".
  const [restored, setRestored] = useState(
    () => useUiStore.getState().values[key] !== undefined,
  );

  const clear = useCallback(() => {
    useUiStore.getState().setValue(key, undefined);
  }, [key]);

  const discard = useCallback(() => {
    setRestored(false);
    clear();
  }, [clear]);

  return { value, set, restored, discard, clear };
}

/** Sets are stored as arrays — `JSON.stringify(new Set())` is `{}`. */
export function useUiSet(key: string): [Set<string>, (next: Set<string>) => void] {
  const [list, setList] = useUiState<string[]>(key, []);
  const set = useCallback(
    (next: Set<string>) => setList(next.size === 0 ? (undefined as unknown as string[]) : [...next]),
    [setList],
  );
  // Rebuilt per render: these are small (files in one diff), and memoising on
  // array identity would just move the allocation around.
  return [new Set(list), set];
}

/** Everything a deleted project leaves behind. */
export function clearProjectUi(projectId: string) {
  useUiStore.getState().clearPrefix(`p/${projectId}/`);
}

/** Settings' escape hatch when restored state points somewhere unhelpful. */
export function resetUiState() {
  useUiStore.getState().reset();
  try {
    sessionStorage.removeItem("cs.scroll");
  } catch {
    /* nothing to do */
  }
}
