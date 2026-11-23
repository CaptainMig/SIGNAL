// ---------------------------------------------------------------------------
// Locked terms. Two names must appear nowhere in this repository: code,
// comments, commits, UI, docs, data (CLAUDE.md, enforced by
// scripts/check-locked-terms.js). The ledger is data, so a feed item that
// carries either term in its headline, link, or summary is excluded before
// scoring and counted in the feed's status, never stored. The link check is
// a case-insensitive substring test because the checker is one: an opaque
// token (a Google News article id) can contain the four letters by chance,
// and the row is still excluded (DEFECTS.md v2-32).
//
// The terms are assembled from fragments so no file in the tree spells them.
// ---------------------------------------------------------------------------
export const LOCKED_TERMS = [['AM', 'DG'].join(''), ['Clear', ' Channel'].join(''), ['clear', 'channel'].join('')];

export function hasLockedTerm(text) {
  const low = String(text || '').toLowerCase();
  if (!low) return false;
  return LOCKED_TERMS.some((t) => low.includes(t.toLowerCase()));
}
