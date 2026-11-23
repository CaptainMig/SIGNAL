// ---------------------------------------------------------------------------
// Run cost telemetry from token usage. An estimate from the captured price
// table — the invoice is the source of record.
// ---------------------------------------------------------------------------
import { PRICING } from './config.js';

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(a, b) {
  return {
    input: (a?.input || 0) + (b?.input || 0),
    output: (a?.output || 0) + (b?.output || 0),
    cacheRead: (a?.cacheRead || 0) + (b?.cacheRead || 0),
    cacheWrite: (a?.cacheWrite || 0) + (b?.cacheWrite || 0),
  };
}

// USD, rounded to 6 places.
export function costOf(usage, pricing = PRICING) {
  const u = usage || emptyUsage();
  const usd =
    (u.input * pricing.inputPerMTok +
      u.output * pricing.outputPerMTok +
      u.cacheRead * pricing.cacheReadPerMTok +
      u.cacheWrite * pricing.cacheWritePerMTok) /
    1e6;
  return Math.round(usd * 1e6) / 1e6;
}
