// ---------------------------------------------------------------------------
// Seeded PRNG — bootstrap intervals and permutation p-values must be
// reproducible for a given run (a cited number has to be stable). Never use
// Math.random in the pipeline. Ported from v1.
// ---------------------------------------------------------------------------

// mulberry32: tiny, fast, good-enough 32-bit PRNG. Returns a function → [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 32-bit seed from strings, numbers, booleans, and arrays of
// them (FNV-1a over a flattened encoding). Same inputs → same seed.
export function seedFrom(...parts) {
  let h = 0x811c9dc5 >>> 0;
  const mix = (v) => {
    h = Math.imul(h ^ v, 0x01000193) >>> 0;
  };
  const walk = (v) => {
    if (Array.isArray(v)) {
      mix(v.length);
      for (const x of v) walk(x);
    } else if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) mix(v.charCodeAt(i));
    } else if (typeof v === 'number') {
      mix(Math.round(v * 1000) | 0);
    } else if (typeof v === 'boolean') {
      mix(v ? 1 : 0);
    } else if (v == null) {
      mix(0x7f);
    } else {
      walk(String(v));
    }
  };
  for (const p of parts) walk(p);
  return h >>> 0;
}
