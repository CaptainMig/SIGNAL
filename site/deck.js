// The telemetry deck — the home screen. Every panel is computed from the
// ledger in hand (latest.json, history.csv). Anything that phase 2 computes
// server-side (intervals, golden set, audit, rolling 7-day scorecards) is
// marked PENDING, never faked.
import { esc, fmt, pending, pill, verdictColor, verdictLabel, panelHead, kv, groupBy, mean, scoreColor } from './ui.js';

const DAY = 86400e3;

export function renderDeck(data) {
  const { latest } = data;
  if (!latest || !latest.summary || !latest.rows?.length) {
    return `<div class="panel"><div class="empty">No run recorded yet. The first scheduled scan writes the ledger this site reads.</div></div>`;
  }
  return [
    `<section class="row" id="deck">${framingPanel(data)}${runHealthPanel(data)}</section>`,
    `<section class="row">${escalationPanel(data)}${goldenPanel()}${slamPanel(data)}</section>`,
    `<section class="row">${toneMapPanel(data)}${toneByHourPanel(data)}</section>`,
    `<section class="row">${outletsPanel(data)}</section>`,
  ].join('');
}

export function wireDeck(root, data) {
  const toggle = root.querySelector('[data-history-toggle]');
  if (!toggle) return;
  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-window]');
    if (!b) return;
    toggle.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    root.querySelector('#history-chart').innerHTML = historyChart(data, b.dataset.window);
  });
}

// --- Framing Integrity ------------------------------------------------------

function framingPanel(data) {
  const { latest, history } = data;
  const s = latest.summary;
  const fi = s.framingIntegrity;
  const v = s.verdicts;
  const total = Object.values(v).reduce((a, b) => a + b, 0) || 1;
  const order = ['VERIFIED', 'CONTEXTUAL', 'CONTESTED', 'UNVERIFIED', 'PROVISIONAL', 'MISLEADING'];
  const mix = order.map((k) => `<div style="flex:${v[k] || 0} 1 0;background:${verdictColor(data.meta, k)}" title="${esc(verdictLabel(data.meta, k))} ${v[k] || 0}"></div>`).join('');
  const legend = order.map((k) => `<span><span style="color:${verdictColor(data.meta, k)}">■</span> ${esc(verdictLabel(data.meta, k))} ${v[k] || 0}</span>`).join('');
  const pct = order.map((k) => `${verdictLabel(data.meta, k).toLowerCase()} ${Math.round((100 * (v[k] || 0)) / total)}`).join(', ');
  return `<div class="panel wide">
    ${panelHead('FRAMING INTEGRITY · THIS RUN', `BROAD · VERIFIED + CONTEXTUAL`)}
    <div class="hero">
      <div class="big">${fmt.range(fi.v2Low, fi.v2High)}<span class="unit">%</span></div>
      <div class="hero-notes">
        <div>RANGE WHILE <b>${fi.provisionalPending}</b> ROW${fi.provisionalPending === 1 ? '' : 'S'} AWAIT FULL TEXT</div>
        <div>OUTLET-BALANCED <b>${fmt.pct(fi.outletBalanced)}</b> · 95% CI ${pending()}</div>
        <div>n <b>${fi.v2N}</b> WITH ARTICLE TEXT · COVERAGE <b>${fmt.pct(s.coverage)}</b></div>
        <div>STRICT (VERIFIED ONLY) ${pending()} · V1-COMPATIBLE <b>${fmt.pct(fi.v1)}</b></div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="mix" role="img" aria-label="Verdict mix: ${esc(pct)}">${mix}</div>
      <div class="legend">${legend}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div class="subhead"><span>HISTORY · PER-RUN MEAN · LOW–HIGH RANGE AS BAND</span><span class="toggle" data-history-toggle><button data-window="24h">24H</button> · <button data-window="7d">7D</button> · <button data-window="30d" class="active">30D</button></span></div>
      <div id="history-chart">${historyChart(data, '30d')}</div>
    </div>
  </div>`;
}

// Series for the history chart: per run (24h) or per UTC day (7d/30d).
export function historySeries(history, win) {
  const now = Date.now();
  const span = win === '24h' ? DAY : win === '7d' ? 7 * DAY : 30 * DAY;
  const runs = history.filter((r) => r.fi_v2_low != null && Date.parse(r.started_at) >= now - span);
  if (win === '24h') {
    return runs.map((r) => ({ t: r.started_at, low: r.fi_v2_low, high: r.fi_v2_high, mid: (r.fi_v2_low + r.fi_v2_high) / 2, n: 1 }));
  }
  const byDay = groupBy(runs, (r) => String(r.started_at).slice(0, 10));
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rs]) => ({
    t: day,
    low: mean(rs.map((r) => r.fi_v2_low)),
    high: mean(rs.map((r) => r.fi_v2_high)),
    mid: mean(rs.map((r) => (r.fi_v2_low + r.fi_v2_high) / 2)),
    n: rs.length,
  }));
}

function historyChart(data, win) {
  const series = historySeries(data.history, win);
  const W = 600;
  const H = 120;
  const label = (t) => (win === '24h' ? fmt.et(t) : new Date(t + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase());
  if (!series.length) return `<div class="empty">NO RUNS IN THIS WINDOW</div>`;
  const lo = Math.max(0, Math.floor(Math.min(...series.map((p) => p.low)) / 5) * 5 - 5);
  const hi = Math.min(100, Math.ceil(Math.max(...series.map((p) => p.high)) / 5) * 5 + 5);
  const y = (v) => H - ((v - lo) / (hi - lo || 1)) * (H - 10) - 5;
  const x = (i) => (series.length === 1 ? W / 2 : (i / (series.length - 1)) * W);
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" y1="${(H * f).toFixed(1)}" x2="${W}" y2="${(H * f).toFixed(1)}" stroke="rgba(232,228,220,0.14)" stroke-width="0.5"></line>`).join('');
  let body;
  if (series.length === 1) {
    const p = series[0];
    body = `<line x1="${W / 2}" y1="${y(p.high).toFixed(1)}" x2="${W / 2}" y2="${y(p.low).toFixed(1)}" stroke="rgba(90,171,176,0.5)" stroke-width="6"></line><circle cx="${W / 2}" cy="${y(p.mid).toFixed(1)}" r="4" fill="#e8e4dc"></circle>`;
  } else {
    const top = series.map((p, i) => `${x(i).toFixed(1)},${y(p.high).toFixed(1)}`);
    const bottom = series.map((p, i) => `${x(i).toFixed(1)},${y(p.low).toFixed(1)}`).reverse();
    const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.mid).toFixed(1)}`).join(' ');
    const last = series[series.length - 1];
    body = `<polygon fill="rgba(90,171,176,0.18)" points="${top.concat(bottom).join(' ')}"></polygon><polyline fill="none" stroke="#5aabb0" stroke-width="1.5" points="${line}"></polyline><circle cx="${W}" cy="${y(last.mid).toFixed(1)}" r="3" fill="#e8e4dc"></circle>`;
  }
  const first = series[0];
  const midp = series[Math.floor((series.length - 1) / 2)];
  const last = series[series.length - 1];
  const runs = series.reduce((a, p) => a + p.n, 0);
  return `<svg class="chart" role="img" aria-label="Framing Integrity over ${win}, ${series.length} point${series.length === 1 ? '' : 's'} from ${runs} run${runs === 1 ? '' : 's'}, between ${fmt.pct(Math.min(...series.map((p) => p.low)))} and ${fmt.pct(Math.max(...series.map((p) => p.high)))}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:120px">${grid}${body}</svg>
  <div class="axis"><span>${esc(label(first.t))}</span><span>${series.length > 2 ? esc(label(midp.t)) : ''}</span><span>${esc(label(last.t))}${series.length === 1 ? ` · ${runs} RUN` : ''}</span></div>
  <div class="axis"><span>Y ${lo}–${hi}%</span><span>${runs} RUN${runs === 1 ? '' : 'S'} · ${series.length} POINT${series.length === 1 ? '' : 'S'}</span></div>`;
}

// --- Run health -------------------------------------------------------------

function runHealthPanel(data) {
  const { latest } = data;
  const s = latest.summary;
  const f = s.feeds;
  const stat = (v, unit, l) => `<div><div class="v">${v}${unit ? `<span class="unit">${unit}</span>` : ''}</div><div class="l">${l}</div></div>`;
  return `<div class="panel">
    ${panelHead('RUN HEALTH', esc(latest.id || ''))}
    <div class="stat-grid">
      ${stat(f.live, `/${f.total}`, 'FEEDS LIVE')}
      ${stat(s.rows.total, '', 'ROWS AFTER DEDUPE')}
      ${stat(fmt.secs(latest.durationMs), 's', 'RUN DURATION')}
      ${stat(s.rows.unscored, '', 'UNSCORED')}
    </div>
    <div class="kv-list">
      ${kv('FULL TEXT CONFIRMED', s.rows.fulltext)}
      ${kv('SWEEP (FEED SUMMARY)', s.rows.feedSummary)}
      ${kv('HEADLINE ONLY', s.rows.headlineOnly)}
      ${kv('STALE / BLOCKED / DEAD', `<span class="gold">${f.stale}</span> / <span class="gold">${f.blocked ?? 0}</span> / <span class="red">${f.dead}</span>`)}
      ${kv('TOKENS · COST', `${fmt.num(s.usage.input + s.usage.output)} · ${fmt.usd(s.costUsd)}`)}
      ${kv('CACHE READ · CALLS', `${fmt.num(s.usage.cacheRead)} · ${s.usage.calls}`)}
      ${kv('MODEL', esc(latest.model))}
      ${kv('PROMPT HASH', esc(latest.promptHashes?.sweep || '—'))}
    </div>
  </div>`;
}

// --- Escalation -------------------------------------------------------------

function escalationPanel(data) {
  const { latest, history } = data;
  const e = latest.summary.escalation;
  const now = Date.now();
  const week = history.filter((r) => Date.parse(r.started_at) >= now - 7 * DAY);
  const sum = (k) => week.reduce((a, r) => a + (r[k] || 0), 0);
  const c7 = sum('esc_confirmed');
  const cl7 = sum('esc_cleared');
  const decided = c7 + cl7;
  const rows = ['PROVISIONAL', 'CONTESTED'].map((k) => {
    const b = e.bySweep?.[k] || { confirmed: 0, cleared: 0, pending: 0 };
    return `<tr><td class="l" style="color:${verdictColor(data.meta, k)}">${k}</td><td>${b.confirmed}</td><td>${b.cleared}</td><td>${b.pending}</td></tr>`;
  }).join('');
  return `<div class="panel">
    ${panelHead('ESCALATION OUTCOMES · 7D', `${week.length} RUN${week.length === 1 ? '' : 'S'} · TABLE: THIS RUN`)}
    <div class="hero" style="gap:10px"><div class="mid">${decided ? Math.round((100 * c7) / decided) : '—'}<span class="unit">%</span></div><div class="note">SWEEP FLAGS CONFIRMED<br>BY FULL TEXT (${c7} OF ${decided})</div></div>
    <div class="scrollbox"><table class="data">
      <thead><tr><th class="l">SWEEP →</th><th>CONFIRMED</th><th>CLEARED</th><th>PENDING</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="kv-list">
      ${kv('PENDING: BLOCKED / TIMEOUT', `<span class="gold">${e.blocked}</span> / <span class="gold">${e.timeout}</span>`)}
      ${kv('FULL MATRIX · AUDIT OVERTURN RATE', pending())}
    </div>
  </div>`;
}

function goldenPanel() {
  return `<div class="panel">
    ${panelHead('GOLDEN SET · SCORER DRIFT')}
    <div class="hero" style="gap:10px"><div class="mid muted">—<span class="unit">%</span></div><div class="note">VERDICT AGREEMENT VS<br>BASELINE · ${pending()}</div></div>
    <div class="kv-list">
      ${kv('FIDELITY DRIFT', pending())}
      ${kv('SENSATIONALISM DRIFT', pending())}
      ${kv('ALERT BELOW', `<span class="red">90%</span>`)}
    </div>
    <div class="note">A frozen 50-headline set scored every run. Lands with the phase 2 math.</div>
  </div>`;
}

function slamPanel(data) {
  const { latest, history } = data;
  const s = latest.summary.slam;
  const rows = latest.rows.filter((r) => r.final && r.final.sens != null);
  const flagged = rows.filter((r) => r.slam?.matched).map((r) => r.final.sens);
  const rest = rows.filter((r) => !r.slam?.matched).map((r) => r.final.sens);
  const gap = flagged.length && rest.length ? mean(flagged) - mean(rest) : null;
  const trend = history.filter((r) => Date.parse(r.started_at) >= Date.now() - 30 * DAY).map((r) => r.slam_index);
  const W = 300;
  const H = 56;
  const pts = trend.map((v, i) => [v, i]).filter(([v]) => v != null);
  let svg = `<div class="empty">TREND NEEDS 2+ RUNS</div>`;
  if (pts.length >= 2) {
    const hi = Math.max(10, ...pts.map((p) => p[0]));
    const line = pts.map(([v, i]) => `${((i / (trend.length - 1)) * W).toFixed(1)},${(H - 4 - (v / hi) * (H - 8)).toFixed(1)}`).join(' ');
    svg = `<svg class="chart" role="img" aria-label="Slam Index over 30 days, ${pts.length} runs" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:56px"><polyline fill="none" stroke="#e0876a" stroke-width="1.25" points="${line}"></polyline></svg>`;
  }
  return `<div class="panel">
    ${panelHead('SLAM INDEX · CONSISTENCY CHECK')}
    <div class="hero" style="gap:10px"><div class="mid">${fmt.num(s.index, 1)}<span class="unit">%</span></div><div class="note">OF HEADLINES CARRY A<br>SLAM VERB (${s.flagged} OF ${latest.summary.rows.total})</div></div>
    ${svg}
    <div class="kv-list">
      ${kv('SENSATIONALISM GAP · FLAGGED − REST', gap == null ? '—' : `${fmt.signed(gap)} (n ${flagged.length} vs ${rest.length})`)}
      ${kv('PERMUTED WITHIN OUTLET · p', pending())}
      ${kv('READ AS', 'NOT INDEPENDENT EVIDENCE')}
    </div>
  </div>`;
}

// --- Tone -------------------------------------------------------------------

function toneMapPanel(data) {
  const rows = data.latest.rows.filter((r) => r.final && r.final.sens != null && r.final.click != null);
  const dots = rows.map((r, i) => {
    const jx = ((i * 37) % 7) - 3;
    const jy = ((i * 53) % 7) - 3;
    return `<div class="dot" style="left:calc(${(r.final.sens * 9.4 + 2).toFixed(1)}% + ${jx}px);bottom:calc(${(r.final.click * 9.4 + 2).toFixed(1)}% + ${jy}px);background:${verdictColor(data.meta, r.final.verdict)}" title="${esc(r.title)} · ${esc(verdictLabel(data.meta, r.final.verdict))} · S${r.final.sens} C${r.final.click}"></div>`;
  }).join('');
  return `<div class="panel">
    ${panelHead('TONE MAP · SENSATIONALISM × CLICKBAIT', `n ${rows.length}`)}
    <div class="scatter" role="img" aria-label="Scatter of ${rows.length} headlines by sensationalism and clickbait, colored by verdict">${dots}</div>
    <div class="axis"><span>0</span><span>SENSATIONALISM →</span><span>10</span></div>
    <div class="note">VERTICAL AXIS: CLICKBAIT 0–10 · DOT COLOR = VERDICT · GREY = TONE ONLY</div>
  </div>`;
}

function toneByHourPanel(data) {
  const rows = data.latest.rows.filter((r) => r.final && r.final.sens != null && r.pubDate);
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 12 }, () => []));
  for (const r of rows) {
    const d = new Date(r.pubDate);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(d);
    const wd = parts.find((p) => p.type === 'weekday')?.value;
    const hr = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    const dayIdx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
    if (dayIdx === -1 || !Number.isFinite(hr)) continue;
    cells[dayIdx][Math.floor(hr / 2)].push(r.final.sens);
  }
  const means = cells.flat().map((c) => (c.length ? mean(c) : null));
  const vals = means.filter((v) => v != null);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const grid = cells.flatMap((day, di) => day.map((c, hi2) => {
    if (!c.length) return `<div style="background:rgba(232,228,220,0.04)" title="no rows"></div>`;
    const m = mean(c);
    const a = hi > lo ? 0.12 + (0.88 * (m - lo)) / (hi - lo) : 0.5;
    return `<div style="background:rgba(224,135,106,${a.toFixed(2)})" title="${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][di]} ${String(hi2 * 2).padStart(2, '0')}–${String(hi2 * 2 + 2).padStart(2, '0')} ET · mean sens ${m.toFixed(1)} · n ${c.length}"></div>`;
  })).join('');
  return `<div class="panel">
    ${panelHead('TONE BY HOUR · MEAN SENSATIONALISM', `ROWS IN CURRENT VIEW · n ${rows.length}`)}
    <div class="heat" role="img" aria-label="Heatmap of mean sensationalism by weekday and two-hour block for the rows in the current view">${grid}</div>
    <div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24 ET</span></div>
    <div class="heat-legend"><span>CALM</span><span class="sw" style="background:rgba(224,135,106,0.12)"></span><span class="sw" style="background:rgba(224,135,106,0.4)"></span><span class="sw" style="background:rgba(224,135,106,0.7)"></span><span class="sw" style="background:rgba(224,135,106,1)"></span><span>HOT</span><span style="margin-left:auto">ROWS: MON → SUN · 7D VIEW ${pending()}</span></div>
  </div>`;
}

// --- Outlets ----------------------------------------------------------------

export function outletRows(data) {
  const { latest, meta } = data;
  const feedByName = new Map(meta.feeds.map((f) => [f.name, f]));
  const groups = groupBy(latest.rows, (r) => feedByName.get(r.publication)?.outlet || r.outlet || r.publication);
  const out = [];
  for (const [outlet, rows] of groups) {
    const scored = rows.filter((r) => r.final && r.final.source !== 'unscored');
    const text = scored.filter((r) => r.final.verdict != null && r.final.source !== 'tone');
    const good = text.filter((r) => r.final.verdict === 'VERIFIED' || r.final.verdict === 'CONTEXTUAL').length;
    const prov = text.filter((r) => r.final.verdict === 'PROVISIONAL').length;
    const strict = text.filter((r) => r.final.verdict === 'VERIFIED').length;
    out.push({
      outlet,
      owner: rows[0].owner,
      n: rows.length,
      nText: text.length,
      toneOnly: scored.length > 0 && text.length === 0,
      broadLow: text.length ? (100 * good) / text.length : null,
      broadHigh: text.length ? (100 * (good + prov)) / text.length : null,
      strictLow: text.length ? (100 * strict) / text.length : null,
      strictHigh: text.length ? (100 * (strict + prov)) / text.length : null,
      sens: mean(scored.map((r) => r.final.sens)),
      click: mean(scored.map((r) => r.final.click)),
    });
  }
  return out.sort((a, b) => b.n - a.n || a.outlet.localeCompare(b.outlet));
}

export function outletsTable(data, { minN = 20 } = {}) {
  const rows = outletRows(data);
  const tr = rows.map((o) => {
    const name = `<td class="l"><div class="name">${esc(o.outlet)}</div><div class="sub">${esc(o.owner)}${o.toneOnly ? ' · HEADLINE-ONLY FEED' : ''}</div></td>`;
    if (o.toneOnly) return `<tr>${name}<td>${o.n}</td><td colspan="2" class="l muted">NO ARTICLE TEXT · TONE ONLY</td><td>${fmt.num(o.sens, 1)}</td><td class="muted">—</td></tr>`;
    if (o.nText < minN) return `<tr>${name}<td>${o.n}</td><td colspan="2" class="l muted">INSUFFICIENT SAMPLE (n ${o.nText} &lt; ${minN} WITH TEXT)</td><td>${fmt.num(o.sens, 1)}</td><td class="muted">—</td></tr>`;
    const w = Math.max(1, o.broadHigh - o.broadLow);
    return `<tr>${name}<td>${o.n}</td><td>${fmt.range(o.broadLow, o.broadHigh)}%</td><td class="l"><div class="ibar" title="low–high range this run; 95% interval pending"><div class="band" style="left:${o.broadLow.toFixed(1)}%;width:${w.toFixed(1)}%"></div><div class="tick" style="left:${((o.broadLow + o.broadHigh) / 2).toFixed(1)}%"></div></div></td><td>${fmt.num(o.sens, 1)}</td><td>${pending()}</td></tr>`;
  }).join('');
  return `<div class="scrollbox"><table class="data" style="min-width:640px">
    <thead><tr><th class="l">OUTLET</th><th>n</th><th>FRAMING INTEGRITY · BROAD</th><th class="l" style="width:26%">RANGE · 95% INTERVAL ${pending()}</th><th>SENS.</th><th>7D</th></tr></thead>
    <tbody>${tr}</tbody>
  </table></div>`;
}

function outletsPanel(data) {
  return `<div class="panel full" id="outlets">
    ${panelHead('OUTLETS · THIS RUN', `RANKED ONLY AT n ≥ 20 WITH TEXT · ROLLING 7D + SHRINKAGE ${pending()}`)}
    ${outletsTable(data)}
    <div class="note">Outlet identity is the feed label until the phase 2 outlet key lands (the three Washington Post feeds and two BBC feeds appear separately). <a href="/outlets" data-link>Full outlet view →</a></div>
  </div>`;
}
