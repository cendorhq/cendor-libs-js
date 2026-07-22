/**
 * `@cendor/core` — the shared foundation. The TS port of `cendor.core`. Keep this public surface
 * small and stable. Namespaced modules (`bus`, `tokens`, `prices`, `protocols`) mirror the Python
 * submodules; value types and `instrument()` are top-level.
 */
export { LLMCall, Money, ToolCall, Usage, sumMoney, sumUsage } from './types.js';
export type { LLMCallInit, Message, ToolCallInit, UsageInit } from './types.js';
export { Dec, Decimal } from './decimal.js';
export type { DecimalValue } from './decimal.js';

export * as bus from './bus.js';
export * as tokens from './tokens.js';
export * as prices from './prices.js';
export * as protocols from './protocols.js';
export * as otel from './otel.js';

export {
  MISS,
  Reroute,
  addInterceptor,
  instrument,
  instrumentTool,
  removeInterceptor,
} from './instrument.js';
export type { Miss } from './instrument.js';
export { addAmbientProvider, removeAmbientProvider } from './ambient.js';
export type { AmbientEvent, AmbientProvider } from './ambient.js';
export { currentTraceId, installTraceContext, trace } from './trace.js';
export type { TraceContextStore } from './trace.js';

export type { Compressor, EvictionStrategy, Handle, Sink, Subscriber } from './protocols.js';
export { UnknownModelError } from './prices.js';
