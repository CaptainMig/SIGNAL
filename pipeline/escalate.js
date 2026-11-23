// ---------------------------------------------------------------------------
// Escalation policy: which sweep verdicts earn a full-text check, and how the
// full-text verdict resolves the sweep flag.
//
// A sweep can only SUSPECT distortion (PROVISIONAL) or flag a dispute
// (CONTESTED) from the headline and a snippet; the article body decides.
// Outcomes feed the transition matrix — the sweep's precision.
// ---------------------------------------------------------------------------

export const ESCALATE_VERDICTS = new Set(['PROVISIONAL', 'CONTESTED']);

export function needsEscalation(sweepScore) {
  return !!sweepScore && ESCALATE_VERDICTS.has(sweepScore.verdict);
}

/**
 * Resolve a sweep flag against the full-text verdict.
 *   PROVISIONAL → confirmed when the full text says MISLEADING, else cleared.
 *   CONTESTED   → confirmed when the full text says CONTESTED, else cleared.
 * Returns 'confirmed' | 'cleared'. (pending is the absence of a full-text
 * verdict and is decided by the caller.)
 */
export function escalationOutcome(sweepVerdict, fulltextVerdict) {
  if (!fulltextVerdict) return 'pending';
  if (sweepVerdict === 'PROVISIONAL') return fulltextVerdict === 'MISLEADING' ? 'confirmed' : 'cleared';
  if (sweepVerdict === 'CONTESTED') return fulltextVerdict === 'CONTESTED' ? 'confirmed' : 'cleared';
  return 'cleared';
}
