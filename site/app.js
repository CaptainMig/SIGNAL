// Signal v2 — static, read-only site. Loads the ledger at runtime and renders
// one of five views. No model calls, no writes, no placeholder numbers: a
// panel whose data is not computed yet says so.
import { DEFAULT_PACK, loadAll, loadValidationSet } from './data.js';
import { esc, fmt } from './ui.js';
import { renderDeck, wireDeck } from './deck.js';
import { renderHeadlines, wireHeadlines } from './headlines.js';
import { renderArticle } from './article.js';
import { renderOutlets } from './outlets.js';
import { renderMethod } from './method.js';
import { renderValidate, wireValidate } from './validate.js';
import { getTv, mountTv } from './tv.js';
import { staleness } from './metrics.js';

const ROUTES = [
  { path: '/', label: 'DECK', view: 'deck' },
  { path: '/headlines', label: 'HEADLINES', view: 'headlines' },
  { path: '/outlets', label: 'OUTLETS', view: 'outlets' },
  { path: '/method', label: 'METHOD', view: 'method' },
];

const PACK_STORAGE_KEY = 'signal.pack';
const state = { data: null, error: null, pack: initialPack() };

// The active pack: ?pack= in the URL, else the device's last choice, else
// national. Only keys /api/meta knows are honoured once it has loaded.
function initialPack() {
  try {
    const fromUrl = new URL(location.href).searchParams.get('pack');
    if (fromUrl) return fromUrl;
    return localStorage.getItem(PACK_STORAGE_KEY) || DEFAULT_PACK;
  } catch {
    return DEFAULT_PACK;
  }
}

function packHref(path, pack) {
  return pack && pack !== DEFAULT_PACK ? `${path}?pack=${encodeURIComponent(pack)}` : path;
}

async function switchPack(pack) {
  if (pack === state.pack) return;
  state.pack = pack;
  try {
    localStorage.setItem(PACK_STORAGE_KEY, pack);
  } catch {
    /* per-device convenience */
  }
  history.replaceState({}, '', packHref(location.pathname, pack));
  document.getElementById('main').innerHTML = `<p class="mono muted loading">LOADING ${esc(pack.toUpperCase())} PACK…</p>`;
  try {
    state.data = await loadAll(pack);
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

function renderPackSwitch(meta, current) {
  const packs = meta?.packs?.length ? meta.packs : [{ key: DEFAULT_PACK, label: 'NATIONAL' }];
  return `<span class="chip packs" role="group" aria-label="Feed pack">PACK ${packs.map((p) => `<button type="button" data-pack="${esc(p.key)}" class="${p.key === current ? 'active' : ''}" aria-pressed="${p.key === current ? 'true' : 'false'}" title="${esc(p.description || '')}">${esc(p.label)}</button>`).join('')}</span>`;
}

function route() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const m = p.match(/^\/article\/([a-f0-9]{6,16})$/i);
  if (m) return { view: 'article', id: m[1].toLowerCase(), path: p };
  if (p === '/validate') return { view: 'validate', path: p }; // unlisted
  const r = ROUTES.find((x) => x.path === p);
  return r ? { view: r.view, path: p } : { view: 'notfound', path: p };
}

// The TV button is not a route: it opens the Live TV dock from any page.
function tvButton(snap) {
  const on = !!snap?.channel;
  return `<button type="button" class="nav-tv${snap?.open ? ' active' : ''}" data-tv-toggle aria-pressed="${snap?.open ? 'true' : 'false'}" aria-label="${snap?.open ? 'Close' : 'Open'} Live TV">${on ? 'TV · ON' : 'TV'}</button>`;
}

function renderNav(current) {
  const nav = document.querySelector('.nav');
  nav.innerHTML = ROUTES.map((r) => `<a href="${packHref(r.path, state.pack)}" data-link class="${current.view === r.view || (current.view === 'article' && r.view === 'headlines') ? 'active' : ''}">${r.label}</a>`).join('') + tvButton(getTv()?.snapshot());
}

function reflectTv(snap) {
  const b = document.querySelector('[data-tv-toggle]');
  if (b) b.outerHTML = tvButton(snap);
}

function renderChips({ latest, history, meta, pack }) {
  const el = document.getElementById('chips');
  const packChip = renderPackSwitch(meta, pack || DEFAULT_PACK);
  if (!latest || !latest.id || !latest.rows?.length) {
    el.innerHTML = `${packChip}<span class="chip warn">NO RUN RECORDED YET${pack && pack !== DEFAULT_PACK ? ' FOR THIS PACK' : ''}</span><span class="chip">METHODOLOGY V2</span>`;
    return;
  }
  const finished = Date.parse(latest.finishedAt);
  // The scheduled job fires hourly at the minute /api/meta reports.
  const minute = Number.isInteger(meta?.scanMinuteUtc) ? meta.scanMinuteUtc : 11;
  const next = new Date(finished);
  next.setUTCMinutes(minute, 0, 0);
  if (next.getTime() <= finished) next.setUTCHours(next.getUTCHours() + 1);
  const stale = staleness(latest) !== null;
  // When the ledger is stale the next slot is counted from now, not from a
  // run that is hours old.
  if (stale) {
    next.setTime(Date.now());
    next.setUTCMinutes(minute, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCHours(next.getUTCHours() + 1);
  }
  el.innerHTML = [
    packChip,
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
  const packLabel = state.data.meta?.packs?.find((p) => p.key === state.pack)?.label;
  document.title = `Signal · ${current.view === 'article' ? 'Article' : ROUTES.find((r) => r.view === current.view)?.label || 'Media Integrity Scanner'}${packLabel && state.pack !== DEFAULT_PACK ? ` · ${packLabel}` : ''}`;
  if (!state.data.latest && current.view !== 'method' && current.view !== 'validate') {
    main.innerHTML = `<div class="panel"><div class="empty">No run recorded yet for the ${esc(packLabel || state.pack)} pack. Its first scan writes the files this view reads.</div></div>`;
    return;
  }
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
  const t = e.target.closest('[data-tv-toggle]');
  if (t) {
    getTv()?.toggle();
    return;
  }
  const pk = e.target.closest('button[data-pack]');
  if (pk) {
    switchPack(pk.dataset.pack);
    return;
  }
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState({}, '', a.getAttribute('href'));
  render();
});
window.addEventListener('popstate', render);

// The dock lives outside the routed view and is mounted exactly once, so a
// stream survives navigation. It works even if the ledger fails to load.
const dock = document.getElementById('tv-dock');
if (dock) mountTv(dock).subscribe(reflectTv);

loadAll(state.pack)
  .then((data) => {
    // An unknown pack in the URL or storage falls back to national.
    if (data.meta?.packs?.length && !data.meta.packs.some((p) => p.key === state.pack)) {
      state.pack = DEFAULT_PACK;
      return loadAll(state.pack).then((d) => {
        state.data = d;
        render();
      });
    }
    state.data = data;
    render();
  })
  .catch((e) => {
    state.error = e.message;
    render();
  });
