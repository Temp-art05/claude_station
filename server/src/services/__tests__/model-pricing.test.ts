/**
 * The price table, and the one thing it must never do: answer for a model it
 * does not know. Every test here that asserts `null` is asserting that a turn
 * stays visibly unpriced rather than quietly wrong.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The cache has to live somewhere disposable, or this test overwrites the price
 * table the running app reads. Built from `process.pid` rather than `mkdtemp`
 * because `vi.mock` factories are hoisted above every import in the file, so the
 * path has to exist as a value before `node:fs` is available to call.
 */
const DIR = join(tmpdir(), `cs-pricing-${process.pid}`);

vi.mock("../../lib/config", () => ({ setting: () => true }));
vi.mock("../../lib/data-dir", () => ({ DATA_DIR: DIR }));

mkdirSync(DIR, { recursive: true });
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const { canonical, estimateCost, normalise, priceFor, forgetPrices } =
  await import("../model-pricing");

const MODELS_DEV = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-5": {
        id: "claude-opus-5",
        cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 1, output: 5, cache_read: 0.1 },
      },
      broken: { id: "broken", cost: { output: 5 } },
    },
  },
  bedrock: {
    id: "bedrock",
    models: {
      "claude-opus-5": { id: "claude-opus-5", cost: { input: 18, output: 90 } },
    },
  },
};

describe("normalise", () => {
  it("keys a model by its bare id and by provider/id", () => {
    const models = normalise(MODELS_DEV);
    expect(models["claude-opus-5"]!.input).toBe(15);
    expect(models["anthropic/claude-opus-5"]!.input).toBe(15);
    expect(models["bedrock/claude-opus-5"]!.input).toBe(18);
  });

  it("gives the bare id to the first party even when a reseller was listed first", () => {
    // models.dev is mostly resellers: ~10k entries for a few hundred models. If
    // whoever sorts first owns the bare name, the headline price is an
    // aggregator's markup, and nothing in a ledger row says which it was.
    const models = normalise({
      "some-gateway": {
        models: { "claude-opus-5": { cost: { input: 99, output: 200 } } },
      },
      anthropic: {
        models: { "claude-opus-5": { cost: { input: 15, output: 75 } } },
      },
    });
    expect(models["claude-opus-5"]!.input).toBe(15);
    expect(models["some-gateway/claude-opus-5"]!.input).toBe(99);
  });

  it("keeps the first reseller when no first party offers the model at all", () => {
    const models = normalise({
      "gateway-a": { models: { "mystery-1": { cost: { input: 1, output: 2 } } } },
      "gateway-b": { models: { "mystery-1": { cost: { input: 9, output: 9 } } } },
    });
    expect(models["mystery-1"]!.input).toBe(1);
  });

  it("skips a model whose price is only half known", () => {
    expect(normalise(MODELS_DEV).broken).toBeUndefined();
  });

  it("returns nothing for a shape it has never seen", () => {
    expect(normalise(null)).toEqual({});
    expect(normalise({ anthropic: { models: "nope" } })).toEqual({});
  });
});

describe("canonical", () => {
  it("drops a dated release suffix", () => {
    expect(canonical("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  it("drops the context-window suffix Claude Code appends", () => {
    expect(canonical("claude-opus-5[1m]")).toBe("claude-opus-5");
  });

  it("drops a vendor prefix from Bedrock or Vertex", () => {
    expect(canonical("anthropic.claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("priceFor", () => {
  it("answers for an exact id, and for a dated one through its undated key", () => {
    const table = { fetchedAt: "now", source: "test", models: normalise(MODELS_DEV) };
    writeFileSync(join(DIR, "models-pricing.json"), JSON.stringify(table));
    forgetPrices();

    expect(priceFor("claude-opus-5")?.input).toBe(15);
    expect(priceFor("claude-opus-5-20260101")?.input).toBe(15);
    expect(priceFor("claude-haiku-4-5[1m]")?.input).toBe(1);
  });

  it("refuses a model it has never heard of", () => {
    expect(priceFor("gpt-9-turbo")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });
});

describe("estimateCost", () => {
  it("prices cache reads at the cache rate, never at the input rate", () => {
    const usd = estimateCost("claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 0,
    });
    // 15 for the input million + 1.5 for the cached million. Folding the cache
    // into input would say 30 and inflate every long session.
    expect(usd).toBeCloseTo(16.5, 6);
  });

  it("contributes nothing for cache tokens when the model has no cache price", () => {
    const usd = estimateCost("claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 1_000_000,
    });
    expect(usd).toBe(0);
  });

  it("returns null for an unknown model instead of zero", () => {
    expect(
      estimateCost("mystery-model", {
        inputTokens: 5_000,
        outputTokens: 5_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      }),
    ).toBeNull();
  });
});
