// Methodology. Verdict definitions and the feed list come from /api/meta,
// which imports the pipeline's own config, so this page cannot drift from
// the code that scores.
import { esc, panelHead, verdictColor, verdictLabel } from './ui.js';

export function renderMethod(data) {
  const { meta } = data;
  const defs = meta.verdicts.display.concat(['UNSCORED']).map((v) => `<div class="def"><span class="sw" style="background:${verdictColor(meta, v) || '#8d939e'}"></span><div><div class="mono" style="font-size:11px;letter-spacing:.08em;color:${verdictColor(meta, v)}">${esc(verdictLabel(meta, v))}</div><div class="muted" style="font-size:14px">${esc(meta.verdicts.definitions[v] || '')}</div></div></div>`).join('');
  const feeds = meta.feeds.map((f) => `<tr><td class="l"><div class="name">${esc(f.name)}</div><div class="sub">${esc(f.owner)}</div></td><td class="l mono muted">${esc(f.host)}</td><td class="l">${f.thinBody ? '<span class="muted">HEADLINE ONLY · TONE</span>' : 'FEED SUMMARY · ESCALATES TO FULL TEXT'}</td></tr>`).join('');
  return `<section class="panel full">
    ${panelHead('METHOD · V2')}
    <div class="prose">
      <h2>THE ONE IDEA THAT MATTERS</h2>
      <p>The article is the source of record. Signal never fact-checks the world. Each headline is scored against the article it links to: a true event the model has never heard of comes back VERIFIED if the headline matches the story; a distorted headline on a real event comes back MISLEADING. Newness is never penalized.</p>
      <h2>HOW A RUN WORKS</h2>
      <p>Every hour a scheduled job fetches ${meta.feeds.length} feeds server-side, keeps the newest ${meta.headlinesPerFeed} items per feed published within ${meta.maxItemAgeHours} hours, dedupes by canonical link, and scores each headline with <span class="mono">${esc(meta.model)}</span> on three axes (fidelity, sensationalism, clickbait, 0–10) and one verdict. Visitors never trigger scoring. Results are appended to a ledger in the repository; this site reads it.</p>
      <p>Three kinds of evidence. <b>Feed summary</b>: the headline plus up to ${meta.bodyChars.sweep} characters of the feed's own summary. <b>Full text</b>: the extracted article, up to ${meta.bodyChars.fulltext} characters, fetched only for rows the sweep flags. <b>Headline only</b>: aggregator or paywalled feeds deliver no usable text, so those rows are scored for tone only and never for fidelity or a verdict.</p>
      <h2>VERDICTS</h2>
      ${defs}
      <h2>POLICY</h2>
      <ul>
        <li>Headline-only scoring can never emit MISLEADING. A sweep MISLEADING is held as PROVISIONAL until the full text confirms or clears it.</li>
        <li>UNVERIFIED is displayed as UNVERIFIABLE: the claim could not be verified from what the article gives.</li>
        <li>When the article cannot be fetched, the row says why: SOURCE BLOCKED (the publisher refuses automated retrieval, or serves a paywall shell) or TIMEOUT (transient, retried).</li>
        <li>A failed scoring call is UNSCORED and excluded from every number. A default is never presented as a score.</li>
      </ul>
      <h2>FRAMING INTEGRITY</h2>
      <p>The share of rows with article text whose headline fairly represents its own article. It is shown as a range while PROVISIONAL rows await full text: counted bad gives the low bound, counted good the high bound. The broad definition counts VERIFIED and CONTEXTUAL; the strict definition counts VERIFIED only and is published alongside once the phase 2 math lands. Rows without article text are excluded and the coverage share is published beside the number. An outlet-balanced version averages per-outlet rates so a high-volume feed cannot dominate.</p>
      <p>Read it as headline fidelity, not trustworthiness. An outlet whose headlines faithfully frame slanted articles still scores high. Signal audits the headline-to-article relationship and leaves the question of whether the article is right to the reader.</p>
      <h2>UNCERTAINTY</h2>
      <p>Phase 2 adds seeded cluster-bootstrap intervals that resample outlets, Wilson intervals for single-outlet rates, beta-binomial shrinkage for scorecards (ranked only at n ≥ 20 over a rolling 7 days), a within-outlet permutation test for the slam gap labelled as a consistency check, a frozen golden set scored every run to detect scorer drift, and a seeded audit sample of sweep VERIFIED and CONTEXTUAL rows checked against full text. Until each lands its panel says PENDING rather than showing a number.</p>
      <h2>THE SLAM FLAG</h2>
      <p>A deterministic lexicon match, not an AI score. Core verbs: ${meta.slam.core.map(esc).join(', ')}. Watch verbs (often literal, muted badge): ${meta.slam.watch.map(esc).join(', ')}. Literal uses such as "car slams into" and "fire guts building" are suppressed. It never changes a verdict.</p>
      <h2>FEEDS</h2>
      <div class="scrollbox"><table class="data" style="min-width:560px"><thead><tr><th class="l">FEED</th><th class="l">HOST</th><th class="l">EVIDENCE</th></tr></thead><tbody>${feeds}</tbody></table></div>
      <h2>WHAT SIGNAL IS NOT</h2>
      <ul>
        <li>Not a fact-checker. VERIFIED ≠ confirmed true.</li>
        <li>Not a forecaster. Every number describes a recorded run.</li>
        <li>Not ground truth. Scoring is fast AI editorial synthesis; use it as a signal.</li>
      </ul>
      <p class="muted" style="font-size:12px">NERVA is a decision-integrity framework developed by Starpoint LLC. Headlines remain © their respective publications. Article text is never stored; the ledger keeps only its length.</p>
    </div>
  </section>`;
}
