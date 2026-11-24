// Signal v2 — static, read-only site. Loads the ledger at runtime and renders
// one of five views. No model calls, no writes, no placeholder numbers: a
// panel whose data is not computed yet says so.
import { loadAll, loadValidationSet } from './data.js';
import { esc, fmt } from './ui.js';
import { renderDeck, wireDeck } from './deck.js';
import { renderHeadlines, wireHeadlines } from './headlines.js';
import { renderArticle } from './article.js';
import { renderOutlets } from './outlets.js';
import { renderMethod } from './method.js';
import { renderValidate, wireValidate } from './validate.js';

const ROUTES = [
  { path: '/', label: 'DECK', view: 'deck' },
  { path: '/headlines', label: 'HEADLINES', view: 'headlines' },
  { path: '/outlets', label: 'OUTLETS', view: 'outlets' },
  { path: '/method', label: 'METHOD', view: 'method' },
];

const state = { data: null, error: null };

function route() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const m = p.match(/^\/article\/([a-f0-9]{6,16})$/i);
  if (m) return { view: 'article', id: m[1].toLowerCase(), path: p };
  if (p === '/validate') return { view: 'validate', path: p }; // unlisted
  const r = ROUTES.find((x) => x.path === p);
  return r ? { view: r.view, path: p } : { view: 'notfound', path: p };
}

function renderNav(current) {
  const nav = document.querySelector('.nav');
  nav.innerHTML = ROUTES.map((r) => `<a href="${r.path}" data-link class="${current.view === r.view || (current.view === 'article' && r.view === 'headlines') ? 'active' : ''}">${r.label}</a>`).join('');
}

function renderChips({ latest, history, meta }) {
  const el = document.getElementById('chips');
  if (!latest || !latest.id || !latest.rows?.length) {
    el.innerHTML = `<span class="chip warn">NO RUN RECORDED YET</span><span class="chip">METHODOLOGY V2</span>`;
    return;
  }
  const finished = Date.parse(latest.finishedAt);
  // The scheduled job fires hourly at the minute /api/meta reports.
  const minute = Number.isInteger(meta?.scanMinuteUtc) ? meta.scanMinuteUtc : 11;
  const next = new Date(finished);
  next.setUTCMinutes(minute, 0, 0);
  if (next.getTime() <= finished) next.setUTCHours(next.getUTCHours() + 1);
  const ageMin = Math.round((Date.now() - finished) / 60000);
  const stale = ageMin > 150;
  el.innerHTML = [
    `<span class="chip ${stale ? 'warn' : 'live'}">${stale ? `LEDGER STALE · ${fmt.age(latest.finishedAt)} OLD` : 'LIVE · LEDGER'}</span>`,
    `<span class="chip">LAST RUN ${fmt.dateEt(latest.finishedAt)} ${fmt.et(latest.finishedAt)}</span>`,
    `<span class="chip">NEXT RUN ${fmt.et(next.toISOString())}</span>`,
    `<span class="chip">${history.length} RUN${history.length === 1 ? '' : 'S'} IN LEDGER</span>`,
    `<span class="chip">METHODOLOGY ${esc(String(latest.methodology || 'v2').toUpperCase())}</span>`,
    latest.dryRun ? `<span class="chip bad">DRY RUN · NOTHING SCORED</span>` : '',
  ].join('');
}

function render() {
  const main = document.getElementById('main');
  const current = route();
  renderNav(current);
  if (state.error) {
    main.innerHTML = `<div class="error-box">LEDGER UNAVAILABLE · ${esc(state.error)}</div>`;
    return;
  }
  if (!state.data) return;
  renderChips(state.data);
  document.title = `Signal · ${current.view === 'article' ? 'Article' : ROUTES.find((r) => r.view === current.view)?.label || 'Media Integrity Scanner'}`;
  switch (current.view) {
    case 'deck':
      main.innerHTML = renderDeck(state.data);
      wireDeck(main, state.data);
      break;
    case 'headlines':
      main.innerHTML = renderHeadlines(state.data);
      wireHeadlines(main, state.data);
      break;
    case 'outlets':
      main.innerHTML = renderOutlets(state.data);
      break;
    case 'method':
      main.innerHTML = renderMethod(state.data);
      break;
    case 'article':
      main.innerHTML = renderArticle(state.data, current.id);
      break;
    case 'validate':
      if (state.data.validationSet === undefined) {
        main.innerHTML = `<p class="mono muted loading">LOADING VALIDATION SET…</p>`;
        loadValidationSet().then((set) => {
          state.data.validationSet = set;
          render();
        });
        break;
      }
      main.innerHTML = renderValidate(state.data);
      wireValidate(main, state.data);
      break;
    default:
      main.innerHTML = `<div class="panel"><div class="empty">NOT FOUND · <a href="/" data-link>back to the deck</a></div></div>`;
  }
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState({}, '', a.getAttribute('href'));
  render();
});
window.addEventListener('popstate', render);

loadAll()
  .then((data) => {
    state.data = data;
    render();
  })
  .catch((e) => {
    state.error = e.message;
    render();
  });
