/**
 * Scrubbing secrets out of text before it is written to disk — not before it is
 * rendered. The session ledger stores the user's prompts, and prompts quote
 * tokens; a store that is itself a disclosure risk is worse than no store.
 *
 * Three sources, in this order:
 *   1. Values the app already knows are secret (`env_vars.is_secret`), matched
 *      literally. This is the reliable half — no pattern needed, and it catches
 *      a token pasted in a shape nobody anticipated.
 *   2. Shapes of well-known credentials, for secrets the app was never told about,
 *      plus a `key = value` rule for the ones with no shape at all.
 *   3. High-entropy strings that match no known shape, for the credential whose
 *      issuer nobody wrote a rule for. The caller asks for it; `ledger.redactEntropy`
 *      is what turns it on in practice.
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
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "figma-token", re: /\bfigd_[A-Za-z0-9_-]{20,}\b/g },
  { name: "linear-key", re: /\blin_api_[A-Za-z0-9]{20,}\b/g },
  { name: "notion-token", re: /\bntn_[A-Za-z0-9]{20,}\b/g },
  { name: "supabase-key", re: /\bsbp_[a-f0-9]{40,}\b/g },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "docker-pat", re: /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g },
  { name: "groq-key", re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9]{40,}\b/g },
  { name: "stripe-key", re: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  // A JWT is three base64url segments; the header always starts `{"alg"`, which
  // base64s to `eyJhbGci`. Anchoring there is what keeps this off ordinary text.
  { name: "jwt", re: /\beyJhbGci[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
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

/**
 * Field names that make their value a credential whatever it looks like.
 *
 * Matched as a whole word part (`api_key`, `auth-token`, `DB_PASSWORD`) rather
 * than as a substring, because the substring version masks `keychain`,
 * `keyboard` and `monkey` — and a rule that eats ordinary prose gets turned off,
 * which protects nothing.
 */
const SENSITIVE_KEY =
  /(?:^|[_.\-[\]])(?:api_?key|key|token|secret|password|passwd|pwd|credential|auth|authorization|bearer|session_?id_?secret|private_?key)(?:$|[_.\-[\]])/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(`_${key}_`);
}

/**
 * Values that a `key = value` rule must leave alone.
 *
 * A path, a URL, a number and a boolean are the four things that sit next to a
 * credential-ish name in real text — `KEY_PATH=/Users/x/id_rsa`,
 * `auth_url=https://…`, `token_ttl=3600`, `useAuth=true` — and masking them
 * destroys the line while hiding nothing.
 */
function isBoringValue(value: string): boolean {
  if (/^[0-9]+$/.test(value)) return true;
  if (/^(?:true|false|null|undefined|none|yes|no)$/i.test(value)) return true;
  if (value.startsWith("$") || value.startsWith("%")) return true; // a reference, not a value
  if (value.includes("/") || value.startsWith("~")) return true; // path or URL
  return false;
}

/** Shannon entropy in bits per character. */
export function entropyOf(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Long enough that a word or an identifier cannot reach it by accident. */
const ENTROPY_MIN_LENGTH = 28;
/** Bits per character. Base64 noise sits near 5.5; English prose near 4. */
const ENTROPY_MIN_BITS = 4.2;

/**
 * Does this look like a credential nobody published a shape for?
 *
 * Every rule here is a way of saying "this is not one": a git sha and a checksum
 * are hex, an id is a UUID, a slug is kebab-case, and a base64 blob in a prompt
 * is usually a pasted image. Requiring all three character classes is what keeps
 * the pass off file paths, branch names and long identifiers.
 */
export function looksHighEntropy(value: string): boolean {
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  if (/^[0-9a-f]+$/i.test(value)) return false; // sha, md5, checksum
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  // `=` is base64 padding and only ever trails. In the middle it means the token
  // is really `name=value` — a query parameter or a header, which measured on the
  // transcript store here was most of what this pass got wrong.
  if (/=[^=]/.test(value)) return false;
  // Ids the tooling itself emits, which look exactly like secrets and are not.
  if (/^(?:toolu|msg|req|run|call|session)_/i.test(value)) return false;
  return entropyOf(value) >= ENTROPY_MIN_BITS;
}

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

export interface RedactOptions {
  /**
   * Also mask long, high-entropy strings that match no known shape.
   *
   * Every threshold this uses was set by measurement rather than taste. Run over
   * the transcript store on this machine (963 prompts, 120 conversations): the
   * first draft rewrote 10.8% of prompts, all of them file paths; after dropping
   * `/` from the candidate class and refusing `name=value` tokens and the ids the
   * tooling emits, it rewrites **0.3%**, and every remaining hit is a JWT payload
   * or a base64 blob. Re-measure with `scripts` of the same shape before loosening
   * any of it — a pass that scrubs prompts into nonsense gets switched off, and
   * then it protects nothing.
   */
  entropy?: boolean;
}

/**
 * Mask known secret values and well-known credential shapes in `text`.
 *
 * `secrets` are the plaintext values of env vars marked secret. Passing them is
 * the caller's job (see `services/session-ledger.ts`), which keeps this pure.
 */
export function redactVerbose(
  text: string,
  secrets: readonly string[] = [],
  options: RedactOptions = {},
): RedactResult {
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

  // A credential with no published shape, named by the field it sits in. Run
  // after the shape rules so a recognised token is reported under its own name.
  out = out.replace(
    // The separator swallows a closing quote so a JSON key (`"auth_token": "…"`)
    // is matched by the same rule as a shell one (`AUTH_TOKEN=…`).
    /([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`,;]{8,})\3/g,
    (match, key: string, sep: string, quote: string, value: string) => {
      if (!isSensitiveKey(key) || isBoringValue(value) || value === MASK) return match;
      hits.push("credential-assignment");
      return `${key}${sep}${quote}${MASK}${quote}`;
    },
  );

  if (options.entropy) {
    // No `/` in the candidate class, measured: with it, a path is one long token
    // with mixed case and digits and the pass masks it. Without it the same path
    // is a run of short segments and nothing fires. A base64 blob containing `/`
    // loses a little coverage in exchange, which is the right trade for a rule
    // that is off by default anyway.
    out = out.replace(/\b[A-Za-z0-9+=_-]{28,}\b/g, (candidate) => {
      if (!looksHighEntropy(candidate)) return candidate;
      hits.push("entropy");
      return MASK;
    });
  }

  return { text: out, hits: [...new Set(hits)] };
}

/** The common case: give me the safe text. */
export function redact(
  text: string,
  secrets: readonly string[] = [],
  options: RedactOptions = {},
): string {
  return redactVerbose(text, secrets, options).text;
}

/**
 * The same scrubbing, applied through a JSON structure instead of across its
 * printed form.
 *
 * Why it is not enough to stringify and run the text pass: a tool call's
 * arguments carry the credential under a name (`{"headers":{"Authorization":"…"}}`),
 * and once flattened the name and the value are just two strings that happen to
 * be adjacent. Walking the structure lets a sensitive *key* condemn its value
 * whatever that value looks like — which is the only rule that catches a
 * credential from an issuer nobody has a pattern for.
 *
 * Returns a new value; the input is never mutated. Depth is capped and cycles
 * are refused, because this runs on data the app did not author.
 */
export function redactJson(
  value: unknown,
  secrets: readonly string[] = [],
  options: RedactOptions = {},
): unknown {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number, keyName: string | null): unknown => {
    if (depth > 12) return node;
    if (typeof node === "string") {
      if (keyName && isSensitiveKey(keyName) && !isBoringValue(node)) return MASK;
      return redact(node, secrets, options);
    }
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return "«cycle»";
    seen.add(node);

    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1, keyName));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = walk(child, depth + 1, key);
    }
    return out;
  };

  return walk(value, 0, null);
}
