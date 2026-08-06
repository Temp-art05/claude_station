import { eq } from "drizzle-orm";
import {
  APP_SETTINGS_DEFAULTS,
  appSettingsSchema,
  type AppSettings,
  type AppSettingsPatch,
} from "@claude-station/shared";
import { db, schema } from "../db";

/** Infrastructure config — read once at boot, needs to exist before the server binds. */
export const env = {
  port: Number(process.env.PORT ?? 3789),
  webPort: Number(process.env.WEB_PORT ?? 5173),
  host: "127.0.0.1" as const, // local-only, never expose
  isProd: process.env.NODE_ENV === "production",
};

/** Origins allowed to talk to the API — derived from the ports, not hardcoded. */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  [env.port, env.webPort].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]),
);

let cache: AppSettings | null = null;

/** Behaviour settings — DB-backed, editable from the UI, no restart needed. */
export function settings(): AppSettings {
  if (cache) return cache;
  const rows = db.select().from(schema.appSettings).all();
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore corrupt row, fall back to default */
    }
  }
  const parsed = appSettingsSchema.safeParse(stored);
  cache = parsed.success ? parsed.data : APP_SETTINGS_DEFAULTS;
  return cache;
}

export function setting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return settings()[key];
}

export function updateSettings(patch: AppSettingsPatch): AppSettings {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const encoded = JSON.stringify(value);
    db.insert(schema.appSettings)
      .values({ key, value: encoded })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: encoded } })
      .run();
  }
  cache = null;
  return settings();
}

export function resetSetting(key: keyof AppSettings): AppSettings {
  db.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
  cache = null;
  return settings();
}
