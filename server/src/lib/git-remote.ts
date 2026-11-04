import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resolves an SSH host as written in a remote (maybe a ~/.ssh/config alias) to the real hostname. */
export type HostResolver = (host: string) => Promise<string>;

/** Splits an SSH remote into host + repo path; null for anything that is not SSH. */
function parseSshRemote(remote: string): { host: string; path: string } | null {
  const match = remote.startsWith("ssh://")
    ? // ssh://git@host[:port]/o/r.git
      /^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote)
    : remote.includes("://")
      ? null
      : // scp-like: git@host:o/r.git, or host:o/r.git when the user comes from ~/.ssh/config
        /^(?:[^@\s]+@)?([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  const [, host, path] = match ?? [];
  return host && path ? { host, path } : null;
}

/**
 * "git@github.com:o/r.git" / "https://github.com/o/r.git" → "https://github.com/o/r".
 * An SSH host may be an alias from ~/.ssh/config (e.g. "git@work:o/r.git"), which no
 * browser can open — `resolveHost` maps it back to the real hostname.
 */
export async function remoteToWebUrl(
  remote: string,
  resolveHost: HostResolver = resolveSshHost,
): Promise<string | null> {
  const http = /^https?:\/\/.+$/.exec(remote);
  if (http) return remote.replace(/\.git$/, "");
  const ssh = parseSshRemote(remote);
  if (!ssh) return null;
  const host = await resolveHost(ssh.host).catch(() => ssh.host);
  return `https://${host}/${ssh.path}`;
}

const hostCache = new Map<string, Promise<string>>();

/** `ssh -G` prints the config ssh would use, alias lookups included, without connecting. */
export function resolveSshHost(host: string): Promise<string> {
  let cached = hostCache.get(host);
  if (!cached) {
    cached = execFileAsync("ssh", ["-G", host], { timeout: 3_000 })
      .then(({ stdout }) => /^hostname\s+(\S+)/m.exec(stdout)?.[1] ?? host)
      .catch(() => host);
    hostCache.set(host, cached);
  }
  return cached;
}
