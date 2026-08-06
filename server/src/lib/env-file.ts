import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/**
 * Load `<repo>/.env` before anything reads process.env.
 *
 * Must stay the first import in `index.ts`: ES modules evaluate depth-first in
 * source order, so importing this first guarantees the file is applied before
 * `config.ts` / `auth.ts` snapshot their values. Real environment variables win
 * over the file, which is what `process.loadEnvFile` already does.
 */
const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`Could not read .env (${err instanceof Error ? err.message : err})`);
  }
}

export const ENV_FILE = existsSync(envPath) ? envPath : null;
