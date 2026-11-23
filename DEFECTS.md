# DEFECTS

Every bug found in the old code (`anthony-charts/signal/`, "v1") or in this
code ("v2"), dated, with the fix. Nothing is fixed silently. Newest first
within each section.

Status legend: **fixed** (in this repo, with the phase), **planned** (the
phase that fixes it), **wontfix** (with the reason).

## v2 (this repository)

| # | Found | Where | Defect | Fix |
|---|---|---|---|---|
| v2-1 | 2026-11-23 | `test/aggregate.test.js` | Expected `meanIntegrityV2` of 85; pipeline gave 76.5. The expectation was wrong (the test's own comment already said 76.5). | **fixed** 2026-11-23 — hand calculation below. |
| v2-2 | 2026-11-23 | `test/summarize.test.js` | Expected `avg_fidelity` of 6.25; pipeline gave 6.3. The summary rounds every mean to one decimal; the expectation ignored that. | **fixed** 2026-11-23 — hand calculation below. |
| v2-3 | 2026-11-23 | `test/run.test.js` | `--limit 2` test expected 2 model calls; pipeline made 3. The expectation forgot that one of the two rows is PROVISIONAL and is escalated to a full-text call. | **fixed** 2026-11-23 — hand calculation below. |
| v2-4 | 2026-11-23 | `test/summarize.test.js` | Expected `mean_integrity_v2` of 44.9; pipeline gave 55.6. The expectation was computed over the wrong row set (a tone-only row has no v2 integrity and is excluded). | **fixed** 2026-11-23 — hand calculation below. |

Recorded because a test expectation that is wrong is exactly the bug this file
exists to catch: in each case the pipeline value was verified by hand before
the test was changed.

### Hand calculations for v2-1 … v2-4

Per-article v2 is `100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10)`, rounded to one
decimal. Means are rounded to one decimal (`meanOf`).

**v2-1 — `computeAggregate.meanIntegrityV2`.** Rows with article text after
dedupe: `a` (latest sighting: fidelity 10, sens 2, click 2) and `b` (7, 2, 2).
`v2(10,2,2) = 100 × 1.0 × (1 − 0.05 − 0.05) = 90`.
`v2(7,2,2) = 100 × 0.7 × 0.9 = 63`. Mean `(90 + 63) / 2 = 76.5`. Pipeline: 76.5. ✓

**v2-2 — `summarizeRun.axes.fidelity`.** Scored rows with a fidelity: 8
(VERIFIED), 1 (full-text MISLEADING), 8 (CONTESTED), 8 (carried CONTEXTUAL).
The tone row has no fidelity. `(8 + 1 + 8 + 8) / 4 = 6.25`; one decimal →
`Math.round(62.5) / 10 = 6.3`. Pipeline: 6.3. ✓

**v2-3 — model calls under `--limit 2`.** The first two rows after dedupe are
the budget story (sweep → VERIFIED) and the transit story (sweep → model says
MISLEADING → policy holds it as PROVISIONAL). PROVISIONAL is escalated: the
article fetch succeeds (fixture `article.html`, > 400 chars) and a full-text
call follows. Calls: 2 sweep + 1 full-text = 3. Pipeline: 3. ✓

**v2-4 — `summarizeRun.integrity.meanV2`.** Scored rows with a v2 value:
VERIFIED (8,2,2) → 72; full-text MISLEADING (1,8,6) →
`100 × 0.1 × (1 − 0.2 − 0.15) = 6.5`; CONTESTED (8,2,2) → 72; carried
CONTEXTUAL (8,2,2) → 72. The tone row is null and excluded; the unscored row
is excluded. `(72 + 6.5 + 72 + 72) / 4 = 55.625` → 55.6. Pipeline: 55.6. ✓

## v1 (`anthony-charts/signal/`)

| # | Found | Where | Defect | Fix |
|---|---|---|---|---|
| v1-1 | 2026-11-23 | `api/score.js` | Open, unauthenticated `POST /api/score` proxy. Anyone on the internet could spend the Anthropic key; the per-IP limit lived in instance memory and reset on every cold start. | **fixed** phase 1 — no scoring endpoint exists. Scoring runs only in the scheduled job. (Phase 3 adds a KV-cached, rate-limited article-detail path that scores only on a cache miss.) |
| v1-2 | 2026-11-23 | `api/aggregate.js` | `POST /api/aggregate` accepted unauthenticated, browser-computed snapshots and served them to the anthonycharts generator. Anyone could move the published Info Integrity meter by posting a number. | **fixed** phase 1 — the aggregate is computed from the ledger (`pipeline/aggregate.js`, `data/aggregate.json`). No POST endpoint will exist (phase 3 serves the file). |
| v1-3 | 2026-11-23 | `api/verdicts.js` | `PUT /api/verdicts` accepted unauthenticated verdict writes keyed by a guessable id; a poisoned write was served to every visitor as a "full-text verdict". | **fixed** phase 1 — removed. Full-text verdicts are produced only by the pipeline and stored in the ledger. |
| v1-4 | 2026-11-23 | `lib/prompt.js`, `lib/feeds.js`, `lib/stats.js` | Thin-body rows (Google News aggregation, FT) were scored with a placeholder fidelity of 5 and a default verdict of VERIFIED, then counted in Framing Integrity and in the aggregate's `meanIntegrity`. Roughly a third of rows were "VERIFIED" by rule, not by evidence, inflating the headline number and the anthonycharts meter. | **fixed** phase 1 — tone-only mode (`sensationalism` + `clickbait`, no fidelity, no verdict). Excluded from Framing Integrity v2; coverage % published beside the number. v1 is still computed in parallel (`fi_v1`, `mean_integrity_v1`) so the inflation is measurable for 30 days. |
| v1-5 | 2026-11-23 | `src/config.js` `VERDICT_DEFINITIONS` | Definitions used world-truth language ("factual, sourced, checkable claim", "facts genuinely disputed") that contradicted the prompt's headline-vs-article rule and the README. | **fixed** phase 1 — rewritten in `pipeline/verdicts.js` in headline-vs-article terms. |
| v1-6 | 2026-11-23 | `lib/feeds.js` `dedupeKey` | Deduped by the first 60 characters of the lowercased headline. The same wire headline run by several outlets collapsed into one row attributed to whichever feed came first in the list; two different headlines sharing a 60-char prefix collapsed too; the same article in three WaPo section feeds under slightly different titles was counted three times. | **fixed** phase 1 — dedupe by canonical link (`pipeline/canonical.js`: tracking params, fragment, `www.`, trailing slash stripped). |
| v1-7 | 2026-11-23 | `api/feed.js` `parse()` | Cut each feed to 10 items *before* the freshness gate. A feed listing older items first lost fresh ones (ABC's feed had 17 of 25 items stale in today's dry run). | **fixed** phase 1 — gate, sort newest-first, then cap. |
| v1-8 | 2026-11-23 | `api/feed.js` `decode()` | Entities were decoded before tags were stripped, so a literal `&lt;` in a real headline ("A &lt; B") was eaten as markup. | **fixed** phase 1 — `cleanTitle` strips tags first, then decodes once; summaries keep the double-decode so double-encoded HTML still collapses. |
| v1-9 | 2026-11-23 | `api/score.js` | `temperature: 0` on every request. The current API version rejects `temperature` with a 400; the pinned model (`claude-sonnet-4-6`) and SDK (`^0.32.1`) were a generation behind. | **fixed** phase 1 — Sonnet 5.5, SDK 1.12, schema-constrained output, thinking off (`between_tools`), effort low. |
| v1-10 | 2026-11-23 | `api/score.js`, `api/verdicts.js` | In-memory per-IP rate-limit maps were never evicted; a warm instance grew without bound. | **fixed** phase 1 — no such endpoints. |
| v1-11 | 2026-11-23 | `lib/article.js`, `api/og.js` | Per-article integrity formula duplicated in two files with a "keep in sync" comment; v1 formula had no fidelity gating, so a calm headline that contradicts its article (fidelity 0) scored 67/100. | **fixed** phase 1 — single `pipeline/integrity.js`; v2 formula `100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10)` gates on fidelity. v1 kept in parallel. |
| v1-12 | 2026-11-23 | `api/og.js`, `lib/article.js` share payload | The share URL carried the verdict and scores in a base64 payload that the unfurl page rendered verbatim, so anyone could craft a link that shows an arbitrary verdict for an arbitrary headline on the Signal domain. | **planned** phase 3 — article detail and the OG card read the ledger by row id only; no client-supplied scores. |
| v1-13 | 2026-11-23 | `lib/permutation.js` | Slam permutation test shuffled labels globally (ignoring outlet) and reported `p = count / iterations`, which can be exactly 0. | **planned** phase 2 — permute within outlet; `p = (count + 1) / (iterations + 1)`; report the mean difference with a CI; label it a consistency check. |
| v1-14 | 2026-11-23 | `lib/bootstrap.js` | Bootstrap resampled headlines, not outlets, so the interval ignored that headlines cluster by outlet and was too narrow. | **planned** phase 2 — cluster bootstrap over outlets, seeded, 2000 iterations; Wilson interval for single-outlet rates. |
| v1-15 | 2026-11-23 | `lib/feeds.js` | Feeds were fetched in the browser through the third-party `rss2json.com` (the full feed list sent to a free proxy on every visitor's scan), with a 30-second sleep on its rate limit. | **fixed** phase 1 — server-side fetch in the scheduled job. |
| v1-16 | 2026-11-23 | `components/MethodologyPanel.jsx` | Copy said "20 major US news outlets"; the list had 25 feeds including BBC, Guardian, Sky, and FT. | **planned** phase 3 — methodology copy is generated from `pipeline/config.js`. |
| v1-17 | 2026-11-23 | `App.jsx` `runScan` / `lib/aggregate.js` | The "24h aggregate" was computed from a single browser session's last scan, so it reflected one visitor's run, not the last 24 hours. | **fixed** phase 1 — computed from every run in the ledger window, deduped by row id. |
| v1-18 | 2026-11-23 | `lib/scoring.js`, `lib/escalate.js` | Every visitor's scan re-scored every headline (~130 model calls per page load), and every sweep re-escalated the same flagged rows. | **fixed** phase 1 — one scheduled run per hour; prior scores for the same canonical link, title, model, and prompt hash are carried forward (`carriedFrom`) instead of re-bought. |
