// Shared rendering helpers: escaping, number formatting, chips, pills,
// sparklines. All output is a string of HTML; every dynamic value passes
// through esc().

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const DASH = '—';

export const fmt = {
  pct: (v, d = 0) => (v == null || !Number.isFinite(v) ? DASH : `${Number(v).toFixed(d)}%`),
  num: (v, d = 0) => (v == null || !Number.isFinite(v) ? DASH : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
  signed: (v, d = 1) => (v == null || !Number.isFinite(v) ? DASH : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}`),
  usd: (v) => (v == null || !Number.isFinite(v) ? DASH : `$${Number(v).toFixed(v < 1 ? 3 : 2)}`),
  range: (lo, hi, d = 0) => (lo == null || hi == null ? DASH : lo === hi ? `${Number(lo).toFixed(d)}` : `${Number(lo).toFixed(d)}–${Number(hi).toFixed(d)}`),
  et: (iso) => {
    if (!iso) return DASH;
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return DASH;
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) + ' ET';
  },
  dateEt: (iso) => {
    if (!iso) return DASH;
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return DASH;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }).toUpperCase();
  },
  age: (iso, now = Date.now()) => {
    if (!iso) return DASH;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return DASH;
    const mins = Math.max(0, Math.round((now - t) / 60000));
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  },
  secs: (ms) => (ms == null ? DASH : `${Math.round(ms / 1000)}`),
};

// A value that is not computed yet. Never a placeholder number.
export function pending(phase = 'PHASE 2') {
  return `<span class="pending" title="Not computed yet. Lands in ${esc(phase.toLowerCase())}.">PENDING · ${esc(phase)}</span>`;
}

export function verdictLabel(meta, v) {
  if (v == null) return 'TONE ONLY';
  return meta.verdicts.labels[v] || v;
}

export function verdictColor(meta, v) {
  if (v == null) return '#a39e94';
  return meta.verdicts.colors[v] || '#8d939e';
}

export function pill(meta, v) {
  const c = verdictColor(meta, v);
  return `<span class="pill" style="color:${c};border-color:${c}66;background:${c}1f">${esc(verdictLabel(meta, v))}</span>`;
}

export function panelHead(title, right = '') {
  return `<div class="panel-head"><span>${title}</span>${right ? `<span>${right}</span>` : ''}</div>`;
}

export function kv(label, value, { color } = {}) {
  return `<div class="kv"><span class="muted">${label}</span><span${color ? ` style="color:${color}"` : ''}>${value}</span></div>`;
}

// Sparkline polyline over values (nulls skipped), fixed viewBox.
export function sparkline(values, { w = 70, h = 20, stroke = '#6fd49a', min = null, max = null } = {}) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null && Number.isFinite(v));
  if (pts.length < 2) return `<svg aria-hidden="true" viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px"></svg>`;
  const lo = min ?? Math.min(...pts.map((p) => p[1]));
  const hi = max ?? Math.max(...pts.map((p) => p[1]));
  const span = hi - lo || 1;
  const n = values.length - 1 || 1;
  const path = pts.map(([i, v]) => `${((i / n) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg aria-hidden="true" viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px"><polyline fill="none" stroke="${stroke}" stroke-width="1.25" points="${path}"></polyline></svg>`;
}

export function scoreColor(v, invert = false) {
  if (v == null) return 'rgba(232,228,220,0.35)';
  const x = invert ? 10 - v : v;
  return x >= 7 ? '#6fd49a' : x >= 4 ? '#c8971f' : '#f08080';
}

export function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export const mean = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
