// Headline table: every row of the current view with its final verdict,
// filterable by verdict and slam flag, sortable, one tap from the article.
import { esc, fmt, pill, scoreColor, unresolvedPill, verdictColor, verdictLabel, panelHead } from './ui.js';

const COLUMNS = [
  { key: 'verdict', label: 'VERDICT', get: (r) => r.final?.verdict ?? (r.final?.source === 'unscored' ? 'zz' : 'z') },
  { key: 'title', label: 'HEADLINE', get: (r) => r.title.toLowerCase() },
  { key: 'publication', label: 'OUTLET', get: (r) => r.publication.toLowerCase() },
  { key: 'fidelity', label: 'FIDELITY', get: (r) => r.final?.fidelity ?? -1 },
  { key: 'sens', label: 'SENS', get: (r) => r.final?.sens ?? -1 },
  { key: 'click', label: 'CLICKBAIT', get: (r) => r.final?.click ?? -1 },
  { key: 'age', label: 'AGE', get: (r) => (r.pubDate ? Date.parse(r.pubDate) : 0) },
];

const ui = { filter: 'ALL', sort: { key: 'age', dir: 'desc' } };

export function renderHeadlines(data) {
  return `<section class="panel full">${panelHead('HEADLINES · CURRENT VIEW', `${data.latest.rows?.length || 0} ROWS · RUN ${esc(data.latest.id || '—')}`)}<div id="hl"></div></section>`;
}

export function wireHeadlines(root, data) {
  const host = root.querySelector('#hl');
  const draw = () => {
    host.innerHTML = table(data);
  };
  host.addEventListener('click', (e) => {
    const f = e.target.closest('button[data-filter]');
    if (f) {
      ui.filter = f.dataset.filter;
      draw();
      return;
    }
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      ui.sort = ui.sort.key === key ? { key, dir: ui.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' || key === 'publication' ? 'asc' : 'desc' };
      draw();
    }
  });
  draw();
}

function table(data) {
  const { latest, meta } = data;
  const rows = latest.rows || [];
  const counts = { ALL: rows.length, SLAM: rows.filter((r) => r.slam?.matched).length, TONE: rows.filter((r) => r.final?.source === 'tone').length, UNSCORED: rows.filter((r) => r.final?.source === 'unscored').length };
  for (const v of meta.verdicts.display) counts[v] = rows.filter((r) => r.final?.verdict === v).length;
  const chips = ['ALL', ...meta.verdicts.display, 'TONE', 'UNSCORED', 'SLAM'].map((f) => {
    const active = ui.filter === f;
    const color = f === 'ALL' ? '#5aabb0' : f === 'SLAM' ? '#f08080' : f === 'TONE' ? '#a39e94' : f === 'UNSCORED' ? '#8d939e' : verdictColor(meta, f);
    const label = f === 'TONE' ? 'TONE ONLY' : f === 'ALL' ? 'ALL' : f === 'SLAM' || f === 'UNSCORED' ? f : verdictLabel(meta, f);
    return `<button data-filter="${f}" style="color:${active ? '#0f0d0a' : color};background:${active ? color : 'transparent'};border-color:${color}66">${esc(label)} ${counts[f] ?? 0}</button>`;
  }).join('');

  let list = rows;
  if (ui.filter === 'SLAM') list = rows.filter((r) => r.slam?.matched);
  else if (ui.filter === 'TONE') list = rows.filter((r) => r.final?.source === 'tone');
  else if (ui.filter === 'UNSCORED') list = rows.filter((r) => r.final?.source === 'unscored');
  else if (ui.filter !== 'ALL') list = rows.filter((r) => r.final?.verdict === ui.filter);
  const col = COLUMNS.find((c) => c.key === ui.sort.key);
  const dir = ui.sort.dir === 'asc' ? 1 : -1;
  list = [...list].sort((a, b) => {
    const av = col.get(a);
    const bv = col.get(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return a.publication.localeCompare(b.publication);
  });

  const head = COLUMNS.map((c) => `<th data-sort="${c.key}" class="sortable ${c.key === 'title' || c.key === 'publication' || c.key === 'verdict' ? 'l' : ''}">${c.label}${ui.sort.key === c.key ? `<span class="accent"> ${ui.sort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</th>`).join('');
  const body = list.map((r) => {
    const f = r.final || {};
    const src = f.source === 'fulltext' ? '<span class="accent" title="full-text verdict">FT</span>' : f.source === 'tone' ? '<span class="muted" title="headline only">T</span>' : '';
    const cell = (v, inv) => (v == null ? '<span class="muted">—</span>' : `<span style="color:${scoreColor(v, inv)}">${v}</span>`);
    const slam = r.slam?.matched ? `<span class="slam-badge ${r.slam.tier}" title="Slam-journalism verb (${r.slam.tier})">SLAM · ${esc(r.slam.term)}</span>` : '';
    const verdict = f.source === 'unscored' ? `<span class="pill" style="color:#8d939e;border-color:#8d939e66">UNSCORED</span>` : f.unresolved ? unresolvedPill(f) : pill(meta, f.verdict);
    return `<tr>
      <td class="l" data-l="VERDICT">${verdict} ${src}</td>
      <td class="l title" data-l=""><a href="/article/${esc(r.id)}" data-link>${esc(r.title)}</a>${slam}</td>
      <td class="l" data-l="OUTLET"><span class="muted">${esc(r.publication)}${r.metro ? ` · ${esc(r.metro)}` : ''}</span></td>
      <td data-l="FIDELITY">${cell(f.fidelity)}</td>
      <td data-l="SENS">${cell(f.sens, true)}</td>
      <td data-l="CLICKBAIT">${cell(f.click, true)}</td>
      <td data-l="AGE"><span class="muted">${r.undated ? 'undated' : fmt.age(r.pubDate)}</span></td>
    </tr>`;
  }).join('');
  return `<div class="filters">${chips}</div>
  <div class="scrollbox"><table class="data hl"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="7" class="empty">NO ROWS</td></tr>`}</tbody></table></div>
  <div class="note">FT = full-text verdict overrides the sweep · T = headline only, tone scored, no verdict · verdicts describe headline-to-article framing, never whether the news is true.</div>`;
}
