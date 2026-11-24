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

// The scheduled scan fires at this minute past every hour (UTC). One place,
// read by the workflow comment, the site's NEXT RUN chip (via /api/meta) and
// the run report. Changing it re-registers the schedule with GitHub.
export const SCAN_MINUTE_UTC = 11;
// A run that starts less than this long after the previous run started is
// skipped (nothing scored, nothing written) unless forced: the external
// trigger and GitHub's own cron can both fire in the same hour.
export const SCAN_MIN_GAP_MINUTES = 40;

// Full-text extraction (escalation).
// Default per-attempt timeout; a feed can override it with `extractTimeoutMs`
// (the Washington Post answers in about a second or tarpits forever, so its
// feeds use a short one — DEFECTS.md v2-34).
export const EXTRACT_TIMEOUT_MS = 20_000;
export const EXTRACT_CONCURRENCY = 2;
export const EXTRACT_MIN_CHARS = 400; // below this the page is a stub (paywall / consent shell)
export const EXTRACT_MAX_CHARS = 12_000;

// Fetch identities for article pages, tried in order (pipeline/extract.js).
// The first is a complete Chrome header set: the bare user agent alone is
// tarpitted by at least one publisher. The second is a different browser
// family, the "retry with a different user agent".
export const EXTRACT_IDENTITIES = [
  {
    key: 'chrome',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  },
  {
    key: 'firefox',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Upgrade-Insecure-Requests': '1',
    },
  },
];

// Hosts the Vercel-side fetch route (api/fetch-article.js) will fetch from:
// the publishers in FEEDS and nothing else, so the route is never an open
// proxy. Matched on the registrable domain.
export const ARTICLE_HOSTS = [
  'apnews.com',
  'reuters.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk',
  'npr.org',
  'foxnews.com',
  'cbsnews.com',
  'go.com',
  'nbcnews.com',
  'cnn.com',
  'cnbc.com',
  'thehill.com',
  'politico.com',
  'theguardian.com',
  'wsj.com',
  'nytimes.com',
  'latimes.com',
  'nypost.com',
  'sky.com',
  'fortune.com',
  'ft.com',
];

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
const NATIONAL_FEEDS = [
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
  { name: 'Washington Post', outlet: 'Washington Post',
    extractTimeoutMs: 12_000, owner: 'Jeff Bezos / Nash Holdings', url: 'https://feeds.washingtonpost.com/rss/national' },
  { name: 'WaPo World', outlet: 'Washington Post',
    extractTimeoutMs: 12_000, owner: 'Jeff Bezos / Nash Holdings', url: 'https://feeds.washingtonpost.com/rss/world' },
  { name: 'WaPo Politics', outlet: 'Washington Post',
    extractTimeoutMs: 12_000, owner: 'Jeff Bezos / Nash Holdings', url: 'https://feeds.washingtonpost.com/rss/politics' },
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
// Feed packs. Every feed belongs to exactly one pack; every aggregate,
// history row, stats row, scorecard, daily summary and site view is computed
// per pack. Nothing is ever blended across packs. The national pack is the
// original ledger (data/); every other pack keeps its own derived files
// under data/packs/<key>/ (scan files are shared: rows carry `pack`).
// ---------------------------------------------------------------------------
export const PACKS = [
  { key: 'national', label: 'NATIONAL', description: 'Twenty-four national and international outlets.' },
  {
    key: 'regional-business',
    label: 'REGIONAL BUSINESS',
    description: 'Local business coverage in four metros: the Business Journals headline feed plus open local sources per metro.',
    metros: ['Washington DC', 'Baltimore', 'New York', 'Kansas City'],
  },
];
export const DEFAULT_PACK = 'national';
export const PACK_KEYS = PACKS.map((p) => p.key);

// Regional business pack. Coverage per feed was set from the publisher's
// robots.txt and terms (the review is in the feed-packs pull request and
// README): `thinBody: true` is headline-only / tone mode, used where the
// publisher names AI agents in robots.txt, restricts its RSS feed to
// personal non-commercial use, bars automated access in its feed terms, or
// refuses the fetch outright (the Business Journals, read through Google
// News). `coverage` records the reason in one word for the method page.
const bizj = (metro, slug) => ({
  name: `${metro} Business Journal (via Google News)`,
  outlet: `${metro} Business Journal`,
  owner: 'American City Business Journals',
  url: `https://news.google.com/rss/search?q=site:bizjournals.com/${slug}+when:2d&hl=en-US&gl=US&ceid=US:en`,
  thinBody: true,
  coverage: 'headline-only',
  coverageReason: 'publisher refuses automated feed access; robots.txt names AI agents',
});
const REGIONAL_BUSINESS_FEEDS = [
  // Washington DC
  { ...bizj('Washington', 'washington'), metro: 'Washington DC' },
  { name: 'WUSA9 Money', outlet: 'WUSA9', owner: 'TEGNA', metro: 'Washington DC', url: 'https://www.wusa9.com/feeds/syndication/rss/money', coverage: 'full-text', coverageReason: 'robots.txt allows; no AI-agent directive; no RSS restriction' },
  { name: 'Technical.ly DC', outlet: 'Technical.ly', owner: 'Technically Media', metro: 'Washington DC', url: 'https://technical.ly/?s=&market=dc&feed=rss2', coverage: 'full-text', coverageReason: 'robots.txt allows; no AI-agent directive; no terms page found' },
  { name: 'WAMU', outlet: 'WAMU', owner: 'American University / NPR', metro: 'Washington DC', url: 'https://wamu.org/feed/', thinBody: true, coverage: 'headline-only', coverageReason: 'robots.txt disallows anthropic-ai' },
  // Baltimore
  { ...bizj('Baltimore', 'baltimore'), metro: 'Baltimore' },
  { name: 'WMAR-2 Money', outlet: 'WMAR-2', owner: 'E.W. Scripps', metro: 'Baltimore', url: 'https://www.wmar2news.com/money.rss', coverage: 'full-text', coverageReason: 'robots.txt blocks only training crawlers (GPTBot, Google-Extended); no RSS restriction' },
  { name: 'CBS Baltimore', outlet: 'CBS Baltimore', owner: 'Paramount / CBS', metro: 'Baltimore', url: 'https://www.cbsnews.com/baltimore/latest/rss/main', coverage: 'full-text', coverageReason: 'robots.txt blocks only GPTBot; same host and terms as the national CBS feed; general local news, no business section feed' },
  { name: 'WYPR', outlet: 'WYPR', owner: 'Baltimore Public Media / NPR', metro: 'Baltimore', url: 'https://www.wypr.org/news.rss', thinBody: true, coverage: 'headline-only', coverageReason: 'robots.txt disallows anthropic-ai and ClaudeBot' },
  // New York
  { ...bizj('New York', 'newyork'), metro: 'New York' },
  { name: 'Gothamist', outlet: 'Gothamist', owner: 'New York Public Radio', metro: 'New York', url: 'https://gothamist.com/feed', thinBody: true, coverage: 'headline-only', coverageReason: 'feed terms: RSS for personal, non-commercial use only' },
  { name: 'CBS New York', outlet: 'CBS New York', owner: 'Paramount / CBS', metro: 'New York', url: 'https://www.cbsnews.com/newyork/latest/rss/main', coverage: 'full-text', coverageReason: 'robots.txt blocks only GPTBot; same host and terms as the national CBS feed; general local news' },
  { name: 'THE CITY', outlet: 'THE CITY', owner: 'THE CITY (nonprofit)', metro: 'New York', url: 'https://www.thecity.nyc/feed/', thinBody: true, coverage: 'headline-only', coverageReason: 'robots.txt disallows ClaudeBot, Claude-User, Claude-SearchBot' },
  { name: 'amNY', outlet: 'amNY', owner: 'Schneps Media', metro: 'New York', url: 'https://www.amny.com/feed/', thinBody: true, coverage: 'headline-only', coverageReason: 'robots.txt disallows anthropic-ai and ClaudeBot' },
  // Kansas City
  { ...bizj('Kansas City', 'kansascity'), metro: 'Kansas City' },
  { name: 'KCUR Business', outlet: 'KCUR', owner: 'University of Missouri-Kansas City / NPR', metro: 'Kansas City', url: 'https://www.kcur.org/tags/business.rss', coverage: 'full-text', coverageReason: 'robots.txt allows all; NPR terms bar scraping to republish and AI training, neither of which this is' },
  { name: 'KSHB 41 Money', outlet: 'KSHB 41', owner: 'E.W. Scripps', metro: 'Kansas City', url: 'https://www.kshb.com/money.rss', coverage: 'full-text', coverageReason: 'robots.txt blocks only training crawlers (GPTBot, Google-Extended); no RSS restriction' },
  { name: 'Flatland', outlet: 'Flatland', owner: 'Kansas City PBS', metro: 'Kansas City', url: 'https://flatlandkc.org/feed/', coverage: 'full-text', coverageReason: 'robots.txt allows all; terms page unreadable (embed)' },
  { name: 'Startland News', outlet: 'Startland News', owner: 'Startland (independent)', metro: 'Kansas City', url: 'https://www.startlandnews.com/feed/', thinBody: true, coverage: 'headline-only', coverageReason: 'terms bar any robot or automated access to the website' },
];

export const FEEDS = [
  ...NATIONAL_FEEDS.map((f) => ({ ...f, pack: 'national' })),
  ...REGIONAL_BUSINESS_FEEDS.map((f) => ({ ...f, pack: 'regional-business' })),
];

export function feedsForPack(key) {
  return FEEDS.filter((f) => (f.pack || DEFAULT_PACK) === key);
}

export function packOf(feedOrRow) {
  return feedOrRow?.pack || DEFAULT_PACK;
}

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
