// Outlets view: rolling 7-day scorecards in both definitions, then this run's
// per-outlet and per-owner tables.
import { esc, fmt, panelHead, groupBy, mean } from './ui.js';
import { scorecardsTable } from './deck.js';
import { mergeStats, latestAndPrevious } from './metrics.js';

export function thisRunRows(data) {
  const { latest, meta } = data;
  const feedByName = new Map(meta.feeds.map((f) => [f.name, f]));
  const groups = groupBy(latest.rows, (r) => r.outlet || feedByName.get(r.publication)?.outlet || r.publication);
  const out = [];
  for (const [outlet, rows] of groups) {
    const scored = rows.filter((r) => r.final && r.final.source !== 'unscored');
    const text = scored.filter((r) => r.final.verdict != null && r.final.source !== 'tone' && !r.escalation?.unresolved);
    const good = text.filter((r) => r.final.verdict === 'VERIFIED' || r.final.verdict === 'CONTEXTUAL').length;
    const strict = text.filter((r) => r.final.verdict === 'VERIFIED').length;
    const prov = text.filter((r) => r.final.verdict === 'PROVISIONAL').length;
    out.push({ outlet, owner: rows[0].owner, n: rows.length, nText: text.length, toneOnly: scored.length > 0 && text.length === 0, broadLow: text.length ? (100 * good) / text.length : null, broadHigh: text.length ? (100 * (good + prov)) / text.length : null, strictLow: text.length ? (100 * strict) / text.length : null, strictHigh: text.length ? (100 * (strict + prov)) / text.length : null, sens: mean(scored.map((r) => r.final.sens)) });
  }
  return out.sort((a, b) => b.n - a.n || a.outlet.localeCompare(b.outlet));
}

export function renderOutlets(data) {
  const merged = mergeStats(data.history, data.stats);
  const lp = latestAndPrevious(merged);
  const ctx = { ...data, merged, latestRow: lp.latest, previousRow: lp.previous };
  const rows = thisRunRows(data);
  const byOwner = groupBy(rows, (o) => o.owner);
  const ownerRows = [...byOwner.entries()].map(([owner, outlets]) => {
    const n = outlets.reduce((a, o) => a + o.n, 0);
    const nText = outlets.reduce((a, o) => a + o.nText, 0);
    const goodB = outlets.reduce((a, o) => a + (o.broadLow == null ? 0 : (o.broadLow / 100) * o.nText), 0);
    const goodS = outlets.reduce((a, o) => a + (o.strictLow == null ? 0 : (o.strictLow / 100) * o.nText), 0);
    return { owner, outlets: outlets.length, n, nText, broad: nText ? (100 * goodB) / nText : null, strict: nText ? (100 * goodS) / nText : null, sens: mean(outlets.map((o) => o.sens)) };
  }).sort((a, b) => b.n - a.n);
  const thisRun = rows.map((o) => {
    const name = `<td class="l"><div class="name">${esc(o.outlet)}</div><div class="sub">${esc(o.owner)}</div></td>`;
    if (o.toneOnly) return `<tr>${name}<td>${o.n}</td><td colspan="2" class="l muted">NO ARTICLE TEXT · TONE ONLY</td><td>${fmt.num(o.sens, 1)}</td></tr>`;
    return `<tr>${name}<td>${o.n}<div class="sub">${o.nText} TEXT</div></td><td>${fmt.range(o.broadLow, o.broadHigh)}%</td><td>${fmt.range(o.strictLow, o.strictHigh)}%</td><td>${fmt.num(o.sens, 1)}</td></tr>`;
  }).join('');
  return `<section class="panel full">
    ${panelHead('OUTLETS · ROLLING 7D · BROAD', `RANKED AT n ≥ ${data.latest.scorecards?.minN ?? 20} WITH TEXT AND ≥ ${data.latest.scorecards?.minDays ?? 3} DAYS`)}
    ${scorecardsTable(ctx, { def: 'broad' })}
  </section>
  <section class="panel full">
    ${panelHead('OUTLETS · ROLLING 7D · STRICT', 'VERIFIED ONLY')}
    ${scorecardsTable(ctx, { def: 'strict' })}
  </section>
  <section class="panel full">
    ${panelHead('THIS RUN · PER OUTLET', 'PROVISIONAL-OUTCOME RANGES · NOT RANKED')}
    <div class="scrollbox"><table class="data" style="min-width:560px">
      <thead><tr><th class="l">OUTLET</th><th>n</th><th>BROAD</th><th>STRICT</th><th>SENS.</th></tr></thead>
      <tbody>${thisRun}</tbody>
    </table></div>
  </section>
  <section class="panel full">
    ${panelHead('THIS RUN · PER OWNER', 'HEADLINE-WEIGHTED · LOW BOUNDS')}
    <div class="scrollbox"><table class="data" style="min-width:520px">
      <thead><tr><th class="l">OWNER</th><th>OUTLETS</th><th>n</th><th>WITH TEXT</th><th>BROAD</th><th>STRICT</th><th>SENS.</th></tr></thead>
      <tbody>${ownerRows.map((o) => `<tr><td class="l"><div class="name">${esc(o.owner)}</div></td><td>${o.outlets}</td><td>${o.n}</td><td>${o.nText}</td><td>${fmt.pct(o.broad)}</td><td>${fmt.pct(o.strict)}</td><td>${fmt.num(o.sens, 1)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="note">Broad = VERIFIED + CONTEXTUAL; strict = VERIFIED only. Both are shares of rows with article text, shown as provisional-outcome ranges while PROVISIONAL rows await full text. Neither is "the" number.</div>
  </section>`;
}
