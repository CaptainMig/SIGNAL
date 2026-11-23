// ---------------------------------------------------------------------------
// Scoring prompt, output schema, and response normalization.
//
// Ported from v1 (signal/src/lib/prompt.js) with these edits:
//   - the axis is called `fidelity` on the wire (v1 called it `truth`);
//   - three modes: sweep (headline + feed summary), fulltext (headline +
//     extracted body), tone (headline only: sensationalism + clickbait, no
//     fidelity, no verdict);
//   - output is schema-constrained (structured outputs), parsed defensively.
// Every ledger row stores promptHash so a prompt edit is visible in the data.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { MODEL_VERDICTS, provisionalize } from './verdicts.js';
import { BODY_CHARS } from './config.js';

const VALID_VERDICTS = new Set(MODEL_VERDICTS);

export const MODES = ['sweep', 'fulltext', 'tone'];

export const SYSTEM_PROMPT = `You are Signal, a media-integrity scorer. You judge how a HEADLINE frames
the ARTICLE attached to it. You are NOT a fact-checker of the world.

SOURCE OF RECORD — hard rule:
The supplied article text is your only truth. Treat it as accurate. NEVER use
your own background knowledge to decide whether the event is real, recent, or
plausible. If a headline reports something you don't recognize, that is NOT a
mark against it — recent news is by definition outside your training. Score
ONLY the relationship between the headline and the article body, plus the
framing signals inside the text itself.

Score three axes 0–10, return one verdict.

fidelity (0–10): how accurately the headline conveys the article's main
  claim. 10 = exact, no distortion. 0 = contradicts or invents.
sensationalism (0–10): emotional inflation/alarm beyond what the article
  supports. 0 = flat and proportionate. 10 = maximally inflammatory.
clickbait (0–10): teasing, curiosity-gap, withheld payoff, vague pronouns.
  0 = fully informative. 10 = pure tease.

VERDICT — exactly one, from the headline↔article relationship only:
  VERIFIED   — headline faithfully and fairly represents the article.
  CONTEXTUAL — accurate but omits context the article supplies that changes
               how a reader would take it.
  CONTESTED  — the ARTICLE presents the claim as disputed/attributed/denied,
               and the headline states it more flatly than the article warrants.
  UNVERIFIED — the ARTICLE itself flags the claim as developing, alleged, or
               anonymously sourced, and the headline drops that hedge.
  MISLEADING — headline exaggerates, distorts, or contradicts the article body.

SHORTHAND IS NOT DISTORTION. Standard editorial compression is faithful:
"merger" for an acquisition, short company names (Paramount for Paramount
Skydance, Warner for Warner Bros. Discovery), "X-Y merger" phrasing (which
asserts no direction of acquisition), rounded figures, and title shorthand.
MISLEADING requires the headline to assert something the article CONTRADICTS —
not to use a less precise synonym for something the article describes. If the
headline's claim and the article's account describe the same event at different
precision, that is VERIFIED (or CONTEXTUAL if the lost precision changes the
reader's takeaway), never MISLEADING.

You may NEVER assign UNVERIFIED or low fidelity because you personally don't
know about the event. Those come from the ARTICLE's own signals, not your
knowledge. If the article confirms the claim plainly, it is VERIFIED.

rationale: one sentence, max 20 words, about headline vs article only.

Worked example (lock this behavior):
HEADLINE: Starmer quits as Labour leader and paves way for contest for new prime minister
ARTICLE: Keir Starmer announced he will resign as PM and Labour leader, remaining as caretaker until a successor is chosen. Nominations open July 9.
→ {"verdict":"VERIFIED","fidelity":9,"sensationalism":2,"clickbait":1,"rationale":"Headline matches the article's stated resignation plainly, no inflation."}`;

// Appended in full-text mode: same rubric and verdicts, but the body is the
// real article and the rationale is fuller (the detail page shows it verbatim).
export const FULLTEXT_SUFFIX = `

FULL-TEXT MODE: the ARTICLE below is the extracted full text of the story (it
may be truncated). Judge whether the body actually supports the headline's
claim. rationale: 2-3 sentences, max 60 words, citing what the body does or
does not support.`;

// Appended in tone mode: no article text exists for this row, so fidelity and
// the verdict are NOT scored. Only the two tone axes are.
export const TONE_SUFFIX = `

HEADLINE-ONLY MODE: no article text is available for this headline, so you
CANNOT judge fidelity and must NOT return a verdict. Score only sensationalism
and clickbait from the headline's own wording. rationale: one sentence, max 15
words, about the headline's tone only.`;

export function systemPromptFor(mode) {
  if (mode === 'fulltext') return SYSTEM_PROMPT + FULLTEXT_SUFFIX;
  if (mode === 'tone') return SYSTEM_PROMPT + TONE_SUFFIX;
  return SYSTEM_PROMPT;
}

// Structured-output schemas. `additionalProperties: false` is required by the
// API; numeric bounds are not supported in the schema, so they are clamped in
// parseScore.
const RATIONALE = { type: 'string', description: 'Short rationale about headline vs article.' };

export const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: MODEL_VERDICTS },
    fidelity: { type: 'integer', description: '0-10' },
    sensationalism: { type: 'integer', description: '0-10' },
    clickbait: { type: 'integer', description: '0-10' },
    rationale: RATIONALE,
  },
  required: ['verdict', 'fidelity', 'sensationalism', 'clickbait', 'rationale'],
  additionalProperties: false,
};

export const TONE_SCHEMA = {
  type: 'object',
  properties: {
    sensationalism: { type: 'integer', description: '0-10' },
    clickbait: { type: 'integer', description: '0-10' },
    rationale: RATIONALE,
  },
  required: ['sensationalism', 'clickbait', 'rationale'],
  additionalProperties: false,
};

export function schemaFor(mode) {
  return mode === 'tone' ? TONE_SCHEMA : SCORE_SCHEMA;
}

// The per-headline user turn. Body is truncated to the mode's budget.
export function userContent(headline, article, mode = 'sweep') {
  const max = BODY_CHARS[mode] ?? BODY_CHARS.sweep;
  if (mode === 'tone') return `HEADLINE: ${headline}`;
  const body = (article || '').toString().slice(0, max);
  return `HEADLINE: ${headline}\nARTICLE: ${body}`;
}

// Stable fingerprint of everything that shapes a verdict for a mode: the
// system text, the schema, and the body budget. Twelve hex chars of SHA-256.
export function promptHash(mode = 'sweep') {
  const h = createHash('sha256');
  h.update(systemPromptFor(mode));
  h.update('\n' + JSON.stringify(schemaFor(mode)));
  h.update('\n' + String(BODY_CHARS[mode] ?? BODY_CHARS.sweep));
  return h.digest('hex').slice(0, 12);
}

function clampAxis(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(10, Math.max(0, v));
}

const MAX_RATIONALE = 420;

/**
 * Normalize the model's JSON text into a score for `mode`. Throws on a
 * malformed response — the caller marks the row UNSCORED (reason 'parse');
 * nothing here ever fabricates a default verdict.
 *
 * Sweep mode applies the PROVISIONAL policy (never emits MISLEADING).
 * Tone mode returns no verdict and no fidelity.
 */
export function parseScore(text, mode = 'sweep') {
  const match = text && String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in response');
  const raw = JSON.parse(match[0]);
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, MAX_RATIONALE) : '';
  const sens = clampAxis(raw.sensationalism ?? raw.sens);
  const click = clampAxis(raw.clickbait ?? raw.click);
  if (sens == null || click == null) throw new Error('missing tone axes');

  if (mode === 'tone') {
    return { verdict: null, fidelity: null, sens, click, rationale };
  }

  const verdict = String(raw.verdict || '').toUpperCase();
  if (!VALID_VERDICTS.has(verdict)) throw new Error(`bad verdict: ${verdict}`);
  const fidelity = clampAxis(raw.fidelity ?? raw.truth);
  if (fidelity == null) throw new Error('missing fidelity');

  const score = { verdict, fidelity, sens, click, rationale };
  return mode === 'sweep' ? provisionalize(score) : score;
}
