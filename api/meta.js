// GET /api/meta — the site's single source of truth for verdict policy and
// feed configuration, imported from the pipeline so copy can never drift
// from the code that scores.
import { cors } from './_ledger.js';
import { DISPLAY_VERDICTS, INTEGRITY_VERDICTS, MODEL_VERDICTS, VERDICT_COLORS, VERDICT_DEFINITIONS, VERDICT_LABELS } from '../pipeline/verdicts.js';
import { BODY_CHARS, DEFAULT_PACK, EXTRACT_MAX_ATTEMPTS, FEEDS, HEADLINES_PER_FEED, MAX_ITEM_AGE_HOURS, METHODOLOGY, MODEL, PACKS, PRICING, SCAN_MINUTE_UTC } from '../pipeline/config.js';
import { CORE, WATCH } from '../pipeline/slam.js';

const META = {
  methodology: METHODOLOGY,
  model: MODEL,
  pricing: PRICING,
  bodyChars: BODY_CHARS,
  headlinesPerFeed: HEADLINES_PER_FEED,
  maxItemAgeHours: MAX_ITEM_AGE_HOURS,
  scanMinuteUtc: SCAN_MINUTE_UTC,
  extractMaxAttempts: EXTRACT_MAX_ATTEMPTS,
  verdicts: { model: MODEL_VERDICTS, display: DISPLAY_VERDICTS, integrity: INTEGRITY_VERDICTS, labels: VERDICT_LABELS, colors: VERDICT_COLORS, definitions: VERDICT_DEFINITIONS },
  packs: PACKS,
  defaultPack: DEFAULT_PACK,
  feeds: FEEDS.map((f) => ({ name: f.name, outlet: f.outlet || f.name, owner: f.owner, thinBody: !!f.thinBody, host: safeHost(f.url), pack: f.pack || DEFAULT_PACK, metro: f.metro || null, scope: f.scope || 'general', coverage: f.coverage || (f.thinBody ? 'headline-only' : 'full-text'), coverageReason: f.coverageReason || null })),
  slam: { core: CORE, watch: WATCH },
};

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json(META);
}
