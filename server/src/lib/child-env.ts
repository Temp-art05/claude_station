/**
 * Base env for every child process the station spawns (commands, terminals,
 * Claude sessions). The station's own config vars must NOT leak through: with
 * PORT=3789 in the inherited env, `next dev` in a user repo binds to 3789
 * instead of its default. An env set can still set any of these on purpose —
 * it is merged on top of this base.
 */
const STATION_ONLY = new Set([
  "PORT",
  "WEB_PORT",
  "LOG_LEVEL",
  "CLAUDE_STATION_TOKEN",
  "CLAUDE_STATION_DATA",
  "CLAUDE_SKILLS_DIR",
]);

export function childBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STATION_ONLY.has(k)) out[k] = v;
  }
  return out;
}
