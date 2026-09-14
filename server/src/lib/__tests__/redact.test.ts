import { describe, expect, it } from "vitest";
import { MASK, redact, redactVerbose } from "../redact";

describe("redact — known secret values", () => {
  it("masks a secret env value wherever it appears", () => {
    const out = redact("deploy with TOKEN=s3cret-value-123 then retry s3cret-value-123", [
      "s3cret-value-123",
    ]);
    expect(out).toBe(`deploy with TOKEN=${MASK} then retry ${MASK}`);
  });

  it("ignores short values, so 'true' or a port number can't blank out prose", () => {
    const out = redact("set DEBUG=true on port 8080 and it is true again", ["true", "8080"]);
    expect(out).toBe("set DEBUG=true on port 8080 and it is true again");
  });

  it("masks the longest secret first when one contains another", () => {
    // Masking "abcdefgh" first would leave "-suffix" dangling in the text.
    const out = redact("value abcdefgh-suffix here", ["abcdefgh", "abcdefgh-suffix"]);
    expect(out).toBe(`value ${MASK} here`);
  });

  it("treats a secret with regex metacharacters literally", () => {
    const out = redact("pass a.b+c/d=e now", ["a.b+c/d=e"]);
    expect(out).toBe(`pass ${MASK} now`);
  });

  it("leaves text alone when there are no secrets and nothing matches", () => {
    const text = "fix the tmux toggle in web/src/features/terminals/TerminalPane.tsx";
    expect(redact(text)).toBe(text);
  });
});

describe("redact — credential shapes", () => {
  const cases: [string, string][] = [
    ["github-token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["github-fine-grained", "github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ0123456789"],
    ["atlassian-token", "ATATT3xFfGF0T4Ml9kBcDeFgHiJkLmNoPqRsTuVwXyZ012345"],
    ["anthropic-key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    // Assembled rather than written out: a whole one, even an invented one, is
    // shaped closely enough that GitHub's push protection rejects the push.
    ["slack-token", ["xoxb", "123456789012", "abcdefghijklmno"].join("-")],
    ["aws-access-key", "AKIAIOSFODNN7EXAMPLE"],
    ["google-api-key", `AIza${"SyA1234567890abcdefghij".padEnd(35, "x")}`],
  ];

  it("uses a realistically shaped google key in the case above (AIza + 35)", () => {
    const key = cases.find(([n]) => n === "google-api-key")![1];
    expect(key).toHaveLength(39);
  });

  for (const [name, value] of cases) {
    it(`masks a ${name}`, () => {
      const { text, hits } = redactVerbose(`export KEY=${value}`);
      expect(text).toBe(`export KEY=${MASK}`);
      expect(hits).toContain(name);
    });
  }

  it("keeps the header name and scheme, drops the credential", () => {
    const out = redact("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'");
    expect(out).toBe(`curl -H 'Authorization: Bearer ${MASK}'`);
  });

  it("masks a whole PEM block, footer included", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEogIBAAKCAQEAxyz",
      "abc123def456",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redact(`key:\n${pem}\ndone`)).toBe(`key:\n${MASK}\ndone`);
  });

  it("keeps the host of a database URL but drops the password", () => {
    const out = redact("postgres://appuser:hunter2hunter2@db.internal:5432/reelme");
    expect(out).toBe(`postgres://appuser:${MASK}@db.internal:5432/reelme`);
    expect(out).toContain("db.internal:5432/reelme");
  });
});

describe("redact — what must NOT be touched", () => {
  it("leaves a git sha alone", () => {
    const text = "regression came in at 5baedf0 / 0a8aeb5f2c1d4e6a8b9c0d1e2f3a4b5c6d7e8f90";
    expect(redact(text)).toBe(text);
  });

  it("leaves ordinary paths, flags and URLs alone", () => {
    const text = "run `claude --session-id 21b3ef56-81e1-4fc2-95a6-25aeeeffbe93` in ~/iOS/IIP707";
    expect(redact(text)).toBe(text);
  });

  it("leaves a URL with no credentials alone", () => {
    const text = "open https://jira.apero.vn/browse/IIP555-1234 for the ticket";
    expect(redact(text)).toBe(text);
  });

  it("returns empty text untouched", () => {
    expect(redactVerbose("")).toEqual({ text: "", hits: [] });
  });
});

describe("redactVerbose hits", () => {
  it("reports each rule once, even when it fired repeatedly", () => {
    const { hits } = redactVerbose("a ghp_AAAAAAAAAAAAAAAAAAAA b ghp_BBBBBBBBBBBBBBBBBBBB", ["x"]);
    expect(hits).toEqual(["github-token"]);
  });

  it("reports env-secret separately from a shape match", () => {
    const { hits } = redactVerbose("mine=abcdefghijk and ghp_AAAAAAAAAAAAAAAAAAAA", [
      "abcdefghijk",
    ]);
    expect(hits).toEqual(["env-secret", "github-token"]);
  });
});
