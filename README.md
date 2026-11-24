# Signal v2

**A media-integrity scanner that scores how faithfully a headline represents
its own article, not whether the news is true.**

Owner: Starpoint LLC. Live at [anthony-signal.vercel.app](https://anthony-signal.vercel.app).
The v1 app that previously served that address lives, archived, in
`anthony-charts/signal/`.

Link previews use `site/og.png` (1200×630, "Signal — Media Integrity
Scanner"), rendered from `scripts/og/template.html` with
`node scripts/og/render.js`; the PNG is never hand-edited.

## Feed packs

Every feed belongs to exactly one pack (`pack` in `pipeline/config.js`).
Every aggregate, history row, stats row, scorecard, daily tone summary and
site view is computed per pack; nothing is ever blended across packs. The
site has a pack switch in the chip row (`?pack=<key>`, remembered per
device). The national pack is the original ledger at `data/`; every other
pack keeps its own derived files under `data/packs/<key>/`. Scan files are
shared (rows carry `pack` and `metro`).

| Pack | Feeds | Files |
|---|---|---|
| `national` | the 24 national and international feeds | `data/history.csv`, `stats.csv`, `latest.json`, `aggregate.json`, `daily.json` |
| `regional-business` | 18 feeds across Washington DC, Baltimore, New York and Kansas City | `data/packs/regional-business/…` |

### Regional business pack: coverage review (2026-11-24)

Each candidate's `robots.txt` and terms were read before it was added.
A feed is **headline-only** (tone mode, the article is never fetched) when the
publisher names AI agents in `robots.txt`, restricts its RSS feed to personal
non-commercial use, bars automated access in its terms, or refuses the fetch.
Generic anti-scraping boilerplate without an RSS clause (TEGNA, Scripps,
Paramount) is treated as it is for the national pack's CBS, NBC and Fox
feeds; the operator can flip any feed to headline-only with `thinBody: true`.

| Metro | Feed | Coverage | robots.txt | Terms |
|---|---|---|---|---|
| DC | Washington Business Journal (via Google News) | headline-only | names AI agents (ClaudeBot, anthropic-ai, GPTBot…) | direct feed and terms page refuse the fetch (403 / bot challenge) |
| DC | WUSA9 Money | full text | `*` allowed, no AI directive | TEGNA: generic no-automation clause, no RSS clause |
| DC | Technical.ly DC | full text | `*` allowed, no AI directive | no terms page found (404) |
| DC | WAMU | headline-only | disallows anthropic-ai | — |
| Baltimore | Baltimore Business Journal (via Google News) | headline-only | as above | as above |
| Baltimore | WMAR-2 Money | full text | blocks GPTBot, Google-Extended only | Scripps: generic no-scraping clause, no RSS clause |
| Baltimore | CBS Baltimore (general local) | full text | blocks GPTBot only | Paramount: generic no-scraping clause (same as national CBS) |
| Baltimore | WYPR | headline-only | disallows anthropic-ai, ClaudeBot | — |
| New York | New York Business Journal (via Google News) | headline-only | as above | as above |
| New York | Gothamist | headline-only | blocks GPTBot, CCBot, Google-Extended | WNYC: RSS "for your personal, noncommercial use only" |
| New York | CBS New York (general local) | full text | blocks GPTBot only | Paramount, as above |
| New York | THE CITY | headline-only | disallows ClaudeBot, Claude-User, Claude-SearchBot | — |
| New York | amNY | headline-only | disallows anthropic-ai, ClaudeBot | — |
| Kansas City | Kansas City Business Journal (via Google News) | headline-only | as above | as above |
| Kansas City | KCUR Business | full text | `*` allowed, nothing disallowed | NPR: bars scraping to republish and AI training; neither applies |
| Kansas City | KSHB 41 Money | full text | blocks GPTBot, Google-Extended only | Scripps, as above |
| Kansas City | Flatland | full text | `*` allowed | terms page is a third-party embed, unread |
| Kansas City | Startland News | headline-only | `*` allowed | terms bar "any robot, spider or other similar automatic technology" |

Checked and excluded: NY1 (`robots.txt` disallows `/*` for every agent),
Crain's New York (ClaudeBot disallowed, paywall, feed 403), The Baltimore
Banner (feed and terms pages are a JavaScript shell; nothing readable),
Baltimore Fishbowl and The Beacon (feed rate-limits the fetch with 429; the
Fishbowl's terms also restrict its RSS to non-commercial use), Baltimore Brew
(no feed found), WTOP (business feed empty; ClaudeBot disallowed), WBAL-TV
and KMBC (anthropic-ai disallowed; general-news feeds), FOX5 DC (business
feed returns 500; terms bar AI use), PIX11 and ABC7NY (anthropic-ai
disallowed), The Real Deal and Brooklyn Eagle (robots and feed refuse the
fetch), City & State NY (no feed found).

## The one idea that matters

The article is the source of record. Signal never fact-checks the world. Each
headline is scored against the article it links to: a true event the model has
never heard of comes back VERIFIED if the headline matches the story; a
distorted headline on a real event comes back MISLEADING. Newness is never
penalized.

## Architecture (v2)

```
GitHub Actions, hourly          scripts/scan.js
  fetch 24 feeds  ─▶  dedupe by canonical link  ─▶  sweep score  ─▶  escalate flagged rows to full text
                                                                              │
                                                      data/scans/YYYY-MM-DD/HH.json   every row + telemetry
                                                      data/history.csv                one row per run, append-only
                                                      data/latest.json                what the site reads
                                                      data/aggregate.json             24h aggregate for anthonycharts
```

- Scans run server-side on a schedule. Visitors never trigger scoring; there
  is no scoring endpoint.
- The ledger is append-only and lives in the repo. A scan file is never
  rewritten (a second run in the same UTC hour writes `HH.2.json`);
  `history.csv` rows are never edited; a column change is a new file.
- Scan files are deltas: run telemetry plus only the rows scored or re-scored
  in that run. Rows carried forward unchanged are listed in `carried` as
  `{ id, run }`, where `run` is the scan file that holds the full record
  (every row carries `writtenIn` for this). `latest.json` is always the full
  current view; `pipeline/ledger.js` `resolveRuns` expands a window of delta
  files back into full row sets for carry-forward and the aggregate.
- Every scored row stores the model that served it and the prompt hash of the
  mode it was scored in, so a prompt edit or model change is visible in the data.
- Phase 3 adds the static site (telemetry deck, headline table, article
  detail) and `/api/aggregate`, which serves `data/aggregate.json` in the
  v1 response shape. Phase 2 adds the statistical layer (cluster bootstrap,
  Wilson intervals, shrinkage, within-outlet permutation, golden set).

## Scoring

Model: `claude-sonnet-5-5` (the current Sonnet; the ID is confirmed against the
Anthropic models page). Thinking off (`between_tools`), effort `low`, output
constrained to a JSON schema. Both are overridable with `SIGNAL_THINKING` and
`SIGNAL_EFFORT` for an A/B without a code change.

Three modes, chosen by the evidence actually in hand:

| Mode | Evidence | Axes | Verdict |
|---|---|---|---|
| `sweep` | headline + feed summary (≤1200 chars) | fidelity, sensationalism, clickbait | model verdict; MISLEADING is held as **PROVISIONAL** |
| `fulltext` | headline + extracted article (≤8000 chars) | all three | model verdict, may be MISLEADING |
| `tone` | headline only (aggregator or paywalled feed, or an empty summary) | sensationalism, clickbait | none; excluded from fidelity and Framing Integrity |

Escalation: sweep rows flagged PROVISIONAL or CONTESTED get the article body
and a full-text score. The outcome (confirmed / cleared / pending) is the
sweep's precision. A row whose body cannot be fetched records why: `blocked`
(401/402/403/451 or a paywall stub — SOURCE BLOCKED, permanent) vs `timeout`
(transient, retried next run).

Carry-forward: an article stays in the feeds for up to 48 hours. When a prior
run already scored the same row id with the same title, model, and prompt
hash, that score is carried into the new run (`carriedFrom`) and no tokens are
spent. A headline edit, prompt edit, or model change forces a fresh score.

## Methodology v2 statistics (phase 2)

- **Two Framing Integrity definitions**, never merged: strict (VERIFIED only)
  and broad (VERIFIED + CONTEXTUAL). Each is a PROVISIONAL-OUTCOME RANGE
  (pending rows counted bad for the low bound, good for the high) with a
  separate 95% sampling interval from a seeded cluster bootstrap that
  resamples outlets (2000 iterations). UNRESOLVED rows (flagged, article
  never obtained after 4 attempts) are out of both and counted beside them.
- **Outlet identity** is the `outlet` key in `pipeline/config.js`; the three
  Washington Post feeds are one outlet, the two BBC feeds one outlet.
- **Outlet-balanced mean** over outlets with at least 5 text rows in the
  run; the count of qualifying outlets is published.
- **Scorecards** over a rolling 7 days: ranked only at n ≥ 20 rows with text
  and ≥ 3 distinct observation days; below that, progress ("12 of 20 · 2 of
  3 days"). Ranked rates are beta-binomial shrunk toward the pooled rate
  (strength 20) and carry Wilson intervals. Written to `latest.json` as
  `scorecards`.
- **Escalation** of PROVISIONAL, CONTESTED and CONTEXTUAL-with-fidelity ≤ 6
  rows; the full sweep × full-text matrix is stored. Cleared means the full
  text returned VERIFIED or CONTEXTUAL, nothing else; confirmed means the
  same verdict (MISLEADING for PROVISIONAL); anything else is reclassified.
- **Audit sample**: a seeded, stratified sample of sweep VERIFIED and
  CONTEXTUAL rows (10 per run for the first 14 days, then 5) sent to full
  text; overturn rate published; audit rows stay out of the matrix.
- **Slam gap**: within-outlet permutation test, p = (count + 1) /
  (iterations + 1), mean difference with a cluster-bootstrap interval,
  labelled a consistency check.
- **Golden set**: 50 frozen synthetic pairs (`data/golden/set.json`) scored
  in full-text mode every run (`SIGNAL_GOLDEN_EVERY=24` for daily). The first
  scoring run writes `data/golden/baseline.json`, never rewritten; later
  runs report verdict agreement and axis drift against it; agreement below
  90% is an alert.
- **Extraction reliability**: success rate per run and per outlet.
- **`data/stats.csv`**: one row per run of all of the above, frozen columns,
  append-only, keyed by `run_id`. `history.csv` is unchanged; its reserved
  columns are now filled.
- `node scripts/report-daily.js` reports runs, rows, tokens and cost per UTC
  day from `history.csv`.

## Human validation

`npm run validation:build` draws 100 headline + article pairs from the
last 30 days of the ledger, stratified by the model's verdict (PROVISIONAL
pools with MISLEADING), into `data/validation/set.json` (served; no scores)
and `data/validation/model-labels-v<N>.json` (never served). A draw is
frozen; a new draw is a new version. Reviewers label the set blind on the
unlisted `/validate` page: they read the article at the publisher's link,
pick a verdict (or "can't access"), score the three axes, and export
`labels-<reviewer>-v<N>.json`, which is committed to
`data/validation/labels/`. Every scan recomputes
`data/validation/agreement.json`: Cohen's kappa overall and one-vs-rest per
verdict, model vs each reviewer and reviewer vs reviewer, plus mean absolute
axis differences. The method page states "Not yet validated against human
reviewers." until two reviewers have completed the set.

## Numbers in `history.csv`

- `fi_v2_low` / `fi_v2_high`: Framing Integrity v2 over rows with article
  text; PROVISIONAL rows counted bad for the low bound and good for the high.
- `fi_v2_outlet_balanced`: mean of per-outlet rates.
- `fi_v1`: the v1-compatible number, with thin rows counted VERIFIED as the old
  rule did. Computed in parallel for 30 days so the inflation is measurable.
- `mean_integrity_v1` / `mean_integrity_v2`: per-article `100 × (F + (10−S) + (10−C)) / 30`
  and `100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10)`.
- `coverage_pct`: share of scored rows that carry article text.
- Tokens, cost (estimated from the captured price table), feed health,
  escalation counts, slam index.
- Reserved, empty until phase 2 (`DEFECTS.md` v2-5 to v2-8): outlets
  qualifying for the balanced mean and the minimum n, the full
  sweep × full-text escalation matrix, and the audit sample's overturn rate.

## Running

```bash
npm install
npm test                      # 64 tests, no network, no key
node scripts/scan.js --dry-run  # fetch and dedupe feeds, score nothing
ANTHROPIC_API_KEY=… node scripts/scan.js   # a real run; writes data/
```

`--limit N` scores only the first N rows; `--root DIR` writes the ledger
elsewhere (used by tests and dry runs).

The scheduled job needs one repository secret: `ANTHROPIC_API_KEY`. Until it
is set, the hourly job logs a warning and writes nothing.

**Live check.** The `live-check` workflow (Actions → live-check → Run
workflow) runs one full scan on demand. Its job summary carries the run
report: per-feed HTTP status, rows scored vs unscored by reason, tokens, cost,
and one raw model response. The same report is attached as an artifact and
appended to every hourly run's summary.

Google News feeds are fetched one at a time with a short gap (Google
rate-limits parallel requests) and a 429 is retried once after `Retry-After`.
Google News titles have their trailing " - Publisher" removed before scoring
and display. The Guardian is recovered through Google News and scored for tone
only: its site refuses the runner and the Open Platform's free key is for
non-commercial use, so fidelity scoring there would need a commercial key
(`DEFECTS.md` v2-10).

Feed health distinguishes `live`, `stale` (fetched, nothing fresh),
`blocked` (the publisher answered 401/402/403/451 to the runner; listed, never
dropped) and `dead` (any other failure). `feeds_blocked` is a column in
`history.csv`.

## Ledger row shape

```jsonc
{
  "id": "bd77cbffe8a7",            // sha256(canonical link), 12 hex
  "title": "…", "link": "…", "canonical": "…",
  "publication": "Washington Post", "owner": "Jeff Bezos / Nash Holdings",
  "pubDate": "2026-11-23T17:44:00.000Z", "undated": false, "thinBody": false,
  "slam": { "matched": true, "term": "slams", "tier": "core" },
  "sweep":    { "mode": "sweep", "verdict": "PROVISIONAL", "provisional": true, "fidelity": 3, "sens": 7, "click": 4,
                "rationale": "…", "model": "claude-sonnet-5-5", "promptHash": "15da2856e360",
                "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "latencyMs": 0, "at": "…" },
  "sweepError": null,               // or { reason, detail, stage } when UNSCORED
  "fulltext": { "mode": "fulltext", "verdict": "MISLEADING", "chars": 4312, … },
  "fulltextError": null,            // or { reason: "blocked"|"timeout"|"error"|…, detail, stage }
  "escalation": { "eligible": true, "sweepVerdict": "PROVISIONAL", "outcome": "confirmed" },
  "final": { "verdict": "MISLEADING", "fidelity": 2, "sens": 8, "click": 5, "source": "fulltext", "provisional": false },
  "writtenIn": "2026-11-23T17"      // the scan file that holds this row in full
}
```

Article text is never stored, neither the feed snippet nor the extracted
body; the ledger keeps the body's character count only. A test pins this.

## Locked rules

See `CLAUDE.md`. In short: article is the source of record; headline-only
scoring never emits MISLEADING; UNVERIFIABLE label with SOURCE BLOCKED vs
TIMEOUT; deterministic briefing; official YouTube embeds only; keys
server-side only; append-only ledger.

## Credits

NERVA is a decision-integrity framework developed by Starpoint LLC. Headlines
remain © their respective publications.
