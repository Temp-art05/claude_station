/*
 * Deterministic bright colour per GitHub login, so the same person keeps the
 * same colour across the PR list, the issue list and the PR detail timeline.
 *
 * The palette is hand-picked rather than generated from a hue wheel: an even
 * hue sweep dips into blues and greens that go muddy on the charcoal base, so
 * these are all high-lightness tints that stay readable on `--color-base`.
 */
const AUTHOR_COLORS = [
  "#5eead4", // teal
  "#7dd3fc", // sky
  "#c4b5fd", // violet
  "#f0abfc", // fuchsia
  "#fda4af", // rose
  "#fdba74", // orange
  "#fde047", // yellow
  "#86efac", // green
  "#a5b4fc", // indigo
  "#67e8f9", // cyan
  "#f9a8d4", // pink
  "#bef264", // lime
] as const;

/** Login with no author — GitHub returns nothing for deleted accounts. */
const UNKNOWN_COLOR = "#8d93a1"; // --color-ink-muted

/** FNV-1a, 32-bit. Stable across runs, unlike anything seeded per session. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function authorColor(login: string): string {
  const key = login.trim().toLowerCase();
  if (!key || key === "unknown") return UNKNOWN_COLOR;
  return AUTHOR_COLORS[hash(key) % AUTHOR_COLORS.length]!;
}
