// Runtime data access. Everything the site shows comes from these requests;
// nothing is computed by a model in the browser and nothing is written.
import { parseCsv } from './csv.js';

const base = '/api';

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    let reason = `HTTP ${r.status}`;
    try {
      reason = (await r.json()).error || reason;
    } catch {
      /* keep status */
    }
    const err = new Error(`${url}: ${reason}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

const byStart = (a, b) => String(a.started_at).localeCompare(String(b.started_at));

export const DEFAULT_PACK = 'national';

// Every ledger file is read for ONE pack; nothing is blended across packs.
// The national pack is the original ledger; other packs add `&pack=<key>`.
export function fileUrl(file, pack = DEFAULT_PACK) {
  return `${base}/data?file=${file}${pack && pack !== DEFAULT_PACK ? `&pack=${encodeURIComponent(pack)}` : ''}`;
}

export async function loadAll(pack = DEFAULT_PACK) {
  const [meta, latest, historyText, statsText, aggregate, daily, validation] = await Promise.all([
    getJson(`${base}/meta`),
    getJson(fileUrl('latest', pack)).catch((e) => {
      if (pack !== DEFAULT_PACK && e.status === 404) return null; // a pack with no run yet
      throw e;
    }),
    getText(fileUrl('history', pack)).catch(() => ''),
    getText(fileUrl('stats', pack)).catch(() => ''),
    getJson(fileUrl('aggregate', pack)).catch(() => null),
    getJson(fileUrl('daily', pack)).catch(() => null),
    getJson(`${base}/data?file=validation-agreement`).catch(() => null),
  ]);
  const history = parseCsv(historyText).filter((r) => r.run_id).sort(byStart);
  const stats = parseCsv(statsText).filter((r) => r.run_id).sort(byStart);
  return { pack, meta, latest, history, stats, aggregate, daily, validation };
}

// The blind labelling set, loaded only on the /validate route.
export async function loadValidationSet() {
  return getJson(`${base}/data?file=validation-set`).catch(() => null);
}
