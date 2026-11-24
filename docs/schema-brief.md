# Schema brief: ledger row v2 and the proposed additions

Status: approved 2026-11-24 with two changes (the current view is no longer
committed, starting now; a limits section), and implemented in the same
pull request. No public metric is derived from any of it yet: the
fingerprint and the timestamps are stored, not shown.

## Baseline: the row today

Every scan file (`data/scans/YYYY-MM-DD/HH.json`) holds run telemetry plus
the rows produced in that run; unchanged rows are references
`{ id, run }`. `latest.json` is the full current view, one per pack. Scan
files never contain article text. Today's row:

| Field | What it is |
|---|---|
| `id` | `sha256(canonical link)[0..12]` |
| `title`, `link`, `canonical`, `publication`, `outlet`, `owner` | from the feed and its config |
| `pack`, `metro` | the feed's pack and metro (nothing is blended across packs) |
| `pubDate`, `undated` | the publisher's timestamp as the feed gave it (ISO) or null |
| `thinBody` | headline-only feed |
| `slam` | lexicon match |
| `byline` | `{ source: feed/article/none, text, authors: [{ name, id }] }` |
| `sweep`, `fulltext` | score records: mode, verdict, scores, rationale, model, prompt hash, usage, latency, `carriedFrom` |
| `sweepError`, `fulltextError` | reason, detail, stage, attempts |
| `escalation` | eligibility, reason, outcome, unresolved, attempts |
| `extraction` | route, tried, fetches, ms, source |
| `audit`, `auditSampledIn`, `auditOutcome` | audit sample bookkeeping |
| `final` | the row's verdict and scores as displayed |
| `writtenIn` | the scan file that holds the full record |

Measured on the 20:10 UTC run of 2026-11-23: a full row is about 1.6 KB of
JSON, a carried reference 44 bytes, run telemetry 16 KB per pack.

## 1. Text fingerprint, never the text

Purpose: later similarity and origin tracing (the same wire story across
outlets, a headline rewritten over an unchanged article) without keeping any
publisher content.

Proposal: a MinHash signature, not an embedding. MinHash is deterministic,
costs no model call, needs no provider, cannot be inverted to text, and
estimates Jaccard similarity directly. An embedding would add a model call
per row (cost and a provider dependency), and is not required for the two
uses named.

- Input text: the article text already in memory at escalation (full text),
  else the feed summary already in memory at the sweep, else the headline.
  Recorded as `fp.source`: `fulltext`, `summary` or `title`.
- Normalization, versioned as `fp.v`: Unicode NFKC, lower case, punctuation
  to spaces, whitespace collapsed, digits kept. Tokens are words.
- Shingles: word 5-grams for full text and summaries; word 2-grams for a
  headline-only fingerprint, which is always computed (`fp.title`), so thin
  rows and blocked rows still carry one.
- Signature: 128 hash functions, each `xxhash32(shingle, seed_i)` with 128
  fixed seeds, minimum per seed, stored as 128 × 32-bit values base64url
  encoded: 688 characters. Jaccard estimate standard error at 128
  permutations is about 0.09; at 64 it would be 0.125 and 344 characters.
  128 is proposed for the text signature and 64 for the headline one.
- Also stored: `fp.shingles` (count) and `fp.chars` (normalized length), so
  a comparison can refuse to compare a 300-character teaser with a
  5,000-character article.
- Comparison is a later feature, offline over the ledger. The brief commits
  only to what is stored.

Row addition, as implemented (`pipeline/fingerprint.js`):

```
fp: { v: 1, source: 'fulltext' | 'summary' | 'title',
      text: '<683 chars>' | null, title: '<342 chars>' | null,
      shingles: 812, chars: 5210 }
```

The hash is xxHash32 of each shingle; the 128 (text) or 64 (headline)
permutations are affine maps mod 2^32 with constants fixed by the version;
signatures are base64url of the little-endian 32-bit minima (683 and 342
characters, not the 688 and 344 first estimated). The article fingerprint
travels with a carried full-text score; a sweep row's fingerprint is of the
feed summary and is recomputed when the row is re-swept.

Why this is not publisher content: a MinHash value is the minimum of a hash
over a set of shingles; it carries no ordering and no recoverable words.
Two documents with the same fingerprint are near-duplicates, which is the
whole point.

### Limits of the fingerprint

- MinHash detects verbatim and near-verbatim reuse: syndicated wire copy,
  a story republished with light edits, a headline rewritten over an
  unchanged article. Jaccard over word 5-shingles falls quickly as wording
  changes.
- It does not detect paraphrase. Two articles that report the same facts
  in different words score near zero.
- Therefore low similarity is never evidence of original reporting, and is
  never to be presented as such. A low score means only that the words
  differ.
- A semantic layer (embeddings, which would detect paraphrase at the cost
  of a model call per row and a provider dependency) is a later, separate
  decision, not implied by this one.
- No public metric is derived from the fingerprint yet. Any similarity or
  origin figure shown on the site is a separate proposal with its own
  review.

## 2. Two timestamps, and what hourly scans can and cannot order

Today a row carries only the publisher's `pubDate`. Proposal:

- `pubDate` stays: the publisher's own timestamp as the feed gave it, or
  null. On Google News feeds it is Google's indexing time, not the
  publisher's; this is recorded per feed (`timestampSource: 'feed' |
  'aggregator'`) so the two are never compared as equals.
- `firstSeen`: the `startedAt` of the run that first observed the row id,
  ISO; `firstSeenRun`: that run's id. Carried forward unchanged for the life
  of the row. Not editable by the publisher. Rows first written before this
  field existed take the hour of the run they were last written in, which
  is the earliest the ledger can vouch for.
- `timestampSource`: `feed` when `pubDate` is the publisher's own, or
  `aggregator` on Google News feeds, where the stamp is Google's.
- `pubDateChanged`: true when a later sighting of the same id carries a
  different `pubDate` than the first (publishers backdate and re-stamp);
  the first value is kept as `pubDateFirst` when it changes.

Resolution: scans are hourly, so `firstSeen` is quantized to the hour. Two
articles first observed in the same run tie at one-hour resolution, and
nothing in the ledger can say which was published first within that hour
except the publishers' own stamps.

Tie handling, in order:

1. Within one run, order by `pubDate` when both rows have a parseable
   timestamp from the publisher's own feed (not an aggregator), the stamps
   differ, both fall within the item-age window (48 hours) and neither is
   more than ten minutes in the future at observation. Publisher stamps are
   evidence, not proof: the display says "by publisher timestamp".
2. Otherwise the tie stands and is recorded: `originOrder: 'tie'` on both
   rows' comparison record. A tie is never broken by feed order, feed
   position, outlet name or row id.
3. The external trigger and the GitHub cron can both fire in one hour; the
   scan's minimum-gap guard makes the second a no-op, so the resolution does
   not improve by accident and ordering never depends on which trigger won.

If finer ordering ever matters, the honest fix is a shorter scan interval
for feeds only (no scoring), recording `firstSeen` at that cadence; that is
a scheduling change, not a schema change, and is out of scope here.

## 3. No new page fetches

The fingerprint is computed from text the pipeline already holds in memory:
the feed summary during the sweep and the article text during escalation,
both discarded afterwards exactly as today. `firstSeen` is the run clock.
`pubDateChanged` compares two feed values already read. No row is fetched
for the sake of a fingerprint or a timestamp; a row that is never fetched
gets `fp.source: 'summary'` or `'title'` and says so.

## 4. Ledger growth and the point where the repo stops being a database

Measured today (one pack, two runs): full row 1.6 KB, carried reference
44 bytes, telemetry 16 KB per pack per run, `latest.json` 372 KB for
221 rows, `daily.json` 50 KB.

Assumptions for the projection: hourly runs; two packs; 50 to 100 fresh
rows per run in total (national plus regional; the first regional runs will
be above this while the 48-hour window fills); 350 to 450 rows in the
current view; the additions in sections 1 and 2 add about 1.1 KB to a full
row (text signature 688, headline signature 344, timestamps and flags
under 100), so a full row becomes about 2.7 KB.

Per hourly scan file: 50 to 100 rows × 2.7 KB plus 400 references × 44 B
plus two packs' telemetry, about 32 KB, gives 185 to 320 KB. Per month
(720 runs): 130 to 230 MB of JSON in the working tree, 25 to 45 MB in git
after compression (JSON compresses 5 to 8 times).

The larger cost is not the scans. `latest.json` is rewritten every run for
every pack, and git stores a delta of each rewrite; with 350 to 450 rows at
2.7 KB that is 0.9 to 1.2 MB per pack per run, two packs, and a delta of
roughly a quarter of the file after compression: 100 to 160 MB of git
history per month. `daily.json` and the CSVs are negligible.

Total: 125 to 205 MB of repository growth per month at today's cadence.

Where it stops being sensible:

- GitHub recommends repositories under 1 GB and warns from 5 GB. At the
  projected rate the ledger crosses 1 GB in 5 to 8 months and 5 GB in
  about 2 to 3 years. Clone time on the Actions runner (`fetch-depth: 1`
  today) stays fine until the pack is large, but every hourly push carries
  the growing history.
- `latest.json` served through `raw.githubusercontent.com` is fine to a few
  MB; at 2.7 KB per row it reaches 1 MB at about 370 rows, which the second
  pack brings. Beyond about 5 MB the deck's first paint waits on it.
- The directory of scan files (720 per month) is not itself a problem: the
  scan reads only the files inside its window.

Decisions, in order:

1. Done now (operator decision, this PR): the per-pack `latest.json` is no
   longer committed. The scan job writes `data/pointer.json` (about 3 KB,
   the latest scan file and the file for every run in the 48-hour window)
   and carries each pack's scorecards and metro cards inside the scan file
   as `views`. `/api/data?file=latest` assembles the current view from the
   latest scan plus the scans its carried references name, keeps it in the
   function instance while the pointer is unchanged, and serves it with a
   five-minute edge cache (`s-maxage=300, stale-while-revalidate=3600`).
   That removes the largest growth term above (100 to 160 MB a month) and
   keeps the append-only guarantee: only deltas are committed. Expected
   growth is now 25 to 45 MB a month, so the 1 GB mark moves out to roughly
   two years.
2. At about 1 GB, or when a clone takes longer than a minute: move `data/scans/` to a
   separate ledger repository under the same append-only rules, with this
   repository keeping `history.csv`, `stats.csv`, `daily.json` and the
   aggregates. A month's scans can equally be published as one release
   asset per month; both keep every row reachable by `{ id, run }`.
3. If similarity queries over the fingerprints become routine, index them
   outside git (a monthly Parquet or SQLite build from the scans, generated
   by the scan job), never by rewriting the scans.

A repository is a sensible database for this ledger while the whole history
clones in under a minute and the current view assembles in under a second:
with step 1 in place, roughly the first two years on the numbers above.
