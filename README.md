# Signal v2

**A media-integrity scanner that scores how faithfully a headline represents
its own article, not whether the news is true.**

Owner: Starpoint LLC. Live at anthony-signal.vercel.app (after the phase 4 cutover).

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
