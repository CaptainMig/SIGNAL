// ---------------------------------------------------------------------------
// Signal v2 — static configuration.
//
// Everything here is read by the scheduled pipeline (scripts/scan.js). Nothing
// in this file runs in a browser. API keys never live here: the scorer reads
// ANTHROPIC_API_KEY from the environment at runtime, server-side only.
// ---------------------------------------------------------------------------

export const METHODOLOGY = 'v2';

// Scoring model. The exact string is the Claude API ID for the current Sonnet
// (confirmed against platform.claude.com/docs/en/models/overview, Nov 2026).
// Every ledger row stores the model that actually served it (response.model).
export const MODEL = 'claude-sonnet-5-5';

// Per-million-token prices used for the run cost telemetry. Captured from the
// models overview + pricing page; `asOf` says when. The telemetry is an
// estimate — the invoice is the source of record.
export const PRICING = {
  model: MODEL,
  asOf: '2026-11-23',
  currency: 'USD',
  inputPerMTok: 2.0,
  outputPerMTok: 10.0,
  cacheWritePerMTok: 2.5, // 1.25x input
  cacheReadPerMTok: 0.1, // 5% of input on Sonnet 5.5
};

// Thinking / effort for the scorer. A rubric classification does not need
// extended reasoning; thinking is off (`between_tools` is the only accepted
// off-mode on Sonnet 5.5) and effort low. Both overridable from the environment
// so the operator can run an A/B without a code change.
export const THINKING = process.env.SIGNAL_THINKING || 'between_tools'; // 'between_tools' | 'adaptive'
export const EFFORT = process.env.SIGNAL_EFFORT || 'low'; // low | medium | high

// Scorer concurrency and budgets.
export const SCORE_CONCURRENCY = 4;
export const SCORE_TIMEOUT_MS = 45_000;
export const SCORE_MAX_RETRIES = 3;
export const SCORE_MAX_TOKENS = 600;

// Feed ingestion.
export const HEADLINES_PER_FEED = 10;
export const FEED_TIMEOUT_MS = 20_000;
// Items with a parseable published date older than this are dropped before
// scoring — never counted in totals, aggregates, or history. Items with NO
// parseable date are kept but tagged `undated`.
export const MAX_ITEM_AGE_HOURS = 48;
// A cleaned headline shorter than this is rejected as malformed (feed junk).
export const MIN_HEADLINE_CHARS = 15;

// Full-text extraction (escalation).
export const EXTRACT_TIMEOUT_MS = 30_000; // raised from 20s: WaPo article fetches timed out in the first live run
export const EXTRACT_CONCURRENCY = 2;
export const EXTRACT_MIN_CHARS = 400; // below this the page is a stub (paywall / consent shell)
export const EXTRACT_MAX_CHARS = 12_000;

// Body budgets sent to the model, by mode.
export const BODY_CHARS = { sweep: 1200, fulltext: 8000, tone: 0 };

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// News feeds. `name` is the feed label (publication), `outlet` the outlet
// identity every comparison and ranking groups on (three WaPo feeds are one
// outlet; two BBC feeds are one outlet), `owner` the parent entity.
// `thinBody: true` marks feeds that deliver a headline and no usable article
// text (Google News aggregation, paywalled teasers): those rows are scored for
// tone only (sensationalism + clickbait) and never for fidelity.
// Ported from the v1 feed list; Google News recoveries are labelled honestly.
export const FEEDS = [
  {
    name: 'AP (via Google News)',
    outlet: 'AP',
    owner: 'Associated Press',
    url: 'https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    thinBody: true,
  },
  {
    name: 'Reuters (via Google News)',
    outlet: 'Reuters',
    owner: 'Thomson Reuters',
    url: 'https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    thinBody: true,
  },
  { name: 'Washington Post', outlet: 'Washington Post', owner: 'Jeff Bezos / Nash Holdings', url: 'https://feeds.washingtonpost.com/rss/national' },
  { name: 'WaPo World', outlet: 'Washington Post', owner: 'Jeff Bezos / Nash Holdings', url: 'https://feeds.washingtonpost.com/rss/world' },
  { name: 'WaPo Politics', outlet: 'Washington Post', owner: 'Jeff Bezos / Nash Holdings', url: 'https://feeds.washingtonpost.com/rss/politics' },
  { name: 'BBC News', outlet: 'BBC', owner: 'BBC / UK Public', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'BBC World', outlet: 'BBC', owner: 'BBC / UK Public', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'NPR News', outlet: 'NPR', owner: 'NPR / Public', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'Fox News', outlet: 'Fox News', owner: 'News Corp', url: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
  { name: 'CBS News', outlet: 'CBS News', owner: 'Paramount / CBS', url: 'https://www.cbsnews.com/latest/rss/main' },
  { name: 'ABC News', outlet: 'ABC News', owner: 'Disney / ABC', url: 'https://abcnews.go.com/abcnews/usheadlines' },
  { name: 'NBC News', outlet: 'NBC News', owner: 'Comcast / NBCUniversal', url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  {
    name: 'CNN (via Google News)',
    outlet: 'CNN',
    owner: 'Warner Bros. Discovery',
    url: 'https://news.google.com/rss/search?q=site:cnn.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    thinBody: true,
  },
  { name: 'CNBC', outlet: 'CNBC', owner: 'Comcast / NBCUniversal', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html' },
  { name: 'The Hill', outlet: 'The Hill', owner: 'Nexstar Media', url: 'https://thehill.com/feed/' },
  { name: 'Politico', outlet: 'Politico', owner: 'Axel Springer', url: 'https://rss.politico.com/politics-news.xml' },
  // theguardian.com answers 403 to the GitHub runner (first live run). The
  // Open Platform's free developer key is for non-commercial use only; the
  // commercial key (priced on request) covers "products derived from Guardian
  // content", which is what Signal is. Until a commercial key exists, the
  // Guardian is recovered through Google News and scored for tone only.
  // DEFECTS.md v2-10.
  {
    name: 'The Guardian (via Google News)',
    outlet: 'The Guardian',
    owner: 'Scott Trust',
    url: 'https://news.google.com/rss/search?q=site:theguardian.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    thinBody: true,
  },
  {
    name: 'WSJ (via Google News)',
    outlet: 'WSJ',
    owner: 'News Corp',
    url: 'https://news.google.com/rss/search?q=site:wsj.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    thinBody: true,
  },
  { name: 'NY Times', outlet: 'NY Times', owner: 'NYT Co.', url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml' },
  { name: 'LA Times', outlet: 'LA Times', owner: 'Patrick Soon-Shiong', url: 'https://www.latimes.com/world/rss2.0.xml' },
  { name: 'New York Post', outlet: 'New York Post', owner: 'News Corp', url: 'https://nypost.com/feed/' },
  { name: 'Sky News', outlet: 'Sky News', owner: 'Comcast', url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
  { name: 'Fortune', outlet: 'Fortune', owner: 'Fortune Media', url: 'https://fortune.com/feed/' },
  // Paywalled: the feed carries a teaser, not the article. Tone only.
  { name: 'Financial Times', outlet: 'Financial Times', owner: 'Nikkei', url: 'https://www.ft.com/rss/home', thinBody: true },
];

// ---------------------------------------------------------------------------
// Methodology v2 statistics (phase 2).
// ---------------------------------------------------------------------------
// Outlet-balanced Framing Integrity: an outlet needs at least this many text
// rows in the run to enter the balanced mean (DEFECTS.md v2-6).
export const OUTLET_MIN_N = 5;
// Scorecards: minimum rolling-7-day n to be ranked; shrinkage strength (the
// pooled rate's weight in pseudo-rows) for the beta-binomial estimate.
export const SCORECARD_WINDOW_DAYS = 7;
export const SCORECARD_MIN_N = 20;
export const SHRINK_STRENGTH = 20;
// Seeded resampling.
export const BOOTSTRAP_ITERATIONS = 2000;
export const PERMUTATION_ITERATIONS = 5000;
export const PERMUTATION_MIN_GROUP = 5;
// Escalation: CONTEXTUAL rows at or below this fidelity get the article
// (DEFECTS.md v2-14).
export const ESCALATE_CONTEXTUAL_MAX_FIDELITY = 6;
// Extraction retry policy: a failed article fetch is retried on the next
// runs up to this many total attempts, then the row is UNRESOLVED
// (DEFECTS.md v2-15).
export const EXTRACT_MAX_ATTEMPTS = 4;
// Audit sample of sweep VERIFIED / CONTEXTUAL rows sent to full text each run
// (DEFECTS.md v2-8, v2-14): 10 per run, half and half, for the first 14 days
// from AUDIT_START, then 5.
export const AUDIT_START = '2026-11-24';
export const AUDIT_BOOST_DAYS = 14;
export const AUDIT_PER_RUN_BOOST = 10;
export const AUDIT_PER_RUN = 5;
// Golden set: a frozen headline+article set scored every run (overridable:
// SIGNAL_GOLDEN_EVERY=24 scores it once a day). Agreement below the alert
// threshold flags scorer drift in the UI.
export const GOLDEN_EVERY_N_RUNS = Math.max(1, Number(process.env.SIGNAL_GOLDEN_EVERY) || 1);
export const GOLDEN_ALERT_BELOW_PCT = 90;

// Ledger locations, relative to the repo root.
export const DATA_DIR = 'data';
