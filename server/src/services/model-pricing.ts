/**
 * What a turn cost, when nobody told us.
 *
 * The Agent SDK reports `total_cost_usd` on every result; the `claude` CLI reports
 * nothing of the kind, and its transcript never will. That is why
 * `session_turns.costUsd` is NULL for every CLI turn — measured, not assumed. The
 * consequence only became visible with A3: a dashboard built on this ledger shows
 * a cost column that is blank for the surface people actually use all day.
 *
 * So: price the tokens ourselves, from a table we fetch rather than hardcode. A
 * hardcoded table rots silently — every number it produced stays wrong and looks
 * measured. models.dev publishes prices per model per provider and is what Atlas
 * uses for the same job (`src-tauri/src/commands/models_pricing.rs`).
 *
 * Three rules this file keeps:
 *   - Never blocks a turn. The table is read from a cache file; a refresh is a
 *     background job that fails silently.
 *   - Never pretends. A price we don't have is not a price we guess: the turn
 *     stays `unknown` and the UI shows tokens instead of money.
 *   - Never the only truth. A cost the SDK reported always wins over one derived
 *     here, and the two are told apart by `session_turns.costSource`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../lib/data-dir";
import { setting } from "../lib/config";

/** USD per million tokens, the unit models.dev publishes. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface PriceTable {
  /** When the table was last fetched, so the UI can say how stale it is. */
  fetchedAt: string;
  source: string;
  /** Model id (and `provider/model id`) -> price. */
  models: Record<string, ModelPrice>;
}

const CACHE_PATH = join(DATA_DIR, "models-pricing.json");
const SOURCE_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 10_000;

let table: PriceTable | null = null;
let loaded = false;

// -- the table ----------------------------------------------------------------

/** The cached table, read from disk once. Absent until a refresh has succeeded. */
export function priceTable(): PriceTable | null {
  if (loaded) return table;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as PriceTable;
    table = parsed && typeof parsed.models === "object" ? parsed : null;
  } catch {
    table = null; // no cache yet, or a corrupt one — a refresh rewrites it
  }
  return table;
}

/** Drop the in-memory copy — for tests, and after a refresh writes a new file. */
export function forgetPrices(): void {
  loaded = false;
  table = null;
}

/**
 * Providers whose price for a model is the one a bare model id should mean.
 *
 * models.dev lists ~10k entries, and the same model is resold by dozens of
 * gateways at their own markup — `claude-opus-4-8` is offered by a reseller that
 * happens to sort first, so "whoever we saw first owns the bare name" hands the
 * headline price to an aggregator nobody here uses. A ledger row records a bare
 * model id and nothing about who served it, so the bare name has to resolve to
 * the first party.
 */
const FIRST_PARTY = new Set([
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "aws-bedrock",
  "azure",
  "azure-anthropic",
  "xai",
  "deepseek",
  "mistral",
  "groq",
]);

/**
 * Fold models.dev's shape into a flat price map.
 *
 * Deliberately structural rather than typed against their schema: the response is
 * `{ provider: { models: { id: { cost: {...} } } } }` today, and a shape we walk
 * defensively survives them adding a level. Anything without a numeric input and
 * output price is skipped — a half-known price is not a price.
 */
export function normalise(raw: unknown): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  /** Who currently owns each bare id, so a first party can take it back. */
  const owner: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;

  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof provider !== "object" || provider === null) continue;
    const models = (provider as Record<string, unknown>).models;
    if (typeof models !== "object" || models === null) continue;

    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (typeof model !== "object" || model === null) continue;
      const cost = (model as Record<string, unknown>).cost;
      if (typeof cost !== "object" || cost === null) continue;
      const c = cost as Record<string, unknown>;
      const input = num(c.input);
      const output = num(c.output);
      if (input === null || output === null) continue;

      const price: ModelPrice = {
        input,
        output,
        cacheRead: num(c.cache_read),
        cacheWrite: num(c.cache_write),
      };
      // Both spellings: a turn records the bare model id, but two providers can
      // serve the same name at different prices, and the qualified key is what
      // lets a caller that knows the provider say so.
      out[`${providerId}/${modelId}`] = price;
      const claimed = modelId in out;
      if (!claimed || (FIRST_PARTY.has(providerId) && !FIRST_PARTY.has(owner[modelId] ?? ""))) {
        out[modelId] = price;
        owner[modelId] = providerId;
      }
    }
  }
  return out;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Fetch the table and cache it. Returns what changed, so boot can log something
 * useful and say nothing at all when nothing moved.
 */
export async function refreshPrices(): Promise<{ models: number; changed: boolean } | null> {
  if (!setting("pricing.enabled")) return null;
  let raw: unknown;
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    raw = await res.json();
  } catch {
    return null; // offline, DNS, timeout — the cached table stays in force
  }

  const models = normalise(raw);
  if (Object.keys(models).length === 0) return null;

  const before = priceTable();
  const changed = JSON.stringify(before?.models ?? {}) !== JSON.stringify(models);
  if (!changed) return { models: Object.keys(models).length, changed: false };

  const next: PriceTable = { fetchedAt: new Date().toISOString(), source: SOURCE_URL, models };
  try {
    writeFileSync(CACHE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    return null;
  }
  forgetPrices();
  return { models: Object.keys(models).length, changed: true };
}

// -- matching a model id ------------------------------------------------------

/**
 * Normalise a model id the way it is actually written down.
 *
 * Three things the ledger records that the price table does not spell the same:
 * a dated release (`claude-sonnet-4-5-20250929`), a context-window suffix Claude
 * Code appends (`claude-opus-5[1m]`), and a provider-qualified id from Bedrock or
 * Vertex (`anthropic.claude-…-v1:0`). Strip to the part that can match.
 */
export function canonical(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/[-@]\d{8}$/, "")
    .replace(/^(?:anthropic|openai|google|bedrock|vertex|us|eu)[./]/, "");
}

/**
 * The price for a model id, or null when we genuinely don't know.
 *
 * Exact match first, then the canonical form, then the longest key that is a
 * prefix of it (so an undated key prices a dated id). Longest wins so
 * `claude-opus-5` never answers for `claude-opus-5-1` when the latter exists.
 * No fuzzy matching beyond that: pricing the wrong model is worse than not
 * pricing it.
 */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const models = priceTable()?.models;
  if (!models) return null;

  if (models[model]) return models[model];
  const key = canonical(model);
  if (models[key]) return models[key];

  let best: { key: string; price: ModelPrice } | null = null;
  for (const [candidate, price] of Object.entries(models)) {
    const bare = candidate.includes("/") ? candidate.slice(candidate.indexOf("/") + 1) : candidate;
    if (!key.startsWith(bare)) continue;
    if (!best || bare.length > best.key.length) best = { key: bare, price };
  }
  return best?.price ?? null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/**
 * What those tokens would have cost, in USD.
 *
 * Cache tokens are priced at their own rate and never folded into input — a
 * cache read is roughly a tenth of an input token, so adding them together
 * inflates a long session into fiction. A model whose entry carries no cache
 * price contributes nothing for those tokens rather than borrowing the input
 * rate: the total is already labelled an estimate, and an estimate that
 * undershoots a little beats one that invents a rate.
 */
export function estimateCost(model: string | null | undefined, tokens: TokenCounts): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const usd =
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * (price.cacheRead ?? 0) +
      tokens.cacheCreateTokens * (price.cacheWrite ?? 0)) /
    1_000_000;
  return Number.isFinite(usd) ? usd : null;
}
