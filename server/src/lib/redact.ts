/**
 * Scrubbing secrets out of text before it is written to disk — not before it is
 * rendered. The session ledger stores the user's prompts, and prompts quote
 * tokens; a store that is itself a disclosure risk is worse than no store.
 *
 * Two sources, in this order:
 *   1. Values the app already knows are secret (`env_vars.is_secret`), matched
 *      literally. This is the reliable half — no pattern needed, and it catches
 *      a token pasted in a shape nobody anticipated.
 *   2. Shapes of well-known credentials, for secrets the app was never told about.
 *
 * Deliberately pure: the caller supplies the known values, so this file is
 * testable on its own and holds no database import.
 */

/** Replacement kept short and obvious, so a redacted prompt still reads. */
export const MASK = "«redacted»";

/**
 * Anything shorter is not worth matching literally: a 6-character env value
 * ("true", "8080", a port, a log level) would blank out ordinary words.
 */
const MIN_LITERAL_LENGTH = 8;

interface Pattern {
  name: string;
  re: RegExp;
}

/**
 * Only shapes that are unambiguous. A generic "40 hex characters" rule would eat
 * every git sha in a prompt, which is exactly the text this feature exists to keep.
 */
const PATTERNS: Pattern[] = [
  // GitHub: ghp_ (classic PAT), gho_/ghu_/ghs_/ghr_ (OAuth, user, server, refresh).
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // Atlassian / Jira API tokens and PATs.
  { name: "atlassian-token", re: /\bATATT[A-Za-z0-9_=-]{20,}\b/g },
  { name: "atlassian-pat", re: /\bBBDC-[A-Za-z0-9]{20,}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Bearer/Basic in an Authorization header, and `Token xxx` in curl examples.
  {
    name: "auth-header",
    re: /\b(Authorization\s*:\s*)(Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{12,}/gi,
  },
  // Any PEM block: key material is multi-line, so match through to the footer.
  {
    name: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // Postgres/Mongo/Redis URLs with inline credentials: keep the host, drop the password.
  { name: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/gi },
];

/** Longest first, so a secret that contains another one is masked as a whole. */
function literals(secrets: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of secrets) {
    const value = raw?.trim();
    if (!value || value.length < MIN_LITERAL_LENGTH) continue;
    seen.add(value);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactResult {
  text: string;
  /** Which rules fired — for a capture-health signal, never for display next to the text. */
  hits: string[];
}

/**
 * Mask known secret values and well-known credential shapes in `text`.
 *
 * `secrets` are the plaintext values of env vars marked secret. Passing them is
 * the caller's job (see `services/session-ledger.ts`), which keeps this pure.
 */
export function redactVerbose(text: string, secrets: readonly string[] = []): RedactResult {
  if (!text) return { text, hits: [] };
  const hits: string[] = [];
  let out = text;

  for (const value of literals(secrets)) {
    const re = new RegExp(escapeRe(value), "g");
    if (re.test(out)) {
      hits.push("env-secret");
      out = out.replace(re, MASK);
    }
  }

  for (const { name, re } of PATTERNS) {
    // Two groups are kept on purpose: the header prefix and the URL scheme+user
    // carry no secret, and keeping them makes the redaction readable.
    if (name === "auth-header") {
      out = out.replace(re, (match, prefix: string, scheme: string) => {
        hits.push(name);
        return `${prefix}${scheme} ${MASK}`;
      });
      continue;
    }
    if (name === "url-credentials") {
      out = out.replace(re, (match, head: string) => {
        hits.push(name);
        return `${head}:${MASK}@`;
      });
      continue;
    }
    out = out.replace(re, () => {
      hits.push(name);
      return MASK;
    });
  }

  return { text: out, hits: [...new Set(hits)] };
}

/** The common case: give me the safe text. */
export function redact(text: string, secrets: readonly string[] = []): string {
  return redactVerbose(text, secrets).text;
}
