// Blind labelling page — unlisted route /validate. Serves the validation set
// (headline, outlet, link; NO model scores), collects a verdict and three axis
// scores per item, keeps progress on this device, and exports a labels file
// for the repository. Nothing is posted anywhere.
import { esc, panelHead, verdictColor, verdictLabel } from './ui.js';

const KEY = (version) => `signal.validate.v${version}`;
const UNAVAILABLE = 'UNAVAILABLE';

function load(version) {
  try {
    return JSON.parse(localStorage.getItem(KEY(version)) || 'null') || { reviewer: '', startedAt: new Date().toISOString(), labels: {} };
  } catch {
    return { reviewer: '', startedAt: new Date().toISOString(), labels: {} };
  }
}
function save(version, state) {
  try {
    localStorage.setItem(KEY(version), JSON.stringify(state));
  } catch {
    /* per-device progress only */
  }
}

export function renderValidate(data) {
  const set = data.validationSet;
  if (!set || !set.items?.length) {
    return `<section class="panel full">${panelHead('VALIDATION · BLIND LABELLING')}<div class="empty">No validation set has been drawn yet. The operator runs <span class="mono">node scripts/build-validation-set.js</span> once the ledger has enough rows in every verdict.</div></section>`;
  }
  return `<section class="panel full validate" id="validate">${panelHead('VALIDATION · BLIND LABELLING', `SET V${esc(String(set.version))} · ${set.items.length} PAIRS`)}<div id="validate-body"></div></section>`;
}

export function wireValidate(root, data) {
  const set = data.validationSet;
  if (!set || !set.items?.length) return;
  const { meta } = data;
  const host = root.querySelector('#validate-body');
  const state = load(set.version);
  let index = set.items.findIndex((it) => !state.labels[it.id]);
  if (index === -1) index = 0;
  const draft = {};

  function labelledCount() {
    return set.items.filter((it) => state.labels[it.id]).length;
  }

  function draw() {
    const item = set.items[index];
    const existing = state.labels[item.id] || null;
    const done = labelledCount();
    const verdicts = meta.verdicts.model.map((v) => `<button type="button" data-verdict="${v}" class="${(draft.verdict ?? existing?.verdict) === v ? 'active' : ''}" style="color:${verdictColor(meta, v)};border-color:${verdictColor(meta, v)}66" title="${esc(meta.verdicts.definitions[v] || '')}">${esc(verdictLabel(meta, v))}</button>`).join('');
    const axis = (key, label) => `<div class="axis-pick"><span class="mono muted">${label}</span><div class="scale">${Array.from({ length: 11 }, (_, i) => `<button type="button" data-axis="${key}" data-value="${i}" class="${(draft[key] ?? existing?.[key]) === i ? 'active' : ''}">${i}</button>`).join('')}</div></div>`;
    host.innerHTML = `
      <div class="validate-top">
        <label class="mono muted" style="font-size:11px;letter-spacing:.1em">REVIEWER <input id="reviewer" type="text" value="${esc(state.reviewer)}" placeholder="your name or initials" maxlength="40"></label>
        <span class="mono muted" style="font-size:11px">${done} OF ${set.items.length} LABELLED · ITEM ${index + 1}</span>
        <span class="toggle"><button type="button" data-nav="-1">◀ PREV</button> · <button type="button" data-nav="1">NEXT ▶</button> · <button type="button" data-nav="first-unlabelled">FIRST UNLABELLED</button></span>
      </div>
      <div class="note">Blind: no model scores are shown or served. Open the article, read it, then judge the headline <b>against that article only</b>, not against what you know of the world. Fidelity 10 = exact; sensationalism and clickbait 0 = none.</div>
      <h1 class="validate-headline">${esc(item.headline)}</h1>
      <div class="mono muted" style="font-size:11px">${esc(item.outlet)} · <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">open the article ↗</a> · evidence the model saw: ${item.evidence === 'fulltext' ? 'full text' : 'feed summary'}</div>
      <div class="filters validate-verdicts">${verdicts}<button type="button" data-verdict="${UNAVAILABLE}" class="${(draft.verdict ?? existing?.verdict) === UNAVAILABLE ? 'active' : ''}" style="color:#a39e94;border-color:#a39e9466" title="The article cannot be reached (paywall, removed, blocked).">CAN'T ACCESS ARTICLE</button></div>
      ${axis('fidelity', 'FIDELITY')}${axis('sens', 'SENSATIONALISM')}${axis('click', 'CLICKBAIT')}
      <div class="validate-actions">
        <button type="button" class="primary" data-save>SAVE LABEL</button>
        <button type="button" data-export>EXPORT LABELS FILE</button>
        <span class="note" id="validate-msg">${existing ? 'This item already has a label; saving replaces it.' : ''}</span>
      </div>
      <div class="note">Export writes <span class="mono">labels-&lt;reviewer&gt;-v${esc(String(set.version))}.json</span>. Commit it to <span class="mono">data/validation/labels/</span>; the next scan computes agreement and the method page reports it once two reviewers have finished.</div>`;
  }

  host.addEventListener('input', (e) => {
    if (e.target.id === 'reviewer') {
      state.reviewer = e.target.value.trim();
      save(set.version, state);
    }
  });
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const item = set.items[index];
    if (b.dataset.verdict) {
      draft.verdict = b.dataset.verdict;
      draw();
      return;
    }
    if (b.dataset.axis) {
      draft[b.dataset.axis] = Number(b.dataset.value);
      draw();
      return;
    }
    if (b.hasAttribute('data-save')) {
      const existing = state.labels[item.id] || {};
      const label = { verdict: draft.verdict ?? existing.verdict, fidelity: draft.fidelity ?? existing.fidelity ?? null, sens: draft.sens ?? existing.sens ?? null, click: draft.click ?? existing.click ?? null, at: new Date().toISOString() };
      const msg = host.querySelector('#validate-msg');
      if (!label.verdict) {
        msg.textContent = 'Pick a verdict first.';
        return;
      }
      if (label.verdict !== UNAVAILABLE && (label.fidelity == null || label.sens == null || label.click == null)) {
        msg.textContent = 'Score all three axes first.';
        return;
      }
      state.labels[item.id] = label;
      save(set.version, state);
      for (const k of Object.keys(draft)) delete draft[k];
      const next = set.items.findIndex((it, i) => i > index && !state.labels[it.id]);
      index = next === -1 ? Math.min(index + 1, set.items.length - 1) : next;
      draw();
      return;
    }
    if (b.hasAttribute('data-export')) {
      const payload = { reviewer: state.reviewer || 'anonymous', version: set.version, startedAt: state.startedAt, exportedAt: new Date().toISOString(), completedAt: labelledCount() === set.items.length ? new Date().toISOString() : null, labels: state.labels };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `labels-${(state.reviewer || 'anonymous').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-v${set.version}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    if (b.dataset.nav) {
      for (const k of Object.keys(draft)) delete draft[k];
      if (b.dataset.nav === 'first-unlabelled') {
        const i = set.items.findIndex((it) => !state.labels[it.id]);
        index = i === -1 ? index : i;
      } else index = Math.max(0, Math.min(set.items.length - 1, index + Number(b.dataset.nav)));
      draw();
    }
  });
  draw();
}
