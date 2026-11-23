// Outlets view: this run's per-outlet table, grouped by owner beneath.
import { esc, fmt, panelHead, pending, groupBy, mean } from './ui.js';
import { outletRows, outletsTable } from './deck.js';

export function renderOutlets(data) {
  const rows = outletRows(data);
  const byOwner = groupBy(rows, (o) => o.owner);
  const ownerRows = [...byOwner.entries()].map(([owner, outlets]) => {
    const n = outlets.reduce((a, o) => a + o.n, 0);
    const nText = outlets.reduce((a, o) => a + o.nText, 0);
    const good = outlets.reduce((a, o) => a + (o.broadLow == null ? 0 : (o.broadLow / 100) * o.nText), 0);
    const high = outlets.reduce((a, o) => a + (o.broadHigh == null ? 0 : (o.broadHigh / 100) * o.nText), 0);
    const sens = mean(outlets.map((o) => o.sens));
    const fi = nText >= 20 ? `${fmt.range((100 * good) / nText, (100 * high) / nText)}%` : `<span class="muted">INSUFFICIENT SAMPLE (n ${nText} &lt; 20)</span>`;
    return { owner, outlets: outlets.length, n, nText, fi, sens };
  }).sort((a, b) => b.n - a.n);
  return `<section class="panel full">
    ${panelHead('OUTLETS · THIS RUN', `RANKED ONLY AT n ≥ 20 WITH TEXT · 7D ROLLING, SHRINKAGE, WILSON INTERVALS ${pending()}`)}
    ${outletsTable(data)}
  </section>
  <section class="panel full">
    ${panelHead('OWNERS · THIS RUN', 'HEADLINE-WEIGHTED')}
    <div class="scrollbox"><table class="data" style="min-width:520px">
      <thead><tr><th class="l">OWNER</th><th>OUTLETS</th><th>n</th><th>WITH TEXT</th><th>FRAMING INTEGRITY · BROAD</th><th>SENS.</th></tr></thead>
      <tbody>${ownerRows.map((o) => `<tr><td class="l"><div class="name">${esc(o.owner)}</div></td><td>${o.outlets}</td><td>${o.n}</td><td>${o.nText}</td><td>${o.fi}</td><td>${fmt.num(o.sens, 1)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="note">Framing Integrity broad = share of rows with article text rated VERIFIED or CONTEXTUAL, shown as a range while PROVISIONAL rows await full text. The strict definition (VERIFIED only) is published alongside once the phase 2 math lands.</div>
  </section>`;
}
