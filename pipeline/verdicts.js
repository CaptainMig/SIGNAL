// ---------------------------------------------------------------------------
// Verdict policy. The one idea that matters: the ARTICLE is the source of
// record. Every verdict describes the headline↔article relationship, never
// whether the news is true.
// ---------------------------------------------------------------------------

// The five MODEL verdicts — the set the model may return in sweep and
// full-text modes. parseScore rejects anything else.
export const MODEL_VERDICTS = ['VERIFIED', 'CONTEXTUAL', 'CONTESTED', 'UNVERIFIED', 'MISLEADING'];

// Display set. PROVISIONAL is a POLICY verdict, never a model verdict: a
// headline-only sweep cannot confirm distortion, so a sweep MISLEADING is held
// as PROVISIONAL until full-text scoring confirms or clears it.
export const DISPLAY_VERDICTS = ['VERIFIED', 'CONTEXTUAL', 'CONTESTED', 'UNVERIFIED', 'PROVISIONAL', 'MISLEADING'];

// Internal tokens are stable (the model emits them, the ledger stores them);
// a rename is a display mapping, never a data migration. UNVERIFIED is shown
// as UNVERIFIABLE: it says the claim can't be verified from what the article
// gives, not that the outlet is untrustworthy.
export const VERDICT_LABELS = { UNVERIFIED: 'UNVERIFIABLE' };
export const verdictLabel = (v) => (v == null ? 'TONE ONLY' : VERDICT_LABELS[v] || v);

export const VERDICT_COLORS = {
  VERIFIED: '#6fd49a',
  CONTEXTUAL: '#8bbef0',
  CONTESTED: '#c5a0f0',
  UNVERIFIED: '#c8971f',
  PROVISIONAL: '#e0876a',
  MISLEADING: '#f08080',
  UNSCORED: '#8d939e',
};

// Headline-vs-article language throughout (v1 defined these in world-truth
// terms — "factual, sourced, checkable claim" — which contradicted the prompt;
// see DEFECTS.md).
export const VERDICT_DEFINITIONS = {
  VERIFIED: 'The headline faithfully and fairly represents its own article. No spin relative to the body.',
  CONTEXTUAL:
    'The headline is accurate but omits context the article itself supplies that changes how a reader would take it. Not wrong — incomplete.',
  CONTESTED:
    'The article presents the claim as disputed, attributed, or denied; the headline states it more flatly than the article warrants.',
  UNVERIFIED:
    'The article itself flags the claim as developing, alleged, or anonymously sourced, and the headline drops that hedge. A property of the sourcing, not a judgment on the outlet.',
  PROVISIONAL:
    'The headline-only sweep flagged distortion, but a sweep never sees the article body, so it cannot confirm the call. Held until the full text confirms or clears it.',
  MISLEADING:
    'The headline exaggerates, distorts, or contradicts its own article body. Only full-text scoring can issue this verdict.',
  UNSCORED:
    'Not a verdict: the scoring call failed (timeout, error, or refusal). Excluded from every average — a default is never presented as a score.',
};

// Verdicts that count toward Framing Integrity.
export const INTEGRITY_VERDICTS = ['VERIFIED', 'CONTEXTUAL'];

// Sweep-side policy, applied after parsing: a headline-only sweep never saw
// the article body, so it cannot confirm distortion. A sweep MISLEADING is
// downgraded to PROVISIONAL — same axis numbers, same rationale — until
// full-text scoring (which may emit MISLEADING) confirms or clears it.
// LOCKED: headline-only scoring can never emit MISLEADING.
export function provisionalize(score) {
  if (!score || score.verdict !== 'MISLEADING') return score;
  return { ...score, verdict: 'PROVISIONAL', provisional: true };
}
