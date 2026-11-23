// Article detail: one ledger row, read by id. Nothing is scored on demand
// here; the row shows exactly what the scheduled run recorded, including why
// a full-text verdict could not be earned.
import { esc, fmt, pill, scoreColor, verdictLabel, panelHead, kv, pending } from './ui.js';

function v1(score, thin) {
  if (!score || score.sens == null || score.click == null) return null;
  const f = score.fidelity == null ? (thin ? 5 : null) : score.fidelity;
  if (f == null) return null;
  return Math.round((100 * (f + (10 - score.sens) + (10 - score.click))) / 30);
}
function v2(score) {
  if (!score || score.fidelity == null || score.sens == null || score.click == null) return null;
  return Math.round(100 * (score.fidelity / 10) * (1 - 0.25 * (score.sens / 10) - 0.25 * (score.click / 10)) * 10) / 10;
}

function axis(label, value, invert) {
  const c = scoreColor(value, invert);
  return `<div class="axis-row"><span class="muted">${label}</span><div class="bar"><div style="width:${value == null ? 0 : value * 10}%;background:${c}"></div></div><span style="color:${c}">${value == null ? '—' : value}</span></div>`;
}

export function renderArticle(data, id) {
  const { latest, meta } = data;
  const row = (latest.rows || []).find((r) => r.id === id);
  if (!row) {
    return `<section class="panel"><a class="back" href="/headlines" data-link>← HEADLINES</a><div class="empty">Article ${esc(id)} is not in the current view. The ledger keeps every run, but this site reads only the latest.</div></section>`;
  }
  const f = row.final || {};
  const sourceLabel =
    f.source === 'fulltext' ? 'FULL-TEXT VERDICT' : f.source === 'tone' ? 'HEADLINE ONLY · TONE SCORED · NO VERDICT' : f.source === 'unscored' ? `UNSCORED · ${esc(f.reason || '')}` : 'SWEEP VERDICT · HEADLINE + FEED SUMMARY';
  const fe = row.fulltextError;
  let fulltextState = '';
  if (row.fulltext) {
    fulltextState = `<div class="kv-list">${kv('SCORED AGAINST', `${fmt.num(row.fulltext.chars)} EXTRACTED CHARACTERS`)}${kv('SWEEP SAID', row.sweep ? esc(verdictLabel(meta, row.sweep.verdict)) : '—')}${kv('ESCALATION', esc(String(row.escalation?.outcome || '—').toUpperCase()))}${row.fulltext.carriedFrom ? kv('CARRIED FROM RUN', esc(row.fulltext.carriedFrom)) : ''}</div>`;
  } else if (fe) {
    const label = fe.reason === 'blocked' ? `UNVERIFIABLE — SOURCE BLOCKED (${esc(fe.detail === 'stub' ? 'paywall or consent wall' : fe.detail)})` : fe.reason === 'timeout' ? 'FULL TEXT UNAVAILABLE — TIMEOUT (retried next run)' : `FULL TEXT UNAVAILABLE — ${esc(fe.reason)} ${esc(fe.detail || '')}`;
    fulltextState = `<div class="note gold">${label}</div><div class="note">${fe.reason === 'blocked' ? 'The publisher refuses automated retrieval, so this row cannot earn a full-text verdict. A property of the source, not a judgment on the outlet or the story.' : 'A transient failure. The next scheduled run tries again.'}</div>`;
  } else if (row.escalation?.eligible) {
    fulltextState = `<div class="note">Flagged by the sweep; the full-text check is ${esc(row.escalation.outcome || 'pending')}.</div>`;
  } else if (f.source === 'tone') {
    fulltextState = `<div class="note">This feed delivers no article text, so fidelity and the verdict are not scored. Only the two tone axes are.</div>`;
  } else {
    fulltextState = `<div class="note">Not flagged by the sweep, so not escalated. On-demand full-text scoring ${pending('PHASE 2')}.</div>`;
  }
  return `<section class="panel full article">
    <a class="back" href="/headlines" data-link>← HEADLINES</a>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">${f.source === 'unscored' ? `<span class="pill" style="color:#8d939e;border-color:#8d939e66">UNSCORED</span>` : pill(meta, f.verdict)}<span class="mono muted" style="font-size:11px;letter-spacing:.1em">${sourceLabel}</span></div>
    <h1>${esc(row.title)}</h1>
    <div class="mono muted" style="font-size:11px">${esc(row.publication)} · ${esc(row.owner)} · ${row.undated ? 'undated' : `${fmt.age(row.pubDate)} ago`} · <a href="${esc(row.link)}" target="_blank" rel="noopener noreferrer">original article ↗</a></div>
    <div class="axes">${axis('FIDELITY', f.fidelity)}${axis('SENSATIONALISM', f.sens, true)}${axis('CLICKBAIT', f.click, true)}</div>
    ${f.rationale ? `<div class="rationale">${esc(f.rationale)}</div>` : ''}
    ${panelHead('FULL TEXT')}
    ${fulltextState}
    ${panelHead('PER-ARTICLE INTEGRITY')}
    <div class="kv-list">
      ${kv('V2 · 100 × F/10 × (1 − 0.25·S/10 − 0.25·C/10)', v2(f) == null ? '—' : fmt.num(v2(f), 1))}
      ${kv('V1 · 100 × (F + (10−S) + (10−C)) / 30', v1(f, row.thinBody) == null ? '—' : v1(f, row.thinBody))}
      ${kv('SLAM', row.slam?.matched ? `<span class="red">${esc(row.slam.term)} · ${esc(row.slam.tier)}</span>` : 'no slam verb')}
      ${kv('MODEL · PROMPT', `${esc((row.fulltext || row.sweep)?.model || '—')} · ${esc((row.fulltext || row.sweep)?.promptHash || '—')}`)}
      ${kv('SCORED AT', esc((row.fulltext || row.sweep)?.at || '—'))}
      ${kv('ROW ID', esc(row.id))}
    </div>
    <div class="note">Signal scores the headline against the article it links to. A VERIFIED verdict means the headline matches its article, not that the article is true.</div>
  </section>`;
}
