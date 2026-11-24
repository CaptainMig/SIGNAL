// Methodology. Verdict definitions and the feed list come from /api/meta,
// which imports the pipeline's own config, so this page cannot drift from
// the code that scores.
import { esc, fmt, panelHead, pending, verdictColor, verdictLabel } from './ui.js';

function kappaTable(meta, rows, { withAxes = false } = {}) {
  const verdicts = meta.verdicts.model;
  const head = verdicts.map((v) => `<th>${esc(verdictLabel(meta, v))}</th>`).join('');
  const body = rows.map((r) => `<tr><td class="l"><div class="name">${esc(r.label)}</div></td><td>${r.n}</td><td>${r.overall.agreement == null ? '—' : r.overall.agreement + '%'}</td><td>${r.overall.kappa == null ? '—' : r.overall.kappa}</td>${verdicts.map((v) => `<td>${r.perVerdict?.[v] == null ? '—' : r.perVerdict[v]}</td>`).join('')}${withAxes ? `<td>${r.axes?.fidelity ?? '—'} / ${r.axes?.sens ?? '—'} / ${r.axes?.click ?? '—'}</td>` : ''}</tr>`).join('');
  return `<div class="scrollbox"><table class="data" style="min-width:720px"><thead><tr><th class="l">PAIR</th><th>n</th><th>AGREE</th><th>κ OVERALL</th>${head}${withAxes ? '<th>MAD F / S / C</th>' : ''}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function validationSection(data) {
  const v = data.validation;
  const { meta, latest } = data;
  if (!v) {
    return `<p class="gold">Not yet validated against human reviewers.</p><p>A blind labelling set of 100 headline + article pairs drawn from the ledger, stratified by model verdict, is drawn by the operator once the ledger has enough rows in every verdict. Reviewers label it on an unlisted page without seeing any score; labels are committed to the repository; agreement (Cohen's kappa, overall and per verdict) is reported here once at least two reviewers have finished.</p>`;
  }
  const status = v.validated ? `<p class="accent">${esc(v.statement)}</p>` : `<p class="gold">${esc(v.statement)}</p>`;
  const reviewers = v.reviewers.length ? `<p class="muted" style="font-size:13px">Set v${esc(String(v.version))} · ${v.size} pairs · reviewers: ${v.reviewers.map((r) => `${esc(r.reviewer)} (${r.labelled}/${v.size}${r.unavailable ? `, ${r.unavailable} unreachable` : ''}${r.complete ? ', complete' : ''})`).join(', ')} · ${v.complete} of ${v.minReviewers} required complete.</p>` : `<p class="muted" style="font-size:13px">Set v${esc(String(v.version))} · ${v.size} pairs · no reviewer labels committed yet.</p>`;
  const mvh = v.modelVsHuman.filter((m) => m.n > 0);
  const hvh = v.humanVsHuman.filter((h) => h.n > 0);
  return `${status}${reviewers}
    ${mvh.length ? `<p class="mono muted" style="font-size:11px;letter-spacing:.1em">MODEL VS HUMAN · COHEN'S κ (OVERALL AND ONE-VS-REST PER VERDICT) · MEAN ABSOLUTE AXIS DIFFERENCE</p>${kappaTable(meta, mvh.map((m) => ({ label: `model vs ${m.reviewer}`, n: m.n, overall: m.overall, perVerdict: m.perVerdict, axes: m.axes })), { withAxes: true })}` : ''}
    ${hvh.length ? `<p class="mono muted" style="font-size:11px;letter-spacing:.1em">HUMAN VS HUMAN</p>${kappaTable(meta, hvh.map((h) => ({ label: `${h.a} vs ${h.b}`, n: h.n, overall: h.overall, perVerdict: h.perVerdict })))}` : ''}
    <p class="muted" style="font-size:13px">Reviewers judge the headline against the article at the publisher's link; the model judged it against the feed summary or the extracted text, so the evidence is not identical. Items a reviewer could not access are excluded from the comparisons.</p>`;
}

export function renderMethod(data) {
  const { meta, latest } = data;
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
        <li>When the article cannot be fetched, the row says why: SOURCE BLOCKED (the publisher refuses automated retrieval, or serves a server-truncated paywall teaser, a consent wall, or a stub), TIMEOUT (transient, retried on later runs), or NO ARTICLE TEXT (a video page, never fetched). Each fetch tries a chain of routes before giving up: the runner with a full browser header set, a second browser identity, the publisher's own consent acceptance where one exists, the publisher's text rendering where one exists, and a second network route when configured. The route that succeeded is recorded on the row and the success rate by outlet is published in run health.</li>
        <li>A failed scoring call is UNSCORED and excluded from every number. A default is never presented as a score.</li>
      </ul>
      <h2>FRAMING INTEGRITY</h2>
      <p>The share of rows with article text whose headline fairly represents its own article. It is shown as a range while PROVISIONAL rows await full text: counted bad gives the low bound, counted good the high bound. The broad definition counts VERIFIED and CONTEXTUAL; the strict definition counts VERIFIED only and is published alongside once the phase 2 math lands. Rows without article text are excluded and the coverage share is published beside the number. An outlet-balanced version averages per-outlet rates so a high-volume feed cannot dominate.</p>
      <p>Read it as headline fidelity, not trustworthiness. An outlet whose headlines faithfully frame slanted articles still scores high. Signal audits the headline-to-article relationship and leaves the question of whether the article is right to the reader.</p>
      <h2>TWO NUMBERS, NEVER MERGED</h2>
      <p>The <b>provisional-outcome range</b> is not uncertainty: its low bound counts every pending PROVISIONAL row as bad, its high bound counts them as good. The <b>95% sampling interval</b> is uncertainty: a seeded cluster bootstrap that resamples outlets (2000 iterations), because headlines cluster by outlet. Both are shown, labelled, and never combined into one band.</p>
      <h2>UNCERTAINTY AND CHECKS</h2>
      <p>Wilson intervals for single-outlet rates. Scorecards over a rolling 7 days are ranked only at n ≥ 20 rows with text and at least 3 observation days, and are shrunk toward the pooled rate (beta-binomial, 20 pseudo-rows); below the threshold the row shows its progress. The slam gap is tested by permutation within outlet, p = (count + 1)/(iterations + 1), and labelled a consistency check. A frozen 50-headline golden set is scored on a cadence to detect scorer drift against a baseline that is written once. A seeded audit sample of sweep VERIFIED and CONTEXTUAL rows is checked against full text to measure what the sweep misses. Escalation outcomes keep the full sweep × full-text matrix; "cleared" means the full text returned VERIFIED or CONTEXTUAL, nothing else. A row whose article cannot be fetched after four attempts is UNRESOLVED and counted beside the numbers, not inside them.</p>
      <h2>HUMAN VALIDATION</h2>
      ${validationSection(data)}
      <h2>THE SLAM FLAG</h2>
      <p>A deterministic lexicon match, not an AI score. Core verbs: ${meta.slam.core.map(esc).join(', ')}. Watch verbs (often literal, muted badge): ${meta.slam.watch.map(esc).join(', ')}. Literal uses such as "car slams into" and "fire guts building" are suppressed. It never changes a verdict.</p>
      <h2>FEED PACKS</h2>
      ${packsSection(meta)}
      <h2>BYLINES</h2>
      ${bylineSection(latest)}
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

// Packs: what each is, and for every feed outside the national pack, its
// coverage and the robots.txt / terms reason behind it.
export function packsSection(meta) {
  const packs = meta?.packs || [];
  if (!packs.length) return '<p>One pack: national.</p>';
  const feeds = meta?.feeds || [];
  const blocks = packs.map((p) => {
    const own = feeds.filter((f) => (f.pack || 'national') === p.key);
    const metros = p.metros?.length ? `<div class="note">METROS · ${esc(p.metros.join(' · '))}</div>` : '';
    const rows = p.key === 'national' ? '' : `<div class="scrollbox"><table class="data" style="min-width:640px"><thead><tr><th class="l">METRO</th><th class="l">FEED</th><th class="l">COVERAGE</th><th class="l">WHY</th></tr></thead><tbody>${own
      .map((f) => `<tr><td class="l muted">${esc(f.metro || '')}</td><td class="l">${esc(f.name)}</td><td class="l">${esc(String(f.coverage || (f.thinBody ? 'headline-only' : 'full-text')).toUpperCase())}</td><td class="l muted">${esc(f.coverageReason || '')}</td></tr>`)
      .join('')}</tbody></table></div>`;
    return `<p><b>${esc(p.label)}</b> · ${own.length} feed${own.length === 1 ? '' : 's'}. ${esc(p.description || '')}</p>${metros}${rows}`;
  });
  return `<p>Every feed belongs to exactly one pack. Every number on this site is computed from one pack at a time: its own rows, its own history, its own outlets, its own tone map. Nothing is blended across packs. Headline-only feeds are scored for tone only (sensationalism and clickbait), never for fidelity or a verdict, because the publisher's robots.txt or feed terms rule out fetching the article.</p>${blocks.join('')}`;
}

// Byline coverage by outlet, from the latest run's summary. Coverage only:
// no per-author metric is computed or shown anywhere.
export function bylineSection(latest) {
  const b = latest?.summary?.bylines;
  if (!b) return `<p>Byline coverage ${pending('NEXT RUN')}. Every row records the author name(s) the feed gives (dc:creator, author) or the article page's structured data, normalized, with a stable author id per outlet; "none" when absent.</p>`;
  const outlets = Object.entries(b.byOutlet || {}).sort((x, y) => y[1].rows - x[1].rows || (x[0] < y[0] ? -1 : 1));
  const rows = outlets.map(([o, v]) => `<tr><td class="l">${esc(o)}</td><td>${v.withByline}/${v.rows}</td><td>${fmt.pct(v.pct)}</td><td class="muted">${v.fromFeed}</td><td class="muted">${v.fromArticle}</td></tr>`).join('');
  return `<p>Every row records the author name(s) the feed gives (dc:creator, author, Atom author) or, when the article was fetched, the page's structured data, normalized, with a stable author id per outlet. A row with no byline records "none". This run: <b>${b.withByline} of ${b.rows}</b> rows carry a byline (${fmt.pct(b.pct)}), ${b.fromFeed} from the feed and ${b.fromArticle} from the article page. No per-author metric is computed or shown.</p>
    <div class="scrollbox"><table class="data" style="min-width:520px"><thead><tr><th class="l">OUTLET</th><th>WITH BYLINE</th><th>COVERAGE</th><th>FEED</th><th>ARTICLE</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
