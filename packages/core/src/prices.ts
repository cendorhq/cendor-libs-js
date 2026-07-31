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

type Rates = Record<string, Decimal>;
interface Table {
  _updated?: string;
  models: Record<string, Rates>;
}

let table: Table | null = null;
let sourceKind = 'bundled'; // "bundled" | "refreshed"
let sourceNameValue = 'bundled'; // "bundled" | "litellm" | "openrouter" | "azure" | "custom" | "default"
let sourceUrlValue: string | null = null;
/** Programmatic registrations (see {@link register}) — re-applied on top of every loaded or
 * refreshed table, so a `refresh()` never drops them. */
const registered: Record<string, Rates> = {};

/** Default static snapshot location used by `refresh()` when no url or source is given. */
export const SNAPSHOT_URL =
  'https://raw.githubusercontent.com/cendorhq/cendor-libs/main/packages/cendor-core/src/cendor/core/prices.json';
export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
export const AZURE_URL =
  "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=productName eq 'Azure OpenAI'";

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
  const cached = Math.min(Math.max(cachedTokens, 0), inputTokens); // cached ⊆ input; clamp defensively
  const inputRate = r.input;
  if (inputRate === undefined) throw new UnknownModelError(model);
  const cachedRate = 'cached' in r ? (r.cached as Decimal) : inputRate;
  const writeRate = 'cache_write' in r ? (r.cache_write as Decimal) : inputRate.times('1.25');
  const outputRate = r.output ?? new Dec(0);
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
  // A base with no `input` rate cannot price anything — `estimate` would raise later, which is the
  // silent-unpriced outcome this function exists to prevent. Fail at registration instead.
  if (copy.input === undefined) throw new UnknownModelError(opts.like);
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

/** `"bundled"` or `"refreshed"` — where the active table came from. */
export function source(): string {
  return sourceKind;
}

/** Finer provenance: `"bundled"` | `"litellm"` | `"openrouter"` | `"azure"` | `"custom"` | `"default"`. */
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

function mapLitellm(raw: DecimalJsonValue): Table {
  const out: Record<string, Rates> = {};
  const obj = raw as RawObject;
  for (const [mid, rec] of Object.entries(obj)) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const r = rec as RawObject;
    if (!('input_cost_per_token' in r)) continue;
    const rates: Rates = { input: dec(r.input_cost_per_token as DecimalJsonValue) };
    if (r.output_cost_per_token != null) rates.output = dec(r.output_cost_per_token);
    if (r.cache_read_input_token_cost != null) rates.cached = dec(r.cache_read_input_token_cost);
    out[normalizeModelId(mid)] = rates;
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
    const eff = String(it.effectiveStartDate ?? '').slice(0, 10);
    if (eff.length === 10 && (latest === null || eff > latest)) latest = eff;
    const sku = String(it.skuName ?? '');
    const low = sku.toLowerCase();
    let direction: 'input' | 'output';
    if (low.includes('input') || low.includes(' inp') || low.endsWith('inp')) direction = 'input';
    else if (low.includes('output') || low.includes('outp')) direction = 'output';
    else continue;
    const meterName = String(it.meterName ?? '').toLowerCase();
    if (!low.includes('global') && `${low} ${meterName}`.includes('regional')) continue;
    const price = it.retailPrice;
    if (price == null) continue;
    const perToken = dec(price).dividedBy(azureUnitDivisor(String(it.unitOfMeasure ?? '')));
    let head = low;
    for (const cut of [' inp', ' input', ' outp', ' output']) {
      if (head.includes(cut)) {
        head = head.slice(0, head.indexOf(cut));
        break;
      }
    }
    const words = head.trim().split(/\s+/).filter(Boolean);
    while (
      words.length &&
      /^\d+$/.test(words[words.length - 1] as string) &&
      [3, 4].includes((words[words.length - 1] as string).length)
    ) {
      words.pop();
    }
    const mid = normalizeModelId(words.join('-'));
    let rates = byModel[mid];
    if (rates === undefined) {
      rates = {};
      byModel[mid] = rates;
    }
    const existing = rates[direction];
    if (existing === undefined || perToken.lessThan(existing)) rates[direction] = perToken;
  }
  const out: Record<string, Rates> = {};
  for (const [mid, r] of Object.entries(byModel)) if ('input' in r) out[mid] = r;
  const result: Table = { models: out };
  if (latest !== null) result._updated = latest;
  return result;
}

type Mapper = (raw: DecimalJsonValue) => Table;
const SOURCES: Record<string, [string, Mapper]> = {
  litellm: [LITELLM_URL, mapLitellm],
  openrouter: [OPENROUTER_URL, mapOpenrouter],
  azure: [AZURE_URL, mapAzure],
};

/** Names of the built-in live price sources accepted by `refresh({ source })`. */
export function sources(): string[] {
  return Object.keys(SOURCES).sort();
}

export interface RefreshOptions {
  source?: string;
  mapper?: Mapper;
  timeout?: number;
}

/**
 * Replace the table from a live source or static JSON URL. Never throws; offline-safe. Returns `true`
 * if the table was updated, `false` if the fetch/parse/map failed (the current table stays active).
 * Mirrors `cendor.core.prices.refresh` (async here: uses `fetch`).
 */
export async function refresh(url?: string, opts: RefreshOptions = {}): Promise<boolean> {
  const { source: sourceArg, mapper, timeout = 5.0 } = opts;
  let target: string;
  let adapter: Mapper | undefined;
  let name: string;
  if (sourceArg != null) {
    const entry = SOURCES[sourceArg];
    if (entry === undefined) return false;
    target = entry[0];
    adapter = mapper ?? entry[1];
    name = sourceArg;
  } else {
    target = url || SNAPSHOT_URL;
    adapter = mapper;
    name = url ? 'custom' : 'default';
  }
  if (!target || !/^https?:\/\//i.test(target)) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    let text: string;
    try {
      const resp = await fetch(target, { signal: controller.signal });
      text = await resp.text();
    } finally {
      clearTimeout(timer);
    }
    const raw = parseDecimalJson(text);
    const data = adapter ? adapter(raw) : (raw as unknown as Table);
    if (data && typeof data === 'object' && data.models && Object.keys(data.models).length > 0) {
      Object.assign(data.models, registered); // programmatic registrations survive a refresh
      table = data;
      sourceKind = 'refreshed';
      sourceNameValue = name;
      sourceUrlValue = target;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Test helper: drop the loaded table (and registrations) so the bundled snapshot reloads. */
export function _reset(): void {
  table = null;
  sourceKind = 'bundled';
  sourceNameValue = 'bundled';
  sourceUrlValue = null;
  for (const k of Object.keys(registered)) delete registered[k];
}
