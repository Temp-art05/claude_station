import { describe, expect, it } from "vitest";
import { MASK, redact, redactJson, redactVerbose } from "../redact";

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

describe("redact — credential named by its field", () => {
  it("masks a value whose key says it is a secret, whatever it looks like", () => {
    expect(redact("API_KEY=plainlookingvalue")).toBe(`API_KEY=${MASK}`);
    expect(redact('{"auth_token": "abcdefghijkl"}')).toBe(`{"auth_token": "${MASK}"}`);
  });

  it("leaves a path, a URL, a number and a boolean alone next to that name", () => {
    // Every one of these sits beside a credential-ish name in real text, and
    // masking them destroys the line while hiding nothing.
    const text = "KEY_PATH=/Users/x/id_rsa auth_url=https://x.dev token_ttl=3600 useAuth=true";
    expect(redact(text)).toBe(text);
  });

  it("does not treat keychain, keyboard or monkey as a key", () => {
    const text = "keychain=somethinglong keyboard=mechanical monkey=business";
    expect(redact(text)).toBe(text);
  });
});

describe("redact — entropy pass", () => {
  const blob = "A0K0EHbTRapaWKmaCkElLCf6BxykVN99pFNr8yB8BH";

  it("stays out of the way unless asked for", () => {
    expect(redact(`blob ${blob}`)).toBe(`blob ${blob}`);
    expect(redact(`blob ${blob}`, [], { entropy: true })).toBe(`blob ${MASK}`);
  });

  it("leaves a path alone — the failure that made this measurable", () => {
    // The first draft masked this: with `/` in the candidate class a path is one
    // long mixed-case token. 10.8% of real prompts were rewritten this way.
    const text = "see /Users/dinhngocthe/SkillsAgent/claude_station/data/agents/jira-ai-fixer";
    expect(redact(text, [], { entropy: true })).toBe(text);
  });

  it("leaves a git sha, a UUID and a query parameter alone", () => {
    const text = [
      "0a8aeb5f2c1d4e6a8b9c0d1e2f3a4b5c6d7e8f90",
      "21b3ef56-81e1-4fc2-95a6-25aeeeffbe93",
      "X-Amz-Content-Sha256=UNSIGNED-PAYLOAD",
    ].join(" ");
    expect(redact(text, [], { entropy: true })).toBe(text);
  });

  it("leaves the ids the tooling itself emits alone", () => {
    const text = "tool call toolu_01Soqez3VMxDmWyvRJKT8r5dAAAA failed";
    expect(redact(text, [], { entropy: true })).toBe(text);
  });
});

describe("redactJson", () => {
  it("condemns a value by the name it is filed under", () => {
    const out = redactJson({
      headers: {
        Authorization: "opaque-value-nobody-has-a-pattern-for",
        Accept: "application/json",
      },
    }) as { headers: Record<string, string> };
    expect(out.headers.Authorization).toBe(MASK);
    expect(out.headers.Accept).toBe("application/json");
  });

  it("still runs the text rules on ordinary strings", () => {
    const out = redactJson({ note: "use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here" }) as {
      note: string;
    };
    expect(out.note).toBe(`use ${MASK} here`);
  });

  it("walks arrays and leaves non-strings as they are", () => {
    const out = redactJson({ items: [{ password: "hunter2hunter2" }, { count: 3, ok: true }] }) as {
      items: [{ password: string }, { count: number; ok: boolean }];
    };
    expect(out.items[0].password).toBe(MASK);
    expect(out.items[1]).toEqual({ count: 3, ok: true });
  });

  it("does not mutate the input", () => {
    const input = { token: "abcdefghijkl" };
    redactJson(input);
    expect(input.token).toBe("abcdefghijkl");
  });

  it("refuses a cycle instead of hanging", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    expect(() => redactJson(node)).not.toThrow();
  });
});
