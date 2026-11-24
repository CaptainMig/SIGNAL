// ---------------------------------------------------------------------------
// Text fingerprints: a MinHash signature stored instead of any text
// (docs/schema-brief.md §1, approved 2026-11-24).
//
// Deterministic and model-free: xxHash32 of each word shingle, then 128
// affine permutations (odd multiplier, additive offset, mod 2^32) and the
// minimum per permutation. A signature cannot be inverted to words; it
// estimates Jaccard similarity of shingle sets. Version `v` covers the
// normalization, the shingle size and the permutation constants together:
// any change is a new version, never a silent edit.
//
// Limits (brief §5): MinHash detects verbatim and near-verbatim reuse
// (syndication, light edits). It does not detect paraphrase. Low
// similarity is never evidence of original reporting. No public metric is
// derived from it yet.
// ---------------------------------------------------------------------------

export const FP_VERSION = 1;
export const TEXT_PERMS = 128;
export const TITLE_PERMS = 64;
export const TEXT_SHINGLE = 5;
export const TITLE_SHINGLE = 2;

const P1 = 2654435761;
const P2 = 2246822519;
const P3 = 3266489917;
const P4 = 668265263;
const P5 = 374761393;
const rotl = (x, r) => ((x << r) | (x >>> (32 - r))) >>> 0;
const round = (acc, lane) => Math.imul(rotl((acc + Math.imul(lane, P2)) >>> 0, 13), P1) >>> 0;

/** xxHash32 of a byte array with a seed. */
export function xxhash32(bytes, seed = 0) {
  const len = bytes.length;
  const read32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  let i = 0;
  let h;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    const limit = len - 16;
    while (i <= limit) {
      v1 = round(v1, read32(i));
      v2 = round(v2, read32(i + 4));
      v3 = round(v3, read32(i + 8));
      v4 = round(v4, read32(i + 12));
      i += 16;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = (seed + P5) >>> 0;
  }
  h = (h + len) >>> 0;
  while (i + 4 <= len) {
    h = (h + Math.imul(read32(i), P3)) >>> 0;
    h = Math.imul(rotl(h, 17), P4) >>> 0;
    i += 4;
  }
  while (i < len) {
    h = (h + Math.imul(bytes[i], P5)) >>> 0;
    h = Math.imul(rotl(h, 11), P1) >>> 0;
    i++;
  }
  h ^= h >>> 15;
  h = Math.imul(h, P2) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, P3) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const encoder = new TextEncoder();
export const hashString = (s, seed = 0) => xxhash32(encoder.encode(s), seed);

// Permutation constants, fixed by version: multiplier odd, offset any.
function permutations(n) {
  const a = new Uint32Array(n);
  const b = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = hashString(`signal-fp-v${FP_VERSION}-a-${i}`) | 1;
    b[i] = hashString(`signal-fp-v${FP_VERSION}-b-${i}`);
  }
  return { a, b };
}
const PERMS = { [TEXT_PERMS]: permutations(TEXT_PERMS), [TITLE_PERMS]: permutations(TITLE_PERMS) };

// Normalization: NFKC, lower case, letters and digits only, single spaces.
export function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokens(text) {
  const n = normalizeText(text);
  return n ? n.split(' ') : [];
}

// Word k-shingles as strings; fewer than k words gives one shingle of them all.
export function shingles(text, k) {
  const t = tokens(text);
  if (!t.length) return [];
  if (t.length <= k) return [t.join(' ')];
  const out = new Set();
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k).join(' '));
  return [...out];
}

/** MinHash signature (Uint32Array of length n) of a set of shingles. */
export function minhash(shingleList, n) {
  const { a, b } = PERMS[n] || permutations(n);
  const sig = new Uint32Array(n).fill(0xffffffff);
  for (const s of shingleList) {
    const h = hashString(s);
    for (let i = 0; i < n; i++) {
      const v = (Math.imul(a[i], h) + b[i]) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

export function encodeSignature(sig) {
  const bytes = new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
  return Buffer.from(bytes).toString('base64url');
}

export function decodeSignature(s) {
  const buf = Buffer.from(String(s || ''), 'base64url');
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Uint32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

/** Estimated Jaccard similarity of two encoded signatures of equal length. */
export function similarity(a, b) {
  const x = decodeSignature(a);
  const y = decodeSignature(b);
  if (!x.length || x.length !== y.length) return null;
  let same = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === y[i]) same++;
  return same / x.length;
}

/**
 * The row's fingerprint record. `text` is null when there is no text beyond
 * the headline; the headline signature is always present.
 *   { v, source: 'fulltext' | 'summary' | 'title', text, title, shingles, chars }
 */
export function rowFingerprint({ title = '', text = '', source = 'title' } = {}) {
  const titleShingles = shingles(title, TITLE_SHINGLE);
  const body = source === 'title' ? '' : normalizeText(text);
  const bodyShingles = body ? shingles(body, TEXT_SHINGLE) : [];
  return {
    v: FP_VERSION,
    source: bodyShingles.length ? source : 'title',
    text: bodyShingles.length ? encodeSignature(minhash(bodyShingles, TEXT_PERMS)) : null,
    title: titleShingles.length ? encodeSignature(minhash(titleShingles, TITLE_PERMS)) : null,
    shingles: bodyShingles.length,
    chars: body.length,
  };
}
