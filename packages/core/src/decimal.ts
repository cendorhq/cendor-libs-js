/**
 * A single configured Decimal constructor for the whole stack, mirroring Python's default
 * `decimal.Decimal` context: 28 significant digits, ROUND_HALF_EVEN. Using a `clone()` (rather than
 * mutating the global `Decimal`) keeps this side-effect-free so `sideEffects: false` tree-shaking is
 * safe. Money is decimal, never an IEEE float — see the price-dataset / bus-events specs.
 */
import { Decimal } from 'decimal.js';

export const Dec = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export { Decimal };
export type DecimalValue = Decimal.Value;
