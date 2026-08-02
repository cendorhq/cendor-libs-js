/**
 * Offline-first price registry: a bundled snapshot plus an optional live `refresh()`. The TS mirror of
 * `cendor.core.prices`. Costs are exact `Decimal` `Money` — never IEEE floats (price-dataset spec
 * `prices/1`). `refresh()` is async here (JS is async-first; Python's sync `urllib` becomes `fetch`).
 */
import { Dec, type Decimal, type DecimalValue } from './decimal.js';
import { type DecimalJsonValue, parseDecimalJson } from './json-decimal.js';
import { PRICES_JSON } from './prices-snapshot.js';
import { Money } from './types.js';

/** Raised when a model id is not present in the price table. */
export class UnknownModelError extends Error {
  constructor(model: string) {
    super(model);
    this.name = 'UnknownModelError';
  }
}

/**
 * Thrown when a model IS in the table but its rates cannot price a call.
 *
 * A **subclass of** {@link UnknownModelError} on purpose: every caller that already handles "I
 * cannot price this" keeps working unchanged — `instrument()`, `otel`, the LangChain handler and
 * `tokenguard` all catch and fall back to an honest `null`/warn-once. Catch this specific type only
 * when you want to tell *"no such model"* apart from *"known model, unusable rate"*.
 *
 * Thrown for a rate a **table** left absent, or an input rate a table states as `0` — both are
 * indistinguishable from "we do not know", and {@link estimate} returning `$0.00` for them reports
 * a fabricated cost as a *fact* while a USD budget cap silently never binds. A rate **you**
 * registered is never second-guessed: `prices.register('llama3', { input: 0, output: 0 })` prices a
 * local model at zero because you said so. (Python parity: `prices.MissingRateError`.)
 */
export class MissingRateError extends UnknownModelError {
  constructor(model: string, key: 'input' | 'output', why: string) {
    const id = JSON.stringify(model);
    super(
      `the price table ${why} for ${id}, so this call cannot be priced. An absent or zero rate is \
indistinguishable from 'we do not know': pricing it as $0.00 would report a fabricated cost as a \
fact, and a USD budget cap would silently never bind on it.
Set the rate yourself:
    prices.registerModelPrice(${id}, { input: …, output: … })
    prices.register(${id}, { input: …, output: … })   // per-token
If this model genuinely bills nothing for ${key}, say so explicitly — an explicit ${key}: 0 is \
honoured, an absent one is not.`,
    );
    this.name = 'MissingRateError';
  }
}

/**
 * Thrown by `refresh(url, { required: true })` when the fetch/parse/map failed.
 *
 * `refresh()` is contractually never-throw: it resolves `false` and leaves the last-good table
 * active. Pass `required: true` when running on stale rates would be worse than not running — then
 * a failure is loud. Never the default. (Python parity: `prices.PriceRefreshError`.)
 */
export class PriceRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceRefreshError';
  }
}

type Rates = Record<string, Decimal>;
interface Table {
  _updated?: string;
  models: Record<string, Rates>;
  _provenance?: Record<string, { src?: string; asof?: string }>;
  _saved?: { source_name?: string; source_url?: string | null; origin?: string };
}

let table: Table | null = null;
let sourceKind = 'bundled'; // "bundled" | "refreshed" | "loaded"
// "bundled" | "feed" | "azure" | "aws" | "modelsdev" | "litellm" | "openrouter" | "vercel" | "custom"
let sourceNameValue = 'bundled';
let sourceUrlValue: string | null = null;
/** Programmatic registrations (see {@link register}) — re-applied on top of every loaded or
 * refreshed table, so a `refresh()` never drops them. */
const registered: Record<string, Rates> = {};

/**
 * Default table used by `refresh()` when no url or source is given: the **cendor-prices feed** — a
 * dated, per-row-provenanced `prices/1` table rebuilt daily behind validation gates and served by
 * GitHub Pages. Cendor operates no server for this; it is a static file on GitHub's CDN, so no
 * Cendor outage can exist to break your cost estimation.
 *
 * ⚠️ It is a **Pages** URL, not `raw.githubusercontent`. The builder repo is private — the source,
 * the curation policy and the run history are internal — while a data-only `gh-pages` branch
 * publishes the file itself, keyless. Pages also serves it as `application/json` rather than raw's
 * `text/plain`. Do not "correct" this back to a raw URL: that one needs auth and 404s.
 */
export const SNAPSHOT_URL = 'https://cendorhq.github.io/cendor-prices/prices.json';
export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** OpenRouter's public model catalog. Gateway **resale** prices: what OpenRouter charges you. */
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
/** Vercel AI Gateway's catalog — same shape and the same resale caveat as OpenRouter. Base rates
 * only; its tiered (long-context) and service-tier prices are out of scope. */
export const VERCEL_URL = 'https://ai-gateway.vercel.sh/v1/models';
/** models.dev — MIT, the widest keyless catalog found (177 providers / 5,935 models on
 * 2026-08-01), per-**1M** rates with a per-row `last_updated`. */
export const MODELSDEV_URL = 'https://models.dev/api.json';

export const AZURE_API = 'https://prices.azure.com/api/retail/prices';
export const AZURE_API_VERSION = '2023-01-01-preview';
/** Region whose meters `refresh({ source: 'azure' })` reads. eastus2 carries the largest Foundry
 * catalog (1,526 meters on 2026-08-01). Override with `refresh(undefined, { source: 'azure',
 * region })`. */
export const AZURE_DEFAULT_REGION = 'eastus2';
export const AWS_PRICING_HOST = 'https://pricing.us-east-1.amazonaws.com';
/**
 * ⚠️ **Both** offer codes are required. Measured 2026-08-01: `AmazonBedrock` alone carries only
 * Claude 2.0/2.1/3-Haiku/3-Sonnet/Instant — `Claude Sonnet 4` and `Claude Sonnet 4.5` exist **only**
 * in `AmazonBedrockService`, so a single-offer client silently misses every current Claude rate.
 */
export const AWS_OFFERS = ['AmazonBedrock', 'AmazonBedrockService'] as const;
export const AWS_DEFAULT_REGION = 'us-east-1';

/**
 * The Azure Retail Prices query `refresh({ source: 'azure' })` issues, for one region.
 *
 * ⚠️ **The region term is not an optimisation.** Measured 2026-08-01: with a region this query is
 * 1,526 meters over 2 pages in 0.7 s; without one it is **≥25,000 rows and still paging after
 * 28.5 s** — not something a library may do inside one `refresh()`.
 *
 * ⚠️ `serviceName eq 'Foundry Models'` replaced the pre-rename `productName eq 'Azure OpenAI'`. The
 * old filter still returns rows, which is why nothing looked broken — it just saw 462 of the 1,526
 * and **no GPT-5, DeepSeek, Grok, Mistral, Llama, Phi, Kimi, Qwen or Cohere meter at all**.
 *
 * The apostrophes are percent-encoded by hand: `encodeURIComponent` leaves `'` alone but Python's
 * `quote` escapes it, and the two URLs must be byte-identical so the twins can be diffed. That is
 * how the original Azure URL defect stayed invisible for so long.
 */
export function azureUrl(region: string = AZURE_DEFAULT_REGION): string {
  const filter = encodeURIComponent(
    `serviceName eq 'Foundry Models' and armRegionName eq '${region}'`,
  ).replace(/'/g, '%27');
  return `${AZURE_API}?api-version=${AZURE_API_VERSION}&${encodeURIComponent('$filter')}=${filter}`;
}

/** The URL `refresh({ source: 'azure' })` uses by default; {@link azureUrl} is the region-aware form. */
export const AZURE_URL = azureUrl();
/** The AWS region index the `aws` source resolves before fetching a region file. */
export const AWS_URL = `${AWS_PRICING_HOST}/offers/v1.0/aws/{offer}/current/region_index.json`;

/** Optional explicit id aliases applied after prefix-stripping (extend as needed). */
const ALIASES: Record<string, string> = {};

function ensureLoaded(): Table {
  if (table === null) {
    const t = parseDecimalJson(PRICES_JSON) as unknown as Table;
    if (!t.models) t.models = {};
    Object.assign(t.models, registered); // re-apply programmatic registrations (see register)
    table = t;
  }
  return table;
}

// Wire-level id decorations stripped at LOOKUP time (the table keys stay bare). Alpha-only dotted
// prefixes cover Bedrock vendor/region namespaces (`anthropic.`, `us.anthropic.`) without touching
// in-name dots like `gpt-4.1` / `gemini-2.5-pro` (those have digits adjacent to the dot).
const PROVIDER_PREFIX_RE = /^(?:[a-z]+\.)+/;
const BEDROCK_VERSION_RE = /-v\d+(?::\d+)?$/; // trailing `-v1:0` / `-v2`
const DATE_SUFFIX_RE = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/; // `-20260115` / `-2025-11-13`

/**
 * Reduce a wire-level model id to a bare table key, e.g.
 * `us.anthropic.claude-sonnet-4-6-20260115-v1:0` → `claude-sonnet-4-6` and
 * `gpt-5.1-2025-11-13` → `gpt-5.1`. Applied only when the exact id misses the table.
 */
function lookupId(mid: string): string {
  let s = normalizeModelId(mid);
  s = s.replace(PROVIDER_PREFIX_RE, '');
  s = s.replace(BEDROCK_VERSION_RE, '');
  s = s.replace(DATE_SUFFIX_RE, '');
  return ALIASES[s] ?? s;
}

function ratesFor(model: string): Rates {
  const models = ensureLoaded().models ?? {};
  // Bedrock/dated/prefixed ids price like their base model; normalization never invents a price.
  const r = models[model] ?? models[lookupId(model)];
  if (r === undefined) throw new UnknownModelError(model);
  return r;
}

/**
 * Did *you* write these rates with `register`, rather than a table supplying them?
 *
 * The distinction is the whole reason a zero can be legal: the spec already says a user
 * registration outranks any table, so `register('llama3', { input: 0, output: 0 })` is a person
 * stating a fact, while a `0` arriving inside a fetched table is a parser having lost one.
 */
function isRegisteredRate(model: string): boolean {
  return registered[model] !== undefined || registered[lookupId(model)] !== undefined;
}

/**
 * Refuse rates that cannot price a call, instead of quietly treating the gap as free.
 *
 * Applied whenever {@link estimate} looks a model up — **not** only when the call happens to carry
 * output tokens. A table that cannot price this model cannot price it, and finding that out on the
 * first output-bearing call rather than the first call is exactly the kind of late, partial signal
 * this rule exists to remove.
 *
 * Symmetric across the two rate keys with no defined fallback (`cached` and `cache_write` do have
 * one, stated in the spec, so their absence is a default and not a gap).
 */
function assertPriceable(r: Rates, model: string): void {
  if (r.input === undefined) throw new MissingRateError(model, 'input', 'has no INPUT rate');
  if (r.input.lte(0) && !isRegisteredRate(model)) {
    throw new MissingRateError(model, 'input', 'states a zero INPUT rate');
  }
  if (r.output === undefined) throw new MissingRateError(model, 'output', 'has no OUTPUT rate');
}

export interface EstimateOptions {
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Estimate the cost of a call from the price snapshot, as exact `Decimal` `Money`. `cachedTokens` is a
 * subset of `inputTokens`, billed once: `input*(input−cached) + cached*cachedRate`. Unknown model
 * throws {@link UnknownModelError}. Mirrors `cendor.core.prices.estimate`.
 *
 * `outputTokens` (and the cache args) ride an **options object** — a documented divergence from
 * Python, where they are positional (`prices.estimate(model, n, outputTokens)`).
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * const cost = prices.estimate('gpt-4o', 1200, { outputTokens: 300 });
 * ```
 */
export function estimate(model: string, inputTokens: number, opts: EstimateOptions = {}): Money {
  const outputTokens = opts.outputTokens ?? 0;
  const cachedTokens = opts.cachedTokens ?? 0;
  const cacheWriteTokens = opts.cacheWriteTokens ?? 0;
  const r = ratesFor(model);
  assertPriceable(r, model); // an absent or zero-in-a-table rate is UNKNOWN, never free
  const cached = Math.min(Math.max(cachedTokens, 0), inputTokens); // cached ⊆ input; clamp defensively
  const inputRate = r.input as Decimal;
  const cachedRate = 'cached' in r ? (r.cached as Decimal) : inputRate;
  const writeRate = 'cache_write' in r ? (r.cache_write as Decimal) : inputRate.times('1.25');
  const outputRate = r.output as Decimal;
  const amount = inputRate
    .times(inputTokens - cached)
    .plus(outputRate.times(outputTokens))
    .plus(cachedRate.times(cached))
    .plus(writeRate.times(Math.max(cacheWriteTokens, 0)));
  return new Money(amount);
}

export interface RegisterRates {
  input: DecimalValue;
  output?: DecimalValue;
  cached?: DecimalValue;
  cache_write?: DecimalValue;
}

/**
 * Register (or overwrite) a model's **per-token** rates in the active price table, so a model absent
 * from the bundled snapshot (a custom/deployment/Hub id) is costed and USD budgets bind on it.
 * Rates are exact `Decimal`. {@link registerModelPrice} is the higher-level form that takes the
 * **per-1M** numbers a published rate card quotes and does the unit conversion before calling this.
 * Registrations **survive `refresh()`** (re-applied after every table swap, overriding a snapshot
 * entry with the same id); dropped by {@link _reset}.
 * (Python parity: `prices.register(model, rates)` per-token since `cendor-core` 1.15.0, plus
 * `prices.register_model_price(model, input=…, output=…, per="1M")` for the per-1M form.)
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * prices.register('my-model', { input: '0.000001', output: '0.000002' });  // per-token Decimal rates
 * ```
 */
export function register(model: string, rates: RegisterRates): void {
  const t = ensureLoaded();
  if (!t.models) t.models = {};
  const r: Rates = { input: rates.input instanceof Dec ? rates.input : new Dec(rates.input) };
  if (rates.output !== undefined)
    r.output = rates.output instanceof Dec ? rates.output : new Dec(rates.output);
  if (rates.cached !== undefined)
    r.cached = rates.cached instanceof Dec ? rates.cached : new Dec(rates.cached);
  if (rates.cache_write !== undefined) {
    r.cache_write =
      rates.cache_write instanceof Dec ? rates.cache_write : new Dec(rates.cache_write);
  }
  registered[model] = r; // survives refresh(): re-applied after every table swap
  t.models[model] = r;
}

/** The unit a {@link RegisterModelPriceOptions} rate is quoted in. */
export type PriceUnit = '1M' | '1K' | 'token';

const PER: Record<string, number> = { '1M': 1_000_000, '1K': 1_000, token: 1 };

/** Options for {@link registerModelPrice}. Rates default to **USD per 1M tokens**. */
export interface RegisterModelPriceOptions {
  /** Input (prompt) price, in units of `per`. */
  input: number | string;
  /** Output (completion) price. Defaults to `0`. */
  output?: number | string;
  /** Optional cache-read price. Omitted means the input rate is used for cached tokens. */
  cached?: number | string;
  /** Optional cache-write price (Anthropic-style). */
  cacheWrite?: number | string;
  /** Unit the prices are expressed in — `'1M'` (default), `'1K'`, or `'token'`. */
  per?: PriceUnit;
}

/**
 * Register a model's rates quoted **per 1M tokens** — the unit every published price list uses.
 *
 * The unit-converting convenience over {@link register}: rates are divided by `per` and stored as
 * exact per-token `Decimal`, so `LLMCall.cost` is non-zero for the model and USD budgets enforce
 * against it. Registrations **survive `refresh()`**.
 *
 * Use this when you hold the actual rate card — a fine-tune, a negotiated rate, or a Microsoft
 * Foundry deployment serving a model the snapshot has no row for (DeepSeek, Mistral, Phi, …). When
 * the deployment serves a model that *is* in the table, {@link registerDeployment} is less typing
 * and less to get wrong.
 *
 * `@cendor/sdk`'s `registerModelPrice` is the same helper; since `@cendor/core` 3.4.0 it lives here
 * too, so a **libraries-door** app needs only `@cendor/core` — matching Python, where
 * `prices.register_model_price` has been in `cendor-core` since 1.15.0.
 *
 * @throws `Error` if `per` is not one of `'1M'` / `'1K'` / `'token'`.
 * @returns The stored **per-token** rates.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * prices.registerModelPrice('my-deployment', { input: 2.5, output: 10 }); // USD per 1M tokens
 * prices.estimate('my-deployment', 1000, { outputTokens: 500 });          // -> Money
 * ```
 */
export function registerModelPrice(model: string, opts: RegisterModelPriceOptions): Rates {
  const per = opts.per ?? '1M';
  const divisor = PER[per];
  if (divisor === undefined)
    throw new Error(`per must be one of 1K, 1M, token, got ${JSON.stringify(per)}`);
  const d = (v: number | string) => new Dec(String(v)).dividedBy(divisor);
  // Declared shape, not `Rates`: `register` requires an `input` rate, and an index-signature type
  // cannot promise one — the compiler is right to refuse it.
  const rates: { input: Decimal; output: Decimal; cached?: Decimal; cache_write?: Decimal } = {
    input: d(opts.input),
    output: d(opts.output ?? 0),
  };
  if (opts.cached != null) rates.cached = d(opts.cached);
  if (opts.cacheWrite != null) rates.cache_write = d(opts.cacheWrite);
  register(model, rates);
  return { ...rates };
}

/** Options for {@link registerDeployment}. */
export interface RegisterDeploymentOptions {
  /** A model id already in the price table whose rates the deployment should use. */
  like: string;
}

/**
 * Price a **deployment name** by copying the rates of the base model it serves.
 *
 * On Microsoft Foundry (formerly Azure AI Foundry) the id a call reports is the *deployment* name
 * you chose
 * (`prod-gpt4o-eastus`), not a model id — so it is absent from every price table, its cost is `null`,
 * and a USD budget silently never binds. You already know which model it serves; this says so once.
 *
 * This is an **explicit** mapping you supply — deliberately not the automatic `-preview` / `-latest`
 * alias guessing that was considered and rejected (a confidently wrong price is worse than an honest
 * `null`). Nothing is inferred from the deployment's name.
 *
 * **Copy-at-registration, not a live alias.** `like`'s rates are read *now* and stored as
 * `deployment`'s own registration, exactly as if you had called {@link register} with them. So a later
 * `refresh()` that reprices `like` does **not** reprice `deployment` (call this again to pick the new
 * rates up), and — like every registration — it survives `refresh()` and overrides a snapshot entry
 * with the same id.
 *
 * `like` goes through the same lookup reduction as a real call, so a dated or Bedrock-decorated base
 * id works.
 *
 * @throws {@link UnknownModelError} if `like` is not in the active table. Registering nothing and
 * letting the deployment stay unpriced would reproduce the exact silence this function removes.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * prices.registerDeployment('prod-gpt4o-eastus', { like: 'gpt-4o' });
 * prices.estimate('prod-gpt4o-eastus', 1000, { outputTokens: 500 }); // priced like gpt-4o
 * ```
 */
export function registerDeployment(deployment: string, opts: RegisterDeploymentOptions): Rates {
  const base = ratesFor(opts.like); // throws UnknownModelError — never register a silent nothing
  // Copy EVERY rate key, not an enumerated four: a base entry may carry a key this function has
  // never heard of (a future rate category, or a hand-written `register()` dict), and dropping it
  // would silently under-price the deployment. `Decimal` is immutable, so sharing instances is safe.
  const copy: Rates = { ...base };
  // A base that cannot price a call — no `input`, a table-stated zero `input`, or no `output` —
  // would make `estimate` throw later, which is the silent-unpriced outcome this function exists to
  // prevent. Fail at registration instead. Throws {@link MissingRateError}.
  assertPriceable(copy, opts.like);
  const t = ensureLoaded();
  if (!t.models) t.models = {};
  registered[deployment] = copy; // survives refresh(), exactly like register()
  t.models[deployment] = copy;
  return { ...copy };
}

/** Sorted list of model ids known to the current price table. */
export function models(): string[] {
  return Object.keys(ensureLoaded().models ?? {}).sort();
}

/** The `_updated` date of the loaded snapshot, or `null`. */
export function snapshotDate(): string | null {
  return ensureLoaded()._updated ?? null;
}

/** `"bundled"` | `"refreshed"` | `"loaded"` — where the active table came from. */
export function source(): string {
  return sourceKind;
}

/** Finer provenance of the active table: `'bundled'` | `'feed'` | `'azure'` | `'aws'` |
 * `'modelsdev'` | `'litellm'` | `'openrouter'` | `'vercel'` | `'custom'`. `'feed'` is a bare
 * `refresh()` — the cendor-prices table. Use {@link explain} for the per-row story. */
export function sourceName(): string {
  return sourceNameValue;
}

/** The URL the active table was fetched from, or `null` if it's the bundled snapshot. */
export function sourceUrl(): string | null {
  return sourceUrlValue;
}

/** Age of the active table in days (today − `_updated`), or `null` if undatable. */
export function ageDays(today?: Date): number | null {
  const d = snapshotDate();
  if (!d) return null;
  const parts = d.split('-').map((x) => Number.parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, dd] = parts as [number, number, number];
  const ref = today ?? new Date();
  const refUtc = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  const snapUtc = Date.UTC(y, m - 1, dd);
  return Math.floor((refUtc - snapUtc) / 86_400_000);
}

/** `true` if the table is older than `maxAgeDays` (an undatable table is never stale). */
export function isStale(maxAgeDays = 30): boolean {
  const a = ageDays();
  return a !== null && a > maxAgeDays;
}

// --------------------------------------------------------------------------- live-source adapters

function normalizeModelId(mid: string): string {
  let s = mid.trim();
  if (s.includes('/')) s = s.slice(s.indexOf('/') + 1);
  s = s.toLowerCase();
  return ALIASES[s] ?? s;
}

function dec(value: DecimalJsonValue): Decimal {
  return value instanceof Dec ? value : new Dec(value as DecimalValue);
}

type RawObject = { [key: string]: DecimalJsonValue };

/**
 * Is this source id namespaced to a **host** rather than naming the model itself?
 *
 * ⚠️ Measured 2026-08-01, and it published a wrong number before it was caught. litellm reaches
 * `claude-3-5-haiku` through `vertex_ai/claude-3-5-haiku` — **Vertex's $1/$5**, not Anthropic's
 * **$0.80/$4**. Stripping the namespace collapses a host's listing onto the bare id. A direct
 * naming outranks a host listing; the host case is what `registerModelPrice` /
 * `registerDeployment` exist for, and the lookup reduction still matches a Bedrock/Vertex *wire*
 * id onto the bare row at call time.
 */
export function isHostId(mid: string): boolean {
  const s = String(mid).trim().toLowerCase();
  return s.includes('/') || /^(?:[a-z][a-z0-9_-]*\.)+[a-z]/.test(s);
}

function mapLitellm(raw: DecimalJsonValue): Table {
  const out: Record<string, Rates> = {};
  const bare = new Set<string>();
  const obj = raw as RawObject;
  for (const [mid, rec] of Object.entries(obj)) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = rec as RawObject;
    if (!('input_cost_per_token' in r) || r.input_cost_per_token == null) continue;
    const rates: Rates = { input: dec(r.input_cost_per_token as DecimalJsonValue) };
    // A $0 input rate makes estimate() report $0.00 as a FACT and a USD cap silently never bind.
    if (!(rates.input as Decimal).greaterThan(0)) continue;
    if (r.output_cost_per_token != null) rates.output = dec(r.output_cost_per_token);
    if (r.cache_read_input_token_cost != null) rates.cached = dec(r.cache_read_input_token_cost);
    if (r.cache_creation_input_token_cost != null) {
      rates.cache_write = dec(r.cache_creation_input_token_cost);
    }
    const key = normalizeModelId(mid);
    if (bare.has(key)) continue; // a host listing must never overwrite a direct naming
    if (!isHostId(mid)) bare.add(key);
    out[key] = rates;
  }
  return { models: out };
}

/**
 * models.dev `api.json`: `{provider: {models: {id: {cost: {...}}}}}`, rates per **1M**.
 *
 * ⚠️ The payload is **provider → models**, and the same model id appears under many providers at
 * different prices: measured 2026-08-01, `gpt-5.1` appears 11 times between $1.07 and $1.25 per
 * MTok, and the providers with the most rows are all resellers (nano-gpt 617, kilo 346,
 * openrouter 335, vercel 312). "Last one wins" would hand you a random reseller's resale price as
 * the model's rate, so {@link MODELSDEV_PROVIDERS} is an allowlist with a fixed precedence, not a
 * tidy-up filter.
 */
export const MODELSDEV_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'google-vertex',
  'xai',
  'deepseek',
  'mistral',
  'meta',
  'alibaba',
  'moonshotai',
  'cohere',
  'amazon-bedrock',
  'azure',
  'groq',
  'fireworks-ai',
  'huggingface',
] as const;

const MD_KEYS: Array<[string, string]> = [
  ['input', 'input'],
  ['output', 'output'],
  ['cache_read', 'cached'],
  ['cache_write', 'cache_write'],
];

function mapModelsdev(raw: DecimalJsonValue): Table {
  const out: Record<string, Rates> = {};
  const bare = new Set<string>();
  const million = new Dec(1_000_000);
  const obj = raw as RawObject;
  let latest: string | null = null;
  // Walk in REVERSE precedence so the top of the allowlist is written last and wins.
  for (const pid of [...MODELSDEV_PROVIDERS].reverse()) {
    const prov = obj[pid];
    if (prov === null || typeof prov !== 'object' || Array.isArray(prov)) continue;
    const models = (prov as RawObject).models;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [mid, rec] of Object.entries(models as RawObject)) {
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
      const cost = (rec as RawObject).cost;
      if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) continue;
      const c = cost as RawObject;
      if (c.input == null) continue;
      const rates: Rates = {};
      for (const [src, dst] of MD_KEYS) {
        const v = c[src];
        if (v != null) rates[dst] = dec(v).dividedBy(million);
      }
      const input = rates.input;
      if (input === undefined || !input.greaterThan(0)) continue;
      const key = normalizeModelId(mid);
      // A host listing must never overwrite a direct naming (see `isHostId`).
      // ⚠️ The `&& isHostId(mid)` is LOAD-BEARING. Without it this guard INVERTED the precedence
      // list above: when two allowlisted providers both key a model BARE, the reverse walk writes
      // the lower-precedence one first, it claims `bare`, and the higher-precedence one is skipped.
      // Measured 2026-08-02 on the live payload — `refresh({source:'modelsdev'})` returned azure's
      // **$1/$6 deployment** price for `gpt-5.6-luna` instead of OpenAI's own **$0.2/$1.2**. Four
      // rows were affected, every one a host's listing displacing the lab's:
      //   gpt-5.6-luna $1/$6 -> $0.2/$1.2 · gpt-5.6-terra $2.5/$15 -> $2/$12
      //   deepseek-v4-pro $1.74/$3.48 -> $0.435/$0.87 · deepseek-v4-flash $0.19/$0.51 -> $0.14/$0.28
      // The two rules collide only when both ids are bare; precedence decides that case.
      // (`mapLitellm` keeps the plain guard on purpose — its payload is a flat dict with no
      // precedence order to appeal to, so "the first bare id wins" is the only rule there.)
      if (bare.has(key) && isHostId(mid)) continue;
      if (!isHostId(mid)) bare.add(key);
      out[key] = rates;
      const lu = String((rec as RawObject).last_updated ?? '').slice(0, 10);
      if (lu.length === 10 && (latest === null || lu > latest)) latest = lu;
    }
  }
  const result: Table = { models: out };
  if (latest !== null) result._updated = latest;
  return result;
}

const VERCEL_KEYS: Array<[string, string]> = [
  ['input', 'input'],
  ['output', 'output'],
  ['input_cache_read', 'cached'],
  ['input_cache_write', 'cache_write'],
];

/**
 * Vercel AI Gateway `/v1/models`. Per-token rates as JSON **strings**, filtered to
 * `type === "language"`. Base rates only — the catalog also carries `input_tiers` /
 * `service_tiers`, which are out of scope. Gateway **resale** prices, like OpenRouter's. No
 * catalog-wide date ⇒ undatable, never stamped "today".
 */
function mapVercel(raw: DecimalJsonValue): Table {
  const out: Record<string, Rates> = {};
  const data = (raw as RawObject).data;
  if (!Array.isArray(data)) return { models: out };
  for (const rec of data) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = rec as RawObject;
    if (r.type !== 'language') continue;
    const pricing = (r.pricing ?? {}) as RawObject;
    if (pricing.input == null) continue;
    const rates: Rates = {};
    for (const [src, dst] of VERCEL_KEYS) {
      const v = pricing[src];
      if (v != null && dec(v).greaterThan(0)) rates[dst] = dec(v);
    }
    if (rates.input === undefined) continue;
    out[normalizeModelId(String(r.id ?? ''))] = rates;
  }
  return { models: out };
}

function mapOpenrouter(raw: DecimalJsonValue): Table {
  const out: Record<string, Rates> = {};
  const data = (raw as RawObject).data;
  if (!Array.isArray(data)) return { models: out };
  for (const rec of data) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = rec as RawObject;
    const mid = r.id;
    const pricing = (r.pricing ?? {}) as RawObject;
    if (typeof mid !== 'string' || pricing.prompt == null) continue;
    const rates: Rates = { input: dec(pricing.prompt) };
    if (pricing.completion != null) rates.output = dec(pricing.completion);
    const cached = pricing.input_cache_read;
    if (cached != null && dec(cached).greaterThan(0)) rates.cached = dec(cached);
    out[normalizeModelId(mid)] = rates;
  }
  return { models: out };
}

// --------------------------------------------------------------------------------- azure (Foundry)

/**
 * Azure writes one direction seven ways. ⚠️ **`opt` means OUTPUT** — 141 rows on 2026-08-01, and
 * the pre-fix parser looked only for `outp`/`output`, so every GPT-5.x family had an input rate and
 * no output rate. Proven by price: `GPT 5.1 inp Gl` 1.25/1M vs `GPT 5.1 opt Gl` 10.0/1M =
 * GPT-5.1's published $1.25/$10.
 */
const AZ_DIRECTION: Record<string, 'input' | 'output'> = {
  inp: 'input',
  inpt: 'input',
  input: 'input',
  in: 'input',
  outp: 'output',
  outpt: 'output',
  output: 'output',
  out: 'output',
  opt: 'output',
};
const AZ_CACHE_READ = new Set(['cd', 'cchd', 'ccchd', 'cached', 'cache']);
const AZ_CACHE_WRITE = new Set(['wr']);
/** Meters that are not a plain on-demand per-token inference rate: a different product, a different
 * SLA, or not per-token at all. (`l` alone is the long-context tier — `4.3 Inp Glbl L` is 2x
 * `4.3 Inp Glbl`.) */
const AZ_NOT_INFERENCE = new Set([
  'batch',
  'ft',
  'finetuned',
  'training',
  'trng',
  'hosting',
  'pp',
  'ptu',
  'provisioned',
  'grader',
  'grdr',
  'img',
  'image',
  'aud',
  'audio',
  'rt',
  'realtime',
  'tts',
  'trscb',
  'tcrb',
  'transcribe',
  'ocr',
  'doc',
  'video',
  'speech',
  'shortco',
  'longco',
  'reservation',
  'embedding',
  'l',
]);
const AZ_TIER = new Set([
  'gl',
  'glbl',
  'global',
  'dz',
  'dzone',
  'datazone',
  'dzn',
  'regnl',
  'regional',
  'rgnl',
  'regn',
  'std',
  'zone',
  'data',
  'mn',
]);
const AZ_PRODUCT_SKIP = new Set([
  'Azure OpenAI Media',
  'Azure BFL Flux Models',
  'Managed Compute',
  'Azure AI Foundry Provisioned Throughput Reservation',
  'Azure OpenAI PP FT GPT4s',
  'Azure OpenAI Embedding',
]);
/** `productName` → family root. A sku alone is ambiguous: `4.3 Inp Glbl` under *Azure Grok Models*
 * is `grok-4.3` and `V4 Pro Inp glbl` under *Azure Deepseek Models* is `deepseek-v4-pro`.
 * ⚠️ Applied only when the parsed head does not already start with the root — prefixing
 * unconditionally turned `o1`/`o3`/`o4-mini` into `gpt-o1`/`gpt-o3`/`gpt-o4-mini`, a regression
 * against the pre-fix mapper. *Azure OpenAI* and *Azure OpenAI Reasoning* carry full ids already. */
const AZ_FAMILY_ROOT: Record<string, string> = {
  'Azure OpenAI GPT5': 'gpt',
  'Azure Grok Models': 'grok',
  'Azure Deepseek Models': 'deepseek',
  'Azure Kimi': 'kimi',
  'Azure Llama Models': 'llama',
  'Azure Mistral Models': 'mistral',
  'Qwen models': 'qwen',
  'Azure Phi Models': 'phi',
  'MAI Models': 'mai',
  'Azure OpenAI OSS Models': 'gpt-oss',
};

/** ⚠️ Read the unit **per row**: eastus2 mixes 905 `1K` meters with 479 `1M` ones in one response. */
function azureUnitDivisor(unitOfMeasure: string): Decimal {
  const u = (unitOfMeasure || '').toUpperCase().replace(/ /g, '');
  if (u.includes('1M') || u.includes('1000000')) return new Dec(1_000_000);
  return new Dec(1000);
}

function mapAzure(raw: DecimalJsonValue): Table {
  const byModel: Record<string, Rates> = {};
  let latest: string | null = null;
  const items = (raw as RawObject).Items;
  if (!Array.isArray(items)) return { models: {} };
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const it = item as RawObject;
    if (AZ_PRODUCT_SKIP.has(String(it.productName))) continue;
    // Real Retail rows always carry a `type`; treat a missing one as Consumption so a hand-written
    // fixture stays valid. Only `Reservation` rows are excluded — a committed capacity price is not
    // a per-call rate.
    if (String(it.type ?? 'Consumption') !== 'Consumption') continue;
    const unit = String(it.unitOfMeasure ?? '')
      .trim()
      .toUpperCase();
    if (unit !== '1K' && unit !== '1M') continue;
    const price = it.retailPrice;
    if (price == null || !dec(price).greaterThan(0)) continue;
    const words = String(it.skuName ?? '')
      .toLowerCase()
      .split(/[\s\-_]+/)
      .filter(Boolean);
    if (words.some((w) => AZ_NOT_INFERENCE.has(w))) continue;

    let direction: 'input' | 'output' | null = null;
    let cached = false;
    let write = false;
    const head: string[] = [];
    for (const w of words) {
      const d = AZ_DIRECTION[w];
      if (d !== undefined) {
        direction = d;
        continue;
      }
      if (AZ_CACHE_READ.has(w)) {
        cached = true;
        continue;
      }
      if (AZ_CACHE_WRITE.has(w)) {
        write = true;
        continue;
      }
      if (AZ_TIER.has(w)) continue;
      if (direction === null) head.push(w);
    }
    if (direction === null) continue;
    let key: string;
    if (cached && direction === 'input') key = write ? 'cache_write' : 'cached';
    else if (write)
      continue; // a cache-write row we cannot place — skip rather than guess
    else key = direction;

    while (
      head.length &&
      /^\d+$/.test(head[head.length - 1] as string) &&
      [3, 4, 8].includes((head[head.length - 1] as string).length)
    ) {
      head.pop();
    }
    if (!head.length) continue;
    let mid = head.join('-');
    const root = AZ_FAMILY_ROOT[String(it.productName)];
    if (root !== undefined && !mid.startsWith(root)) mid = `${root}-${mid}`;
    mid = normalizeModelId(mid);

    const perToken = dec(price).dividedBy(azureUnitDivisor(String(it.unitOfMeasure ?? '')));
    let rates = byModel[mid];
    if (rates === undefined) {
      rates = {};
      byModel[mid] = rates;
    }
    const existing = rates[key];
    if (existing === undefined || perToken.lessThan(existing)) rates[key] = perToken;

    const eff = String(it.effectiveStartDate ?? '').slice(0, 10);
    if (eff.length === 10 && (latest === null || eff > latest)) latest = eff;
  }
  const out: Record<string, Rates> = {};
  for (const [mid, r] of Object.entries(byModel)) if ('input' in r) out[mid] = r;
  const result: Table = { models: out };
  // Carry Azure's real effectiveStartDate when present, else undatable — never fake "today", which
  // would make a stale refresh look fresh to isStale().
  if (latest !== null) result._updated = latest;
  return result;
}

// ------------------------------------------------------------------------------------ aws (Bedrock)

/**
 * ⚠️ usagetype fragments marking a different SLA or commitment — never the on-demand base rate.
 * Measured 2026-08-01: `Claude Sonnet 4` carries `inferenceType: "Input tokens"` on **both**
 * `…-input-tokens-cross-region-global` ($3/MTok) and `…-input-tokens-cross-region-global-batch`
 * ($1.50/MTok), so a plain cheapest-wins over `inferenceType` publishes the batch price as the
 * standard one.
 */
const AWS_NOT_ON_DEMAND = ['batch', 'long-context', 'reserved', 'priority', 'flex', 'provisioned'];
const AWS_UNITS: Record<string, number> = {
  '1k tokens': 1000,
  '1k token': 1000,
  '1m tokens': 1_000_000,
  '1m token': 1_000_000,
};

/** Which rate a Bedrock price dimension is, from the `usagetype` first. ⚠️ `inferenceType` is not
 * sufficient: the cache-write row carries `inferenceType: null`. */
function awsRateKey(usagetype: unknown, inferenceType: unknown): string | null {
  const u = String(usagetype ?? '').toLowerCase();
  if (u.includes('cache-read')) return 'cached';
  if (u.includes('cache-write')) return 'cache_write';
  if (u.includes('input-token')) return 'input';
  if (u.includes('output-token')) return 'output';
  const it = String(inferenceType ?? '')
    .trim()
    .toLowerCase();
  if (it === 'prompt cache read input tokens') return 'cached';
  if (it === 'prompt cache write input tokens') return 'cache_write';
  if (it === 'input tokens' || it === 'text input tokens' || it === 'text input token')
    return 'input';
  if (it === 'output tokens' || it === 'text output tokens' || it === 'text output token') {
    return 'output';
  }
  return null;
}

/**
 * Normalise an AWS `attributes.model` to the shape the lookup reduction produces.
 *
 * AWS names a model two ways in the same file: a **display name** with spaces (`Claude Sonnet 4.5`,
 * `Llama 3.3 70B`) and a **wire-ish id** with none (`gpt-oss-120b`, `xai.grok-4.3`). A display name
 * becomes what {@link lookupId} yields from a Bedrock wire id
 * (`us.anthropic.claude-sonnet-4-5-…-v1:0` → `claude-sonnet-4-5`).
 *
 * Honest limit: a wire id carrying a suffix the display name lacks (`llama3-3-70b-instruct`) will
 * not match — and is never guessed at.
 */
export function awsModelKey(name: string): string {
  const s = String(name).trim();
  if (!s.includes(' ')) return s.toLowerCase().replace(/^(?:[a-z0-9]+\.)+/, '');
  return s
    .toLowerCase()
    .replace(/(?<=\d)\.(?=\d)/g, '-')
    .replace(/[\s_]+/g, '-');
}

/** AWS Bedrock price files as fetched by {@link fetchAws} → `{ offers: [file, ...] }`. */
function mapAws(raw: DecimalJsonValue): Table {
  const byModel: Record<string, Rates> = {};
  let published: string | null = null;
  const offers = (raw as RawObject).offers;
  if (!Array.isArray(offers)) return { models: {} };
  for (const file of offers) {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) continue;
    const data = file as RawObject;
    const p = String(data.publicationDate ?? '').slice(0, 10);
    if (p.length === 10 && (published === null || p > published)) published = p;
    const terms = ((data.terms as RawObject | undefined)?.OnDemand ?? {}) as RawObject;
    const products = (data.products ?? {}) as RawObject;
    for (const [sku, product] of Object.entries(products)) {
      if (product === null || typeof product !== 'object' || Array.isArray(product)) continue;
      const attrs = ((product as RawObject).attributes ?? {}) as RawObject;
      if (!attrs.model) continue;
      const usagetype = String(attrs.usagetype ?? '').toLowerCase();
      if (AWS_NOT_ON_DEMAND.some((frag) => usagetype.includes(frag))) continue;
      const key = awsRateKey(attrs.usagetype, attrs.inferenceType);
      if (key === null) continue;
      const skuTerms = (terms[sku] ?? {}) as RawObject;
      for (const term of Object.values(skuTerms)) {
        if (term === null || typeof term !== 'object' || Array.isArray(term)) continue;
        const dims = ((term as RawObject).priceDimensions ?? {}) as RawObject;
        for (const pd of Object.values(dims)) {
          if (pd === null || typeof pd !== 'object' || Array.isArray(pd)) continue;
          const dim = pd as RawObject;
          const divisor =
            AWS_UNITS[
              String(dim.unit ?? '')
                .trim()
                .toLowerCase()
            ];
          if (divisor === undefined) continue; // image / hour / TPM-Hour — not a token rate
          const usd = ((dim.pricePerUnit ?? {}) as RawObject).USD;
          if (usd == null) continue;
          const value = dec(usd).dividedBy(divisor);
          if (!value.greaterThan(0)) continue;
          const mid = awsModelKey(String(attrs.model));
          let rates = byModel[mid];
          if (rates === undefined) {
            rates = {};
            byModel[mid] = rates;
          }
          const existing = rates[key];
          if (existing === undefined || value.lessThan(existing)) rates[key] = value;
        }
      }
    }
  }
  const out: Record<string, Rates> = {};
  for (const [mid, r] of Object.entries(byModel)) if ('input' in r) out[mid] = r;
  const result: Table = { models: out };
  if (published !== null) result._updated = published;
  return result;
}

// ----------------------------------------------------------------------------------- source registry

type Mapper = (raw: DecimalJsonValue) => Table;
type Fetcher = (url: string, timeout: number, region?: string) => Promise<DecimalJsonValue>;

/**
 * One unauthenticated HTTPS GET → parsed JSON with `Decimal` numbers.
 *
 * ⚠️ Never gates on the HTTP status or the content-type, because neither is a signal here. Measured
 * 2026-08-01: Azure answers a wrong `$filter` with **200 + `{"Items": []}`**, models.dev answers a
 * wrong path with **200 + `text/html`**, Vercel answers a wrong path with **404 + valid JSON**, AWS
 * serves its *good* index files as `application/octet-stream`, and raw.githubusercontent serves the
 * feed as `text/plain`. Parse, then check shape.
 */
async function getJson(url: string, timeout: number): Promise<DecimalJsonValue> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': '@cendor/core prices' },
    });
    return parseDecimalJson(await resp.text());
  } finally {
    clearTimeout(timer);
  }
}

const fetchSimple: Fetcher = (url, timeout) => getJson(url, timeout);

/** Paginate the Retail Prices API. Two pages for one region; capped so a filter that somehow
 * matches everything cannot turn one `refresh()` into an unbounded crawl. */
const fetchAzure: Fetcher = async (url, timeout) => {
  const items: DecimalJsonValue[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next && pages < 10) {
    const payload = (await getJson(next, timeout)) as RawObject;
    if (Array.isArray(payload.Items)) items.push(...payload.Items);
    pages += 1;
    next = typeof payload.NextPageLink === 'string' ? payload.NextPageLink : undefined;
  }
  return { Items: items };
};

/** Resolve each offer's region index, then fetch that region's file. Both offers, always. */
const fetchAws: Fetcher = async (_url, timeout, region) => {
  const reg = region || AWS_DEFAULT_REGION;
  const offers: DecimalJsonValue[] = [];
  for (const offer of AWS_OFFERS) {
    const index = (await getJson(
      `${AWS_PRICING_HOST}/offers/v1.0/aws/${offer}/current/region_index.json`,
      timeout,
    )) as RawObject;
    const regions = (index.regions ?? {}) as RawObject;
    const entry = regions[reg] as RawObject | undefined;
    const href = String(entry?.currentVersionUrl ?? '');
    // A region one offer does not publish is not a failure of the other.
    if (!href) continue;
    offers.push(await getJson(href.startsWith('http') ? href : AWS_PRICING_HOST + href, timeout));
  }
  return { offers };
};

interface Source {
  url: string | ((region?: string) => string);
  mapper: Mapper;
  fetch: Fetcher;
}

/**
 * Built-in live sources, all unauthenticated HTTPS GET → JSON. `azure` and `aws` are the providers'
 * own billing catalogs (first-party facts); `modelsdev` and `litellm` are MIT aggregators;
 * `openrouter` and `vercel` are gateways quoting their own **resale** prices.
 */
const SOURCES: Record<string, Source> = {
  litellm: { url: LITELLM_URL, mapper: mapLitellm, fetch: fetchSimple },
  openrouter: { url: OPENROUTER_URL, mapper: mapOpenrouter, fetch: fetchSimple },
  modelsdev: { url: MODELSDEV_URL, mapper: mapModelsdev, fetch: fetchSimple },
  vercel: { url: VERCEL_URL, mapper: mapVercel, fetch: fetchSimple },
  azure: {
    url: (region) => azureUrl(region ?? AZURE_DEFAULT_REGION),
    mapper: mapAzure,
    fetch: fetchAzure,
  },
  aws: { url: AWS_URL, mapper: mapAws, fetch: fetchAws },
};

/**
 * Names of the built-in live price sources accepted by `refresh(undefined, { source })`:
 * `['aws', 'azure', 'litellm', 'modelsdev', 'openrouter', 'vercel']`. `azure` and `aws` also accept
 * a `region`.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * await prices.refresh(undefined, { source: 'aws', region: 'eu-west-1' });
 * ```
 */
export function sources(): string[] {
  return Object.keys(SOURCES).sort();
}

export interface RefreshOptions {
  source?: string;
  mapper?: Mapper;
  timeout?: number;
  /** Cloud region for the `azure` / `aws` sources. Ignored by the others. */
  region?: string;
  /** `true` throws {@link PriceRefreshError} instead of resolving `false`. Never the default. */
  required?: boolean;
}

/**
 * Replace the table from a live source or static JSON URL. Never throws; offline-safe.
 *
 * With no arguments this fetches the **cendor-prices feed** ({@link SNAPSHOT_URL}) — a dated,
 * per-row-provenanced table reconciled from the cloud catalogs and the MIT aggregators. Resolves
 * `true` if the table was updated, `false` if the fetch/parse/map failed (the current table stays
 * active — a failure never reverts anything). Mirrors `cendor.core.prices.refresh`; **async here**,
 * synchronous in Python (a documented divergence: `fetch` vs `urllib`).
 *
 * @throws {@link PriceRefreshError} only when `required: true`.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * await prices.refresh();                                              // the cendor-prices feed
 * await prices.refresh(undefined, { source: 'aws', region: 'eu-west-1' });
 * await prices.refresh(undefined, { required: true });                 // loud instead of silent
 * ```
 */
export async function refresh(url?: string, opts: RefreshOptions = {}): Promise<boolean> {
  const { source: sourceArg, mapper, timeout = 5.0, region, required = false } = opts;
  let target: string;
  let adapter: Mapper | undefined;
  let fetcher: Fetcher = fetchSimple;
  let name: string;
  if (sourceArg != null) {
    const entry = SOURCES[sourceArg];
    if (entry === undefined) {
      if (required) {
        throw new PriceRefreshError(
          `unknown price source ${JSON.stringify(sourceArg)}; expected one of ${sources().join(', ')}`,
        );
      }
      return false;
    }
    target = typeof entry.url === 'function' ? entry.url(region) : entry.url;
    adapter = mapper ?? entry.mapper;
    fetcher = entry.fetch;
    name = sourceArg;
  } else {
    target = url || SNAPSHOT_URL;
    adapter = mapper;
    name = url ? 'custom' : 'feed';
  }
  if (!target || !/^https?:\/\//i.test(target)) {
    if (required) {
      throw new PriceRefreshError(
        `price source must be an http(s) URL, got ${JSON.stringify(target)}`,
      );
    }
    return false;
  }
  const detail = 'the source returned no models (a wrong filter or a changed shape answers 200)';
  try {
    const raw = await fetcher(target, timeout, region);
    const data = adapter ? adapter(raw) : (raw as unknown as Table);
    if (adapter && data && typeof data === 'object' && data.models) {
      // A MAPPED source only. These adapters are the deliberate twins of the cendor-prices
      // builder's, and the feed already applies this rule (`zero.mjs`) before publishing — so a row
      // our own mapper cannot price should be absent here for the same reason it is absent there. A
      // pass-through `refresh(url)` is a TABLE, not a mapper: we keep every row a user's own table
      // states and let `estimate()` refuse the unpriceable ones by name.
      dropUnpriceable(data.models);
    }
    if (data && typeof data === 'object' && data.models && Object.keys(data.models).length > 0) {
      install(data, 'refreshed', name, target);
      return true;
    }
  } catch (e) {
    if (required) {
      throw new PriceRefreshError(
        `price refresh from ${JSON.stringify(target)} failed: ${(e as Error).message}`,
      );
    }
    return false;
  }
  if (required)
    throw new PriceRefreshError(`price refresh from ${JSON.stringify(target)} failed: ${detail}`);
  return false;
}

/**
 * Drop rows a mapped source produced that cannot price a call. In place; returns the ids.
 *
 * The library mirror of `cendor-prices`' `dropZeroInput` + `dropMissingOutput`. Measured 2026-08-02
 * against the live payloads: `refresh({ source: 'litellm' })` produced **10** rows with no output
 * rate — including `gpt-image-1`, which OpenAI bills at $40 per 1M output tokens, so
 * `estimate('gpt-image-1', 1e6, { outputTokens: 1e6 })` answered **$5.00** where the truth is
 * **$45.00** — and `refresh({ source: 'azure' })` produced one (`fw-deepseek-v4-pro-ch`).
 *
 * A model no source can price is honestly **absent**, which is the plain `UnknownModelError` a
 * caller already handles, rather than a half-priced row that survives to under-report money. An
 * output rate a source explicitly states as `0` is kept: embeddings really do have one.
 */
function dropUnpriceable(models: Record<string, Rates>): string[] {
  const dropped: string[] = [];
  for (const [mid, r] of Object.entries(models)) {
    const input = r?.input;
    if (!r || input === undefined || new Dec(input).lte(0) || r.output === undefined) {
      dropped.push(mid);
    }
  }
  for (const mid of dropped) delete models[mid];
  return dropped;
}

function install(data: Table, kind: string, name: string, url: string | null): void {
  if (!data.models) data.models = {};
  coerceRates(data.models);
  Object.assign(data.models, registered); // programmatic registrations survive every table swap
  table = data;
  sourceKind = kind;
  sourceNameValue = name;
  sourceUrlValue = url;
}

/**
 * Force every rate in a swapped-in table to a `Decimal`, in place.
 *
 * ⚠️ Measured 2026-08-01. A **pass-through** `refresh(url)` — no mapper, the caller pointing at any
 * `prices/1` JSON — hands the parsed rate objects straight to `estimate()`. `parseDecimalJson`
 * turns a JSON *number* into a `Decimal` but leaves a JSON *string* a string, so a table that
 * quotes its rates (`"input": "0.0000025"`, a perfectly reasonable authoring choice) made
 * `estimate()` throw `inputRate.times is not a function` and `explain().summary()` throw
 * `toFixed is not a function`. Python never showed it because its `estimate` already coerced with
 * `Decimal(str(...))`. This is the TS side of that same defensiveness, applied once at the swap
 * rather than on every read.
 */
function coerceRates(models: Record<string, Rates>): void {
  for (const rates of Object.values(models)) {
    if (rates === null || typeof rates !== 'object') continue;
    for (const [k, v] of Object.entries(rates)) {
      if (!(v instanceof Dec)) rates[k] = dec(v as unknown as DecimalJsonValue);
    }
  }
}

// ----------------------------------------------------------------------------- explain / save / load

/**
 * Where one model's rates came from — the answer to *"why is my cost that number?"*.
 *
 * Field names are camelCase here and snake_case in `cendor.core.prices.PriceExplanation` (the same
 * documented divergence as `snapshotDate` / `snapshot_date`).
 */
export interface PriceExplanation {
  /** The id you asked about, verbatim. */
  model: string;
  /** The table key that answered, or `null` if nothing did. */
  resolved: string | null;
  /**
   * `'registered'` — your own `register*` call is in effect (it overrides every table).
   * `'exact'` — the id is a table key. `'normalized'` — a wire-level id was reduced to its base.
   * `'unpriced'` — no rate exists, and `estimate()` would throw.
   */
  how: 'exact' | 'normalized' | 'registered' | 'unpriced';
  /** Per-token USD rates, or `null` when unpriced. */
  rates: Rates | null;
  registered: boolean;
  /** Provenance of the whole table: `'bundled'` | `'feed'` | `'azure'` | … */
  sourceName: string;
  sourceUrl: string | null;
  /** `'bundled'` | `'refreshed'` | `'loaded'`. */
  tableOrigin: string;
  snapshotDate: string | null;
  ageDays: number | null;
  /** Per-row provenance from the feed's `_provenance` map: which source this rate came from. */
  rowSource: string | null;
  /** That source's own as-of date for this rate — not the day it was fetched. */
  rowAsof: string | null;
  /** Honest caveats that apply to this answer (resale pricing, staleness, …). */
  notes: string[];
  /** One human-readable line, for a log or a CLI. */
  summary(): string;
}

/** Sources whose numbers are what a **gateway** charges for reselling a model, not what the lab
 * charges. Surfaced by {@link explain} rather than buried in the docs. */
const RESALE_SOURCES = new Set(['openrouter', 'vercel']);

/**
 * Explain where `model`'s rates come from: the resolved id, the rates, and the provenance.
 *
 * The visibility half of *"if the live price is wrong, the user can overwrite it"*: an override
 * already wins ({@link register}), and this shows whether one is in effect, which table answered,
 * which source that row came from, and how old it is. Never throws — an unpriced model is an
 * answer, not an error.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * await prices.refresh();
 * console.log(prices.explain('gpt-4o').summary());
 * ```
 */
export function explain(model: string): PriceExplanation {
  const t = ensureLoaded();
  const models = t.models ?? {};
  const mid = String(model);
  let resolved: string | null = null;
  let how: PriceExplanation['how'] = 'unpriced';
  if (models[mid] !== undefined) {
    resolved = mid;
    how = 'exact';
  } else {
    const reduced = lookupId(mid);
    if (models[reduced] !== undefined) {
      resolved = reduced;
      how = 'normalized';
    }
  }
  const isRegistered = resolved !== null && registered[resolved] !== undefined;
  if (isRegistered) how = 'registered';
  const rates = resolved !== null ? { ...(models[resolved] as Rates) } : null;
  const row = resolved !== null ? t._provenance?.[resolved] : undefined;
  const notes: string[] = [];
  if (isRegistered) {
    notes.push(
      'a register()/registerModelPrice()/registerDeployment() call overrides every table for this id, including after a refresh()',
    );
  }
  if (RESALE_SOURCES.has(sourceNameValue)) {
    notes.push(
      `${sourceNameValue} publishes gateway RESALE prices — what the gateway charges you, which may differ from the model lab's own rate`,
    );
  }
  const age = ageDays();
  if (age !== null && age > 45) {
    notes.push(`this table is ${age} days old; call refresh() for current rates`);
  }
  if (snapshotDate() === null) {
    notes.push(
      'this source publishes no as-of date, so staleness cannot be measured (isStale() reports false, which means unknown, not fresh)',
    );
  }
  if (how === 'unpriced') {
    notes.push(
      'estimate() throws UnknownModelError and tokenguard records $0 — register a rate with prices.registerModelPrice(...) or prices.registerDeployment(...)',
    );
  }
  const name = sourceNameValue;
  const snap = snapshotDate();
  return {
    model: mid,
    resolved,
    how,
    rates,
    registered: isRegistered,
    sourceName: name,
    sourceUrl: sourceUrlValue,
    tableOrigin: sourceKind,
    snapshotDate: snap,
    ageDays: age,
    rowSource: row?.src ?? null,
    rowAsof: row?.asof ?? null,
    notes,
    summary(): string {
      if (this.rates === null) {
        return `${this.model}: no price in the ${name} table — cost will be null`;
      }
      const r = Object.keys(this.rates)
        .sort()
        .map((k) => `${k}=${(this.rates as Rates)[k]?.toFixed()}`)
        .join(' ');
      const via = this.resolved === this.model ? '' : ` (via ${this.resolved})`;
      const prov = this.rowSource ?? name;
      const asof = this.rowAsof ?? snap ?? 'undated';
      return `${this.model}${via}: ${r} — ${this.how}, from ${prov} as of ${asof}`;
    },
  };
}

/**
 * Write the **active** table to `path` so a later process can {@link load} it. Opt-in.
 *
 * `refresh()` is in-memory only, per process: a short-lived or serverless worker starts at the
 * bundled snapshot every time. This is the explicit escape hatch — a path *you* choose, written
 * when *you* ask. There is deliberately **no implicit cache**: a library quietly writing price
 * files is a side effect, and a hidden cache is exactly how prices go *invisibly* stale.
 *
 * Provenance rides along, so `explain()` and `ageDays()` stay honest after a `load()` — the saved
 * file records the original source and its `_updated`, never the moment you saved.
 *
 * Node/Bun/Deno only (it needs a filesystem); `node:fs/promises` is imported dynamically so a
 * browser or Worker bundle never pulls it in.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * await prices.refresh();
 * await prices.save('.cache/cendor-prices.json');   // in your deploy step
 * // ... a later process:
 * await prices.load('.cache/cendor-prices.json');   // no network
 * ```
 */
export async function save(path: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const t = ensureLoaded();
  const models: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(t.models ?? {})) {
    const r: Record<string, string> = {};
    // `toFixed()`, not `toString()`: toString renders 1.23e-7 in exponent form. Both round-trip
    // exactly, but a plain decimal literal is what the price-dataset spec and the cendor-prices
    // feed use, so a saved file is diffable against them.
    for (const [kk, vv] of Object.entries(v)) r[kk] = vv.toFixed();
    models[k] = r;
  }
  const payload: Record<string, unknown> = {
    _note: 'Saved by @cendor/core prices.save(). Restore with prices.load(path).',
    _schema: 'prices/1',
    _saved: { source_name: sourceNameValue, source_url: sourceUrlValue, origin: sourceKind },
    models,
  };
  if (t._updated) payload._updated = t._updated;
  if (t._provenance) payload._provenance = t._provenance;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  return path;
}

/**
 * Load a table previously written by {@link save}. Opt-in, explicit, no network.
 *
 * Registrations are re-applied on top exactly as after a `refresh()`, and the file's recorded
 * source name / URL / `_updated` are restored so {@link explain} and {@link ageDays} describe where
 * the rates *came from*, not where they were read from. `source()` then reports `'loaded'`.
 * Resolves `false` if the file was missing, unreadable or empty — the same never-throw,
 * keep-the-last-good contract as `refresh()`.
 *
 * @example
 * ```ts
 * import { prices } from '@cendor/core';
 * if (!(await prices.load('.cache/cendor-prices.json'))) await prices.refresh();
 * ```
 */
export async function load(path: string): Promise<boolean> {
  let text: string;
  try {
    const { readFile } = await import('node:fs/promises');
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  let data: Table;
  try {
    data = parseDecimalJson(text) as unknown as Table;
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object' || !data.models || !Object.keys(data.models).length) {
    return false;
  }
  // `save()` writes rates as strings (a plain decimal literal, diffable against the feed);
  // `install()`'s coerceRates turns them back into Decimals — a Decimal table is the contract, and
  // `explain()` hands rates straight to callers.
  install(
    data,
    'loaded',
    String(data._saved?.source_name ?? 'custom'),
    data._saved?.source_url ?? null,
  );
  return true;
}

/** Test helper: drop the loaded table (and registrations) so the bundled snapshot reloads. */
export function _reset(): void {
  table = null;
  sourceKind = 'bundled';
  sourceNameValue = 'bundled';
  sourceUrlValue = null;
  for (const k of Object.keys(registered)) delete registered[k];
}
