// ---------------------------------------------------------------------------
// "Slam journalism" flag — a deterministic lexicon match, NOT an AI score.
// Ported from v1 unchanged in substance. Transparent and falsifiable: the
// matched word is stored on the row; the Slam Index is the share of headlines
// with any match. It never changes a verdict.
// ---------------------------------------------------------------------------

// CORE — almost always a framing tell. A core match alone sets the flag.
export const CORE = [
  'slams', 'slammed', 'blasts', 'blasted', 'rips into', 'ripped into', 'torches',
  'eviscerates', 'shreds', 'skewers', 'savages', 'unloads on', 'lashes out',
  'hits back', 'fires back', 'claps back', 'goes off on', 'tears into',
];

// WATCH — often literal. Counts toward the index with a muted badge, but must
// NOT, on its own, be treated as a hard flag.
export const WATCH = ['owns', 'schools', 'guts', 'destroys', 'hammers', 'roasts', 'erupts', 'explodes', 'fumes'];

// Nouns that mark a literal use of "guts" (e.g. "fire guts building").
const BUILDING_NOUNS = new Set([
  'building', 'house', 'home', 'factory', 'store', 'hotel', 'tower', 'apartment',
  'warehouse', 'school', 'church', 'mall', 'complex', 'block', 'restaurant',
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compile = (terms, tier) => terms.map((term) => ({ term, tier, re: new RegExp(`\\b${escape(term)}\\b`, 'i') }));

const CORE_RE = compile(CORE, 'core');
const WATCH_RE = compile(WATCH, 'watch');

// Suppress common literal uses the word-boundary check can't catch alone.
function isLiteral(term, title, idx) {
  const t = term.toLowerCase();
  const after = title.slice(idx + term.length).toLowerCase().match(/[a-z']+/g) || [];
  if ((t === 'slams' || t === 'slammed') && after[0] === 'into') return true; // car slams into
  if (t === 'guts' && after.slice(0, 3).some((w) => BUILDING_NOUNS.has(w))) return true; // fire guts (downtown) building
  return false;
}

/**
 * Detect a slam-journalism verb in a headline.
 * @returns {{ matched: boolean, term: string|null, tier: 'core'|'watch'|null }}
 */
export function detectSlam(title) {
  if (!title) return { matched: false, term: null, tier: null };
  for (const { term, tier, re } of [...CORE_RE, ...WATCH_RE]) {
    const m = re.exec(title);
    if (m && !isLiteral(term, title, m.index)) {
      return { matched: true, term: m[0].toLowerCase(), tier };
    }
  }
  return { matched: false, term: null, tier: null };
}
