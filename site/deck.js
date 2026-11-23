// The telemetry deck — the home screen.
//
// Top tier, always visible: four readouts (Framing Integrity, coverage, run
// health, change since the previous run). Everything else is a collapsible
// section: open on desktop, collapsed on phones (DEFECTS.md v2-20). Live TV
// is always collapsed (off by default).
//
// Two numbers that are never merged (v2-18): the PROVISIONAL-OUTCOME RANGE
// (pending rows counted bad vs good) and the 95% SAMPLING INTERVAL (cluster
// bootstrap over outlets). Anything the ledger does not carry yet renders
// PENDING, never a placeholder number.
import { esc, fmt, pending, verdictColor, verdictLabel, panelHead, kv, groupBy, mean, sparkline } from './ui.js';
import { renderTvSection, wireTv } from './tv.js';
import { renderToneSection, wireTone } from './tone.js';
import { changeSince, historySeries, latestAndPrevious, mergeStats, windowRuns, windowSum } from './metrics.js';

const DAY = 86400e3;
const DEFINITION = 'Share of assessable headlines classified as faithfully framed relative to available article text. Not a measure of factual truth.';

function isDesktop() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(min-width: 640px)').matches;
}

function section(id, title, right, body, { open = isDesktop() } = {}) {
  return `<details class="section" id="${id}"${open ? ' open' : ''}><summary class="panel-head"><span>${title}</span>${right ? `<span>${right}</span>` : ''}</summary><div class="section-body">${body}</div></details>`;
}

export function renderDeck(data) {
  const { latest } = data;
  if (!latest || !latest.summary || !latest.rows?.length) {
    return `<div class="panel"><div class="empty">No run recorded yet. The first scheduled scan writes the ledger this site reads.</div></div>`;
  }
  const merged = mergeStats(data.history, data.stats);
  const lp = latestAndPrevious(merged);
  const ctx = { ...data, merged, latestRow: lp.latest, previousRow: lp.previous };
  return [
    topTier(ctx),
    section('fi-detail', 'FRAMING INTEGRITY · DETAIL', 'VERDICT MIX · HISTORY · BALANCED', framingDetail(ctx)),
    section('run-detail', 'RUN HEALTH · DETAIL', esc(latest.id || ''), runHealthDetail(ctx)),
    renderTvSection(),
    section('escalation', 'ESCALATION & AUDIT', 'SWEEP × FULL TEXT · THIS RUN AND 7D', escalationBody(ctx)),
    `<section class="row">${goldenPanel(ctx)}${slamPanel(ctx)}</section>`,
    section('tone', 'TONE', 'MAP · TRAIL · BY HOUR', `<div class="row">${renderToneSection(ctx)}${toneByHourPanel(ctx)}</div>`),
    section('outlets', 'OUTLETS · ROLLING 7D', `RANKED AT n ≥ ${latest.scorecards?.minN ?? 20} WITH TEXT AND ≥ ${latest.scorecards?.minDays ?? 3} DAYS · SHRUNK TOWARD POOLED RATE`, outletsBody(ctx)),
  ].join('');
}

export function wireDeck(root, data) {
  wireTv(root);
  wireTone(root, data);
  const toggle = root.querySelector('[data-history-toggle]');
  if (toggle) {
    const state = { win: '30d', def: 'broad' };
    const merged = mergeStats(data.history, data.stats);
    toggle.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-window],button[data-def]');
      if (!b) return;
      if (b.dataset.window) state.win = b.dataset.window;
      if (b.dataset.def) state.def = b.dataset.def;
      toggle.querySelectorAll('button[data-window]').forEach((x) => x.classList.toggle('active', x.dataset.window === state.win));
      toggle.querySelectorAll('button[data-def]').forEach((x) => x.classList.toggle('active', x.dataset.def === state.def));
      root.querySelector('#history-chart').innerHTML = historyChart(merged, state.win, state.def);
    });
  }
}

// --- Top tier ---------------------------------------------------------------

function readout(label, value, sub, { color } = {}) {
  return `<div class="readout"><div class="readout-label">${label}</div><div class="readout-value"${color ? ` style="color:${color}"` : ''}>${value}</div><div class="readout-sub">${sub}</div></div>`;
}

function topTier(ctx) {
  const { latest } = ctx;
  const s = latest.summary;
  const fi = s.framingIntegrity;
  const broad = fi.broad;
  const strict = fi.strict;
  const unit = '<span class="unit">%</span>';
  const fiValue = broad ? `${fmt.range(broad.low, broad.high)}${unit}` : `${fmt.range(fi.v2Low, fi.v2High)}${unit}`;
  const fiSub = [
    `<div class="definition">${DEFINITION}</div>`,
    `<div>BROAD · VERIFIED + CONTEXTUAL · <b>PROVISIONAL-OUTCOME RANGE</b> · ${fi.provisionalPending ?? broad?.provisional ?? 0} PENDING</div>`,
    `<div>STRICT · VERIFIED ONLY · ${strict ? `<b>${fmt.range(strict.low, strict.high)}%</b>` : pending()}</div>`,
    `<div>95% SAMPLING INTERVAL · BROAD ${broad?.ci?.lo != null ? `<b>${fmt.range(broad.ci.lo, broad.ci.hi)}%</b>` : pending()} · STRICT ${strict?.ci?.lo != null ? `<b>${fmt.range(strict.ci.lo, strict.ci.hi)}%</b>` : pending()}</div>`,
  ].join('');
  const nText = broad?.n ?? fi.v2N;
  const covSub = `<div><b>${nText}</b> WITH ARTICLE TEXT OF <b>${s.rows.scored}</b> SCORED</div><div>${s.rows.headlineOnly} HEADLINE ONLY · ${s.rows.fulltext} FULL TEXT · ${fi.unresolved ?? 0} UNRESOLVED (COUNTED, NOT SCORED)</div>`;
  const f = s.feeds;
  const healthSub = `<div>${s.rows.total} ROWS · ${s.rows.unscored} UNSCORED · ${fmt.secs(latest.durationMs)} s</div><div>${fmt.usd(s.costUsd)} · ${s.usage.calls} CALLS · ${f.blocked ?? 0} BLOCKED · ${f.dead} DEAD</div>`;
  const ch = changeSince(ctx.latestRow, ctx.previousRow);
  const signed = (v, suffix = ' PT') => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}${suffix}`);
  const changeValue = ch ? (ch.broadMid == null ? '—' : `${ch.broadMid > 0 ? '+' : ''}${ch.broadMid}<span class="unit"> PT</span>`) : 'FIRST<span class="unit"> RUN</span>';
  const changeSub = ch
    ? `<div>BROAD MIDPOINT VS RUN ${esc(ch.previousRunId)}</div><div>STRICT ${signed(ch.strictMid)} · COVERAGE ${signed(ch.coverage)} · ROWS ${signed(ch.rows, '')} · UNSCORED ${signed(ch.unscored, '')}</div>`
    : '<div>NO PREVIOUS RUN IN THE LEDGER</div>';
  return `<section class="tier" id="deck">
    ${readout('FRAMING INTEGRITY · THIS RUN', fiValue, fiSub)}
    ${readout('COVERAGE', `${fmt.pct(s.coverage)}`, covSub)}
    ${readout('RUN HEALTH', `${f.live}<span class="unit">/${f.total} FEEDS</span>`, healthSub, { color: f.live < f.total * 0.75 ? '#c8971f' : undefined })}
    ${readout('CHANGE SINCE PREVIOUS RUN', changeValue, changeSub)}
  </section>`;
}

// --- Framing Integrity detail ----------------------------------------------

function framingDetail(ctx) {
  const { latest, meta, merged } = ctx;
  const s = latest.summary;
  const fi = s.framingIntegrity;
  const v = s.verdicts;
  const order = ['VERIFIED', 'CONTEXTUAL', 'CONTESTED', 'UNVERIFIED', 'PROVISIONAL', 'MISLEADING'];
  const total = Object.values(v).reduce((a, b) => a + b, 0) || 1;
  const mix = order.map((k) => `<div style="flex:${v[k] || 0} 1 0;background:${verdictColor(meta, k)}" title="${esc(verdictLabel(meta, k))} ${v[k] || 0}"></div>`).join('');
  const legend = order.map((k) => `<span><span style="color:${verdictColor(meta, k)}">■</span> ${esc(verdictLabel(meta, k))} ${v[k] || 0}</span>`).join('');
  const pct = order.map((k) => `${verdictLabel(meta, k).toLowerCase()} ${Math.round((100 * (v[k] || 0)) / total)}`).join(', ');
  const bal = (b) => (b?.balanced ? `${fmt.pct(b.balanced.value)} OVER ${b.balanced.qualified} OF ${b.balanced.outlets} OUTLETS (n ≥ ${b.balanced.minN})` : pending());
  return `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="mix" role="img" aria-label="Verdict mix: ${esc(pct)}">${mix}</div>
      <div class="legend">${legend}</div>
    </div>
    <div class="kv-list">
      ${kv('OUTLET-BALANCED · BROAD', bal(fi.broad))}
      ${kv('OUTLET-BALANCED · STRICT', bal(fi.strict))}
      ${kv('V1-COMPATIBLE (THIN ROWS COUNTED VERIFIED)', fmt.pct(fi.v1))}
      ${kv('PER-ARTICLE INTEGRITY · MEAN V2 / V1', `${fmt.num(s.integrity.meanV2, 1)} / ${fmt.num(s.integrity.meanV1, 1)}`)}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div class="subhead"><span>HISTORY · BAND = PROVISIONAL-OUTCOME RANGE · DASHED = 95% SAMPLING INTERVAL</span><span class="toggle" data-history-toggle><button data-def="broad" class="active">BROAD</button> · <button data-def="strict">STRICT</button> &nbsp; <button data-window="24h">24H</button> · <button data-window="7d">7D</button> · <button data-window="30d" class="active">30D</button></span></div>
      <div id="history-chart">${historyChart(merged, '30d', 'broad')}</div>
    </div>`;
}

export function historyChart(merged, win, def) {
  const series = historySeries(merged, win, def);
  const W = 600;
  const H = 120;
  const label = (t) => (win === '24h' ? fmt.et(t) : new Date(t + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase());
  if (!series.length) return `<div class="empty">NO ${def.toUpperCase()} RUNS IN THIS WINDOW${def === 'strict' ? ' · STRICT STARTS WITH THE PHASE 2 LEDGER' : ''}</div>`;
  const allLo = series.flatMap((p) => [p.low, p.ciLo]).filter((x) => x != null);
  const allHi = series.flatMap((p) => [p.high, p.ciHi]).filter((x) => x != null);
  const lo = Math.max(0, Math.floor(Math.min(...allLo) / 5) * 5 - 5);
  const hi = Math.min(100, Math.ceil(Math.max(...allHi) / 5) * 5 + 5);
  const y = (v) => H - ((v - lo) / (hi - lo || 1)) * (H - 10) - 5;
  const x = (i) => (series.length === 1 ? W / 2 : (i / (series.length - 1)) * W);
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" y1="${(H * f).toFixed(1)}" x2="${W}" y2="${(H * f).toFixed(1)}" stroke="rgba(232,228,220,0.14)" stroke-width="0.5"></line>`).join('');
  const hasCi = series.some((p) => p.ciLo != null);
  let body;
  if (series.length === 1) {
    const p = series[0];
    body = `<line x1="${W / 2}" y1="${y(p.high).toFixed(1)}" x2="${W / 2}" y2="${y(p.low).toFixed(1)}" stroke="rgba(90,171,176,0.5)" stroke-width="6"></line>`;
    if (p.ciLo != null) body += `<line x1="${W / 2 - 14}" y1="${y(p.ciLo).toFixed(1)}" x2="${W / 2 + 14}" y2="${y(p.ciLo).toFixed(1)}" stroke="#e8e4dc" stroke-width="1" stroke-dasharray="3 3"></line><line x1="${W / 2 - 14}" y1="${y(p.ciHi).toFixed(1)}" x2="${W / 2 + 14}" y2="${y(p.ciHi).toFixed(1)}" stroke="#e8e4dc" stroke-width="1" stroke-dasharray="3 3"></line>`;
    body += `<circle cx="${W / 2}" cy="${y(p.mid).toFixed(1)}" r="4" fill="#e8e4dc"></circle>`;
  } else {
    const top = series.map((p, i) => `${x(i).toFixed(1)},${y(p.high).toFixed(1)}`);
    const bottom = series.map((p, i) => `${x(i).toFixed(1)},${y(p.low).toFixed(1)}`).reverse();
    const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.mid).toFixed(1)}`).join(' ');
    const last = series[series.length - 1];
    body = `<polygon fill="rgba(90,171,176,0.18)" points="${top.concat(bottom).join(' ')}"></polygon><polyline fill="none" stroke="#5aabb0" stroke-width="1.5" points="${line}"></polyline>`;
    if (hasCi) {
      const ciPts = (k) => series.map((p, i) => (p[k] == null ? null : `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`)).filter(Boolean).join(' ');
      body += `<polyline fill="none" stroke="#e8e4dc" stroke-width="1" stroke-dasharray="3 3" points="${ciPts('ciLo')}"></polyline><polyline fill="none" stroke="#e8e4dc" stroke-width="1" stroke-dasharray="3 3" points="${ciPts('ciHi')}"></polyline>`;
    }
    body += `<circle cx="${W}" cy="${y(last.mid).toFixed(1)}" r="3" fill="#e8e4dc"></circle>`;
  }
  const first = series[0];
  const midp = series[Math.floor((series.length - 1) / 2)];
  const last = series[series.length - 1];
  const runs = series.reduce((a, p) => a + p.n, 0);
  return `<svg class="chart" role="img" aria-label="${def} Framing Integrity over ${win}: ${series.length} point${series.length === 1 ? '' : 's'} from ${runs} run${runs === 1 ? '' : 's'}; band is the provisional-outcome range${hasCi ? ', dashed lines the 95% sampling interval' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:120px">${grid}${body}</svg>
  <div class="axis"><span>${esc(label(first.t))}</span><span>${series.length > 2 ? esc(label(midp.t)) : ''}</span><span>${esc(label(last.t))}</span></div>
  <div class="axis"><span>Y ${lo}–${hi}% · ${def.toUpperCase()}</span><span>${runs} RUN${runs === 1 ? '' : 'S'} · ${series.length} POINT${series.length === 1 ? '' : 'S'}${hasCi ? '' : ' · SAMPLING INTERVAL ' + pending()}</span></div>`;
}

// --- Run health detail ------------------------------------------------------

function runHealthDetail(ctx) {
  const { latest } = ctx;
  const s = latest.summary;
  const f = s.feeds;
  const stat = (v, unit, l) => `<div><div class="v">${v}${unit ? `<span class="unit">${unit}</span>` : ''}</div><div class="l">${l}</div></div>`;
  const ex = s.extraction;
  return `<div class="row">
    <div class="panel" style="border:0;padding:0">
      <div class="stat-grid">
        ${stat(f.live, `/${f.total}`, 'FEEDS LIVE')}
        ${stat(s.rows.total, '', 'ROWS AFTER DEDUPE')}
        ${stat(fmt.secs(latest.durationMs), 's', 'RUN DURATION')}
        ${stat(s.rows.unscored, '', 'UNSCORED')}
      </div>
    </div>
    <div class="panel" style="border:0;padding:0">
      <div class="kv-list">
        ${kv('FULL TEXT CONFIRMED', s.rows.fulltext)}
        ${kv('SWEEP (FEED SUMMARY)', s.rows.feedSummary)}
        ${kv('HEADLINE ONLY', s.rows.headlineOnly)}
        ${kv('STALE / BLOCKED / DEAD', `<span class="gold">${f.stale}</span> / <span class="gold">${f.blocked ?? 0}</span> / <span class="red">${f.dead}</span>`)}
        ${kv('EXTRACTION SUCCESS', ex ? `${ex.successes}/${ex.attempts} · ${fmt.pct(ex.successPct)}` : pending())}
        ${kv('TOKENS · COST', `${fmt.num(s.usage.input + s.usage.output)} · ${fmt.usd(s.costUsd)}`)}
        ${kv('CACHE READ · CALLS', `${fmt.num(s.usage.cacheRead)} · ${s.usage.calls}`)}
        ${kv('MODEL', esc(latest.model))}
        ${kv('PROMPT HASH · SWEEP / FULL TEXT', `${esc(latest.promptHashes?.sweep || '—')} / ${esc(latest.promptHashes?.fulltext || '—')}`)}
      </div>
    </div>
  </div>`;
}

// --- Escalation & audit -----------------------------------------------------

function escalationBody(ctx) {
  const { latest, history, meta } = ctx;
  const e = latest.summary.escalation;
  const a = latest.summary.audit;
  const week = windowRuns(history, 7);
  const c7 = windowSum(history, 'esc_confirmed', 7);
  const cl7 = windowSum(history, 'esc_cleared', 7);
  const decided = c7 + cl7;
  const verdicts = meta.verdicts.model;
  let matrix;
  if (e.matrix) {
    const head = verdicts.map((v) => `<th>${esc(verdictLabel(meta, v))}</th>`).join('');
    const rows = Object.entries(e.matrix).map(([sv, cells]) => `<tr><td class="l" style="color:${verdictColor(meta, sv)}">${sv}${sv === 'CONTEXTUAL' ? ' <span class="muted">F ≤ 6</span>' : ''}</td>${verdicts.map((v) => `<td>${cells[v] ?? 0}</td>`).join('')}<td class="muted">${cells.pending ?? 0}</td><td class="muted">${cells.unresolved ?? 0}</td></tr>`).join('');
    matrix = `<div class="scrollbox"><table class="data" style="min-width:560px"><thead><tr><th class="l">SWEEP → FULL TEXT</th>${head}<th>PENDING</th><th>UNRESOLVED</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } else {
    matrix = `<div class="note">FULL MATRIX ${pending()} · RECORDED FROM THE NEXT RUN</div>`;
  }
  const audit7 = { sampled: windowSum(history, 'audit_sampled', 7), scored: windowSum(history, 'audit_scored', 7), overturned: windowSum(history, 'audit_overturned', 7) };
  return `<div class="row">
    <div class="panel" style="border:0;padding:0">
      <div class="hero" style="gap:10px"><div class="mid">${decided ? Math.round((100 * c7) / decided) : '—'}<span class="unit">%</span></div><div class="note">SWEEP FLAGS CONFIRMED BY<br>FULL TEXT · 7D (${c7} OF ${decided} DECIDED · ${week.length} RUN${week.length === 1 ? '' : 'S'})</div></div>
      <div class="kv-list">
        ${kv('THIS RUN · CONFIRMED / CLEARED / RECLASSIFIED', `${e.confirmed} / ${e.cleared} / ${e.reclassified ?? pending()}`)}
        ${kv('THIS RUN · PENDING / UNRESOLVED', `${e.pending} / ${e.unresolved ?? pending()}`)}
        ${kv('FAILED FETCHES · BLOCKED / TIMEOUT', `<span class="gold">${e.blocked}</span> / <span class="gold">${e.timeout}</span>`)}
        ${kv('CLEARED MEANS', 'FULL TEXT RETURNED VERIFIED OR CONTEXTUAL, NOTHING ELSE')}
      </div>
    </div>
    <div class="panel" style="border:0;padding:0">
      <div class="hero" style="gap:10px"><div class="mid">${a ? fmt.num(a.overturnPct, 0) : '—'}<span class="unit">%</span></div><div class="note">AUDIT OVERTURN RATE · THIS RUN<br>${a ? `${a.overturned} OF ${a.scored} SAMPLED VERIFIED/CONTEXTUAL ROWS LEFT THE INTEGRITY SET` : pending()}</div></div>
      <div class="kv-list">
        ${kv('AUDIT · 7D SAMPLED / SCORED / OVERTURNED', a ? `${audit7.sampled} / ${audit7.scored} / ${audit7.overturned}${audit7.scored ? ` (${Math.round((100 * audit7.overturned) / audit7.scored)}%)` : ''}` : pending())}
        ${kv('AUDIT ROWS IN THIS VIEW · CHANGED VERDICT', a ? `${a.present} · ${a.changed}` : pending())}
        ${kv('READ AS', 'THE SWEEP’S MISS RATE ON ROWS IT DID NOT FLAG')}
      </div>
    </div>
  </div>
  ${matrix}`;
}

// --- Golden set & slam ------------------------------------------------------

function goldenPanel(ctx) {
  const { latest, stats } = ctx;
  const g = latest.summary.golden;
  const trend = (stats || []).filter((r) => Date.parse(r.started_at) >= Date.now() - 30 * DAY).map((r) => r.golden_agreement_pct);
  const spark = trend.filter((v) => v != null).length >= 2 ? sparkline(trend, { w: 300, h: 56, stroke: '#e8e4dc', min: 0, max: 100 }) : '';
  if (!g) {
    return `<div class="panel">
      ${panelHead('GOLDEN SET · SCORER DRIFT')}
      <div class="hero" style="gap:10px"><div class="mid muted">—<span class="unit">%</span></div><div class="note">VERDICT AGREEMENT VS BASELINE<br>${pending()}</div></div>
      <div class="note">A frozen 50-headline set scored every run. Not scored in this run.</div>
    </div>`;
  }
  const agreement = g.agreementPct == null ? (g.scored ? 'BASELINE' : '—') : `${fmt.num(g.agreementPct, 0)}<span class="unit">%</span>`;
  return `<div class="panel">
    ${panelHead('GOLDEN SET · SCORER DRIFT', g.alert ? '<span class="red">ALERT · BELOW 90%</span>' : '')}
    <div class="hero" style="gap:10px"><div class="mid${g.alert ? ' red' : ''}">${agreement}</div><div class="note">VERDICT AGREEMENT VS<br>BASELINE (${g.scored} OF ${g.n} SCORED${g.agreementPct == null && g.scored ? ' · BASELINE WRITTEN THIS RUN' : ''})</div></div>
    ${spark ? `<div style="width:100%">${spark.replace('style="width:300px;height:56px"', 'class="chart" style="height:56px"')}</div>` : ''}
    <div class="kv-list">
      ${kv('FIDELITY DRIFT', g.fidelityDrift == null ? '—' : fmt.signed(g.fidelityDrift))}
      ${kv('SENSATIONALISM DRIFT', g.sensDrift == null ? '—' : fmt.signed(g.sensDrift))}
      ${kv('CLICKBAIT DRIFT', g.clickDrift == null ? '—' : fmt.signed(g.clickDrift))}
      ${kv('VS AUTHORING INTENT', fmt.pct(g.expectedAgreementPct))}
      ${kv('ALERT BELOW', `<span class="red">${g.alertBelowPct ?? 90}%</span>`)}
      ${kv('BASELINE RUN · SAME MODEL / PROMPT', g.baselineRunId ? `${esc(g.baselineRunId)} · ${g.sameModel ? 'YES' : '<span class="gold">NO</span>'} / ${g.samePrompt ? 'YES' : '<span class="gold">NO</span>'}` : '—')}
    </div>
    <div class="note">50 frozen synthetic pairs scored in full-text mode. Drift here is the scorer moving, not the news.</div>
  </div>`;
}

function slamPanel(ctx) {
  const { latest, history } = ctx;
  const s = latest.summary.slam;
  const t = s.test;
  const trend = windowRuns(history, 30).map((r) => r.slam_index);
  const spark = trend.filter((v) => v != null).length >= 2 ? sparkline(trend, { w: 300, h: 56, stroke: '#e0876a', min: 0 }).replace('style="width:300px;height:56px"', 'class="chart" style="height:56px"') : `<div class="empty">TREND NEEDS 2+ RUNS</div>`;
  let gap;
  let p;
  if (!t) {
    gap = pending();
    p = pending();
  } else if (t.underpowered) {
    gap = `UNDERPOWERED · ${t.nFlagged} FLAGGED VS ${t.nRest}`;
    p = 'NOT TESTED (FEWER THAN 5 IN A GROUP)';
  } else {
    gap = `${fmt.signed(t.observedDiff)} (95% ${fmt.range(t.ci.lo, t.ci.hi, 1)}) · n ${t.nFlagged} VS ${t.nRest}`;
    p = `p = ${t.p} · ${t.iterations} PERMUTATIONS WITHIN ${t.outlets} OUTLETS`;
  }
  return `<div class="panel">
    ${panelHead('SLAM INDEX · CONSISTENCY CHECK')}
    <div class="hero" style="gap:10px"><div class="mid">${fmt.num(s.index, 1)}<span class="unit">%</span></div><div class="note">OF HEADLINES CARRY A<br>SLAM VERB (${s.flagged} OF ${latest.summary.rows.total})</div></div>
    ${spark}
    <div class="kv-list">
      ${kv('SENSATIONALISM GAP · FLAGGED − REST', gap)}
      ${kv('PERMUTED WITHIN OUTLET', p)}
      ${kv('READ AS', 'A CONSISTENCY CHECK, NOT INDEPENDENT EVIDENCE')}
    </div>
  </div>`;
}

// --- Tone -------------------------------------------------------------------

function toneByHourPanel(ctx) {
  const rows = ctx.latest.rows.filter((r) => r.final && r.final.sens != null && r.pubDate);
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 12 }, () => []));
  for (const r of rows) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(r.pubDate));
    const wd = parts.find((p) => p.type === 'weekday')?.value;
    const hr = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    const dayIdx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
    if (dayIdx === -1 || !Number.isFinite(hr)) continue;
    cells[dayIdx][Math.floor(hr / 2)].push(r.final.sens);
  }
  const vals = cells.flat().filter((c) => c.length).map((c) => mean(c));
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const grid = cells.flatMap((day, di) => day.map((c, b) => {
    if (!c.length) return `<div style="background:rgba(232,228,220,0.04)" title="no rows"></div>`;
    const m = mean(c);
    const a = hi > lo ? 0.12 + (0.88 * (m - lo)) / (hi - lo) : 0.5;
    return `<div style="background:rgba(224,135,106,${a.toFixed(2)})" title="${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][di]} ${String(b * 2).padStart(2, '0')}–${String(b * 2 + 2).padStart(2, '0')} ET · mean sens ${m.toFixed(1)} · n ${c.length}"></div>`;
  })).join('');
  return `<div class="panel" style="border:0;padding:0">
    ${panelHead('TONE BY HOUR · MEAN SENSATIONALISM', `ROWS IN CURRENT VIEW · n ${rows.length}`)}
    <div class="heat" role="img" aria-label="Heatmap of mean sensationalism by weekday and two-hour block for the rows in the current view">${grid}</div>
    <div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24 ET</span></div>
    <div class="heat-legend"><span>CALM</span><span class="sw" style="background:rgba(224,135,106,0.12)"></span><span class="sw" style="background:rgba(224,135,106,0.4)"></span><span class="sw" style="background:rgba(224,135,106,0.7)"></span><span class="sw" style="background:rgba(224,135,106,1)"></span><span>HOT</span><span style="margin-left:auto">ROWS: MON → SUN</span></div>
  </div>`;
}

// --- Outlets (rolling 7d scorecards) ---------------------------------------

// Per-outlet 7-day sensationalism series from daily.json.
function outletSpark(daily, outlet) {
  const days = (daily?.days || []).slice(-7);
  const vals = days.map((d) => d.outlets?.[outlet]?.sens ?? null);
  return vals.filter((v) => v != null).length >= 2 ? sparkline(vals, { stroke: '#e0876a', min: 0, max: 10 }) : '<span class="muted">—</span>';
}

export function scorecardsTable(ctx, { def = 'broad' } = {}) {
  const sc = ctx.latest.scorecards;
  if (!sc) return `<div class="note">ROLLING 7-DAY SCORECARDS ${pending()} · WRITTEN FROM THE NEXT RUN</div>`;
  const tr = sc.cards.map((c) => {
    const name = `<td class="l"><div class="name">${esc(c.outlet)}</div><div class="sub">${esc(c.owner)}${c.toneOnly ? ' · HEADLINE-ONLY FEED' : ''}${c.publications.length > 1 ? ` · ${c.publications.length} FEEDS` : ''}</div></td>`;
    const spark = `<td>${outletSpark(ctx.daily, c.outlet)}</td>`;
    if (c.toneOnly) return `<tr>${name}<td>${c.n}</td><td colspan="3" class="l muted">NO ARTICLE TEXT · TONE ONLY</td><td>${fmt.num(c.sens, 1)}</td>${spark}</tr>`;
    if (!c.ranked) return `<tr>${name}<td>${c.n}</td><td colspan="3" class="l muted">NOT YET RANKED · ${esc(c.progress)}</td><td>${fmt.num(c.sens, 1)}</td>${spark}</tr>`;
    const d = c[def];
    const w = Math.max(0.5, d.wilsonHigh.hi - d.wilsonLow.lo);
    return `<tr>${name}<td>${c.n}<div class="sub">${c.nText} TEXT · ${c.days} D</div></td><td>${fmt.range(d.low, d.high)}%<div class="sub">RANGE</div></td><td>${fmt.range(d.shrunkLow, d.shrunkHigh)}%<div class="sub">SHRUNK</div></td><td class="l"><div class="ibar" title="Wilson 95% interval from ${d.wilsonLow.lo}% to ${d.wilsonHigh.hi}%"><div class="band" style="left:${d.wilsonLow.lo.toFixed(1)}%;width:${w.toFixed(1)}%"></div><div class="tick" style="left:${((d.low + d.high) / 2).toFixed(1)}%"></div></div></td><td>${fmt.num(c.sens, 1)}</td>${spark}</tr>`;
  }).join('');
  return `<div class="scrollbox"><table class="data" style="min-width:760px">
    <thead><tr><th class="l">OUTLET</th><th>n · 7D</th><th>FRAMING INTEGRITY · ${def.toUpperCase()}</th><th>SHRUNK</th><th class="l" style="width:22%">WILSON 95%</th><th>SENS.</th><th>SENS 7D</th></tr></thead>
    <tbody>${tr}</tbody>
  </table></div>
  <div class="note">${sc.ranked} OF ${sc.cards.length} OUTLETS RANKED · ${sc.rows} UNIQUE ROWS OVER ${sc.runs} RUNS · POOLED ${def.toUpperCase()} ${fmt.range(sc.pooled[def].low, sc.pooled[def].high)}% · SHRINKAGE STRENGTH ${sc.strength} PSEUDO-ROWS</div>`;
}

function outletsBody(ctx) {
  return `${scorecardsTable(ctx, { def: 'broad' })}<div class="note"><a href="/outlets" data-link>Strict definition, owners and this-run table →</a></div>`;
}
