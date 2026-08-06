/**
 * node-pty ships spawn-helper without the +x bit; its own install script
 * normally fixes that. npm can block dependency install scripts (allow-scripts),
 * and then every pty.spawn() fails with "posix_spawnp failed". Re-apply the bit.
 */
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = `${process.platform}-${process.arch}`;
const candidates = [
  join(repoRoot, "node_modules/node-pty/prebuilds", platform, "spawn-helper"),
  join(repoRoot, "node_modules/node-pty/build/Release/spawn-helper"),
];

let fixed = 0;
for (const file of candidates) {
  if (!existsSync(file)) continue;
  chmodSync(file, 0o755);
  console.log(`chmod +x ${file.replace(repoRoot + "/", "")}`);
  fixed++;
}

if (fixed === 0 && process.platform !== "win32") {
  console.warn(`No spawn-helper found for ${platform} — terminals may not start.`);
}
