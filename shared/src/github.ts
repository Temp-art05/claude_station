/**
 * Normalize any way people paste a GitHub repo — "owner/name", an https URL
 * (with extra path segments / .git / trailing slash), or an ssh remote
 * ("git@github.com:owner/name.git") — down to "owner/name". Null if it doesn't
 * contain one.
 */
export const normalizeGithubRepo = (input: string): string | null => {
  let s = input.trim();
  if (!s) return null;
  const ssh = /^git@[^:]+:(.+)$/.exec(s);
  const http = /^https?:\/\/[^/]+\/(.+)$/.exec(s);
  if (ssh) s = ssh[1]!;
  else if (http) s = http[1]!;
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  const [owner, name] = s.split("/");
  const repo = `${owner ?? ""}/${name ?? ""}`;
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
};
