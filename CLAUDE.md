# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Workflow: every task ends with a merged PR

A fix sitting on a branch is not done. For every task that changes the repo:

1. Develop on a feature branch.
2. Commit and push the branch.
3. Open a pull request into `main`.
4. Merge the pull request.

Do not end a task with work only pushed to a branch. If a task turns out to
require no change (e.g. the requested fix is already merged), report that
instead — never open an empty PR.

## Defects are recorded, never fixed silently

Every bug found — in this code or in the v1 code it replaced — goes in
`DEFECTS.md`, dated, with the fix (or the phase that will fix it). A silent
fix is itself a defect.

## Locked rules

- The article is the source of record. Signal scores headline-to-article
  framing, never whether news is true.
- Headline-only scoring can never emit MISLEADING (sweep MISLEADING is held as
  PROVISIONAL until full text confirms or clears it).
- UNVERIFIED is displayed as UNVERIFIABLE. Full-text failures distinguish
  SOURCE BLOCKED (publisher policy; permanent) from TIMEOUT (transient).
- The briefing is deterministic from aggregates. No AI narrative anywhere.
- Live TV: official YouTube embeds only.
- API keys are server-side only. Scoring runs only in the scheduled job and
  (phase 3) the cached, rate-limited article-detail path. Visitors never
  trigger scoring.
- No content or data from the broadcast company whose name is checked by
  `scripts/check-locked-terms.js`, and the four-letter term that script also
  checks appears nowhere: code, comments, commits, UI, docs, data.
- The ledger is append-only. Scan files are never rewritten; `history.csv`
  rows are never edited; a schema change is a new file, not a migration.

## Repository layout

- `pipeline/` — the scan pipeline (feeds → dedupe → sweep → escalate →
  summarize). Pure modules with injected I/O; `scorer.js` is the only place
  that calls the model.
- `scripts/scan.js` — the scheduled entry point; writes the ledger.
- `data/` — the ledger: `scans/YYYY-MM-DD/HH.json` (deltas: telemetry plus
  rows scored this run; carried rows referenced by `{ id, run }`),
  `history.csv`, `latest.json` (full current view), `aggregate.json`.
  Scan files never contain article text.
- `test/` — `node --test` suites with fixed fixtures; every formula is tested.
- `.github/workflows/scan.yml` — hourly scan; `test.yml` — CI.

## Phases

1. Pipeline + ledger + tests (merged).
2. Math v2 statistics + golden set, plus the review additions (DEFECTS.md
   v2-5 to v2-21), landing as a few merged PRs: pipeline math and ledger,
   then the site panels and mobile tiers, then the human validation set.
3. Telemetry deck + headline table + article detail (merged, ahead of 2).
4. Cutover (authorized 2026-11-24): Open Graph tags and the 1200×630 share
   image `site/og.png` titled "Signal — Media Integrity Scanner" are in,
   with `https://anthony-signal.vercel.app` as the canonical URL; the
   anthonycharts generator already reads that URL's `/api/aggregate`, whose
   shape v2 preserves; the old `anthony-charts/signal/` app is archived
   with a README pointer. The domain move itself (the `anthony-signal`
   Vercel domain from the old project to this repo's project) is an
   operator action in the Vercel dashboard; until it is done the old app
   keeps serving so nothing breaks. The share image is regenerated from the
   design system, never hand-edited: see the `site/og.png` note in README.

## Done after phase 2

- Tone map upgrade (merged): dot size = count at each (sensationalism, clickbait)
  point, colour = dominant verdict, tap to list headlines; a 30-day "TONE
  TRAIL · 30D" of daily centroids fading with age with today's marker
  (never called drift; drift is the golden-set panel's word); markers on
  days the model string or prompt hash changed; a day scrubber; tapping an
  outlet (or a watchlist star) overlays its own 30-day trail for outlets
  with at least 20 rows in the window. The scan job precomputes
  `data/daily.json` (overall and per-outlet centroids and counts, per-mode
  scorer identity, titles for the last 7 days) so the site never loads raw
  scan files for this.
