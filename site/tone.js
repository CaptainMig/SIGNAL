// Tone map and tone trail, from daily.json only.
//
//  - Dots sit on the (sensationalism, clickbait) grid for the selected day;
//    size encodes the count at that point, colour the dominant verdict; a tap
//    lists the headlines there.
//  - TONE TRAIL · 30D: the daily centroid path, fading with age, with a ring
//    on today and a diamond on any day the model string or prompt hash
//    changed (so a scorer jump is not read as a change in the news). This is
//    not called drift: drift is the golden-set panel's word.
//  - Scrubber: step through days; dots and counts redraw for that day.
//  - Outlet overlay: tap an outlet (or star it to keep it) to draw its own
//    30-day trail; only outlets with ≥ 20 rows in the window are offered.
import { esc, fmt, pending, verdictColor, verdictLabel, panelHead } from './ui.js';
import { dayGrid, dotRadius, eligibleOutlets, outletTrail, overallTrail, pointHeadlines, TRAIL_DAYS, OUTLET_MIN_ROWS } from './tonedata.js';

const W = 440;
const H = 300;
const PAD = 18;
const WATCH_KEY = 'signal.watchlist';
const x = (sens) => PAD + (sens / 10) * (W - 2 * PAD);
const y = (click) => H - PAD - (click / 10) * (H - 2 * PAD);

function watchlist() {
  try {
    return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveWatchlist(set) {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify([...set]));
  } catch {
    /* per-device */
  }
}

export function renderToneSection(data) {
  if (!data.daily?.days?.length) {
    return `<div class="panel" style="border:0;padding:0">${panelHead('TONE MAP · SENSATIONALISM × CLICKBAIT')}<div class="note">DAILY TONE SUMMARY ${pending('NEXT RUN')} · the scan job writes daily.json from the next run; the map, scrubber and 30-day tone trail draw from it.</div></div>`;
  }
  return `<div class="tone-wrap" id="tone-map">
    <div class="tone-head subhead"><span>TONE MAP · SENSATIONALISM × CLICKBAIT</span><span data-tone-day></span></div>
    <div class="tone-controls">
      <label class="mono muted" style="font-size:11px;letter-spacing:.1em;display:flex;align-items:center;gap:8px;flex:1 1 220px">DAY <input type="range" data-tone-scrub min="0" max="0" value="0" style="flex:1"></label>
      <span class="toggle"><button type="button" data-tone-trail class="active">TONE TRAIL · ${TRAIL_DAYS}D</button></span>
    </div>
    <div class="tone-plot">
      <div class="axis vertical"><span>10</span><span class="label">CLICKBAIT ↑</span><span>0</span></div>
      <div style="flex:1;min-width:0">
        <svg class="tone-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tone map for the selected day with the 30-day tone trail: sensationalism across, clickbait up" data-tone-svg></svg>
        <div class="axis"><span>0</span><span>SENSATIONALISM →</span><span>10</span></div>
      </div>
    </div>
    <div class="note" data-tone-legend></div>
    <div class="tone-outlets filters" data-tone-outlets></div>
    <div class="tone-list" data-tone-list></div>
  </div>`;
}

export function wireTone(root, data) {
  const host = root.querySelector('#tone-map');
  if (!host) return;
  const { daily, meta } = data;
  const days = (daily.days || []).slice(-TRAIL_DAYS);
  const scrub = host.querySelector('[data-tone-scrub]');
  const svg = host.querySelector('[data-tone-svg]');
  const dayLabel = host.querySelector('[data-tone-day]');
  const legend = host.querySelector('[data-tone-legend]');
  const list = host.querySelector('[data-tone-list]');
  const outletsEl = host.querySelector('[data-tone-outlets]');
  const trailBtn = host.querySelector('[data-tone-trail]');
  const eligible = eligibleOutlets(daily);
  const starred = watchlist();
  // Open on the latest day that holds a scan's rows (days are scan days in
  // ET; a day with no scored rows is skipped).
  let start = days.length - 1;
  while (start > 0 && !(days[start].n > 0)) start--;
  const state = { index: start, trail: true, overlay: new Set([...starred].filter((o) => eligible.some((e) => e.outlet === o))), selected: null };
  scrub.max = String(Math.max(0, days.length - 1));
  scrub.value = String(state.index);

  const OVERLAY_COLORS = ['#c8971f', '#8bbef0', '#c5a0f0', '#6fd49a', '#f08080'];

  function trailPath(points, color, { ring = false } = {}) {
    if (!points.length) return '';
    const n = points.length;
    let out = '';
    for (let i = 1; i < n; i++) {
      const a = points[i - 1];
      const b = points[i];
      const alpha = 0.15 + 0.85 * (i / (n - 1 || 1));
      out += `<line x1="${x(a.sens).toFixed(1)}" y1="${y(a.click).toFixed(1)}" x2="${x(b.sens).toFixed(1)}" y2="${y(b.click).toFixed(1)}" stroke="${color}" stroke-opacity="${alpha.toFixed(2)}" stroke-width="1.5"></line>`;
    }
    for (const p of points) {
      const alpha = 0.2 + 0.8 * (1 - p.age / Math.max(1, n - 1));
      if (p.scorerChanged) {
        const cx = x(p.sens);
        const cy = y(p.click);
        out += `<polygon points="${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}" fill="none" stroke="#e8e4dc" stroke-width="1.5"><title>${esc(p.day)}: model or prompt changed (${esc(p.models.join(', '))} · ${esc(p.promptHashes.join(', '))}). A jump here is the scorer, not the news.</title></polygon>`;
      } else {
        out += `<circle cx="${x(p.sens).toFixed(1)}" cy="${y(p.click).toFixed(1)}" r="2" fill="${color}" fill-opacity="${alpha.toFixed(2)}"><title>${esc(p.day)} · mean S ${p.sens} C ${p.click} · n ${p.n}</title></circle>`;
      }
    }
    if (ring) {
      const t = points[n - 1];
      out += `<circle cx="${x(t.sens).toFixed(1)}" cy="${y(t.click).toFixed(1)}" r="6" fill="none" stroke="${color}" stroke-width="2"><title>Latest day ${esc(t.day)} · mean S ${t.sens} C ${t.click}</title></circle>`;
    }
    return out;
  }

  function draw() {
    const d = days[state.index];
    const g = dayGrid(daily, d.day);
    const isLatest = state.index === days.length - 1;
    dayLabel.textContent = `${isLatest ? 'LATEST DAY' : 'DAY'} ${d.day} · ${g.n} SCORED ROWS · ${g.grid.length} POINTS`;
    const grid = [`<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="rgba(232,228,220,0.3)" stroke-width="0.5"></line>`, `<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="rgba(232,228,220,0.3)" stroke-width="0.5"></line>`];
    for (const v of [2.5, 5, 7.5]) {
      grid.push(`<line x1="${x(v)}" y1="${PAD}" x2="${x(v)}" y2="${H - PAD}" stroke="rgba(232,228,220,0.08)" stroke-width="0.5"></line>`);
      grid.push(`<line x1="${PAD}" y1="${y(v)}" x2="${W - PAD}" y2="${y(v)}" stroke="rgba(232,228,220,0.08)" stroke-width="0.5"></line>`);
    }
    const dots = g.grid.map((c, i) => `<circle class="tone-dot" data-cell="${i}" cx="${x(c.sens).toFixed(1)}" cy="${y(c.click).toFixed(1)}" r="${dotRadius(c.n)}" fill="${c.dominant === 'TONE' ? '#a39e94' : verdictColor(meta, c.dominant)}" fill-opacity="0.75" stroke="${state.selected === i ? '#e8e4dc' : 'none'}" stroke-width="1.5"><title>S ${c.sens} C ${c.click} · ${c.n} headline${c.n === 1 ? '' : 's'} · dominant ${esc(c.dominant === 'TONE' ? 'tone only' : verdictLabel(meta, c.dominant))}</title></circle>`).join('');
    let trails = '';
    if (state.trail) {
      trails += trailPath(overallTrail(daily), '#5aabb0', { ring: true });
      [...state.overlay].forEach((o, i) => {
        trails += trailPath(outletTrail(daily, o), OVERLAY_COLORS[i % OVERLAY_COLORS.length], { ring: true });
      });
    }
    svg.innerHTML = grid.join('') + trails + dots;
    const overlayLegend = [...state.overlay].map((o, i) => `<span style="color:${OVERLAY_COLORS[i % OVERLAY_COLORS.length]}">— ${esc(o)}</span>`).join(' · ');
    legend.innerHTML = `DOT SIZE = HEADLINES AT THAT POINT · COLOUR = DOMINANT VERDICT · GREY = TONE ONLY${state.trail ? ` · <span class="accent">— TONE TRAIL · ${TRAIL_DAYS}D (DAILY MEAN, FADES WITH AGE, RING = LATEST DAY, ◇ = MODEL OR PROMPT CHANGED)</span>` : ''}${overlayLegend ? ` · ${overlayLegend}` : ''}`;
    outletsEl.innerHTML = eligible.length
      ? `<span class="mono muted" style="font-size:10px;letter-spacing:.1em;align-self:center">OVERLAY AN OUTLET'S TRAIL (≥ ${OUTLET_MIN_ROWS} ROWS IN ${TRAIL_DAYS}D)</span>` + eligible.map((e) => `<span class="tone-outlet"><button type="button" data-outlet="${esc(e.outlet)}" class="${state.overlay.has(e.outlet) ? 'active' : ''}" style="color:#e8e4dc;border-color:rgba(232,228,220,0.3)">${esc(e.outlet)} <span class="muted">${e.rows}</span></button><button type="button" data-star="${esc(e.outlet)}" class="star ${starred.has(e.outlet) ? 'on' : ''}" title="Keep this outlet's trail on (watchlist, this device)">${starred.has(e.outlet) ? '★' : '☆'}</button></span>`).join('')
      : `<span class="note">NO OUTLET HAS ${OUTLET_MIN_ROWS} ROWS IN THE WINDOW YET</span>`;
    if (state.selected != null && g.grid[state.selected]) {
      const c = g.grid[state.selected];
      const h = pointHeadlines(c, g.titles, data.latest?.rows);
      list.innerHTML = `<div class="subhead"><span>S ${c.sens} · C ${c.click} · ${c.n} HEADLINE${c.n === 1 ? '' : 'S'} ON ${esc(d.day)}</span><span>${Object.entries(c.verdicts).map(([v, n]) => `${esc(v === 'TONE' ? 'TONE ONLY' : verdictLabel(meta, v))} ${n}`).join(' · ')}</span></div>
        <ul class="tone-headlines">${h.items.map((it) => `<li><span class="pill" style="color:${verdictColor(meta, it.verdict)};border-color:${verdictColor(meta, it.verdict)}66">${esc(verdictLabel(meta, it.verdict))}</span> ${data.latest?.rows?.some((r) => r.id === it.id) ? `<a href="/article/${esc(it.id)}" data-link>${esc(it.title)}</a>` : esc(it.title)} <span class="muted">· ${esc(it.outlet)}</span></li>`).join('')}</ul>
        ${h.unknown || h.more ? `<div class="note">${h.unknown ? `${h.unknown} headline${h.unknown === 1 ? '' : 's'} from this day no longer in the current view (titles are kept for 7 days)` : ''}${h.unknown && h.more ? ' · ' : ''}${h.more ? `${h.more} more not listed` : ''}</div>` : ''}`;
    } else {
      list.innerHTML = `<div class="note">TAP A POINT TO LIST ITS HEADLINES</div>`;
    }
  }

  scrub.addEventListener('input', () => {
    state.index = Number(scrub.value);
    state.selected = null;
    draw();
  });
  trailBtn.addEventListener('click', () => {
    state.trail = !state.trail;
    trailBtn.classList.toggle('active', state.trail);
    draw();
  });
  svg.addEventListener('click', (e) => {
    const c = e.target.closest('circle.tone-dot');
    if (!c) return;
    const i = Number(c.dataset.cell);
    state.selected = state.selected === i ? null : i;
    draw();
  });
  outletsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.outlet) {
      if (state.overlay.has(b.dataset.outlet)) state.overlay.delete(b.dataset.outlet);
      else state.overlay.add(b.dataset.outlet);
    } else if (b.dataset.star) {
      if (starred.has(b.dataset.star)) starred.delete(b.dataset.star);
      else {
        starred.add(b.dataset.star);
        state.overlay.add(b.dataset.star);
      }
      saveWatchlist(starred);
    }
    draw();
  });
  draw();
}

export { fmt };
