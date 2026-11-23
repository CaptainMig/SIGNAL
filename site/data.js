// Runtime data access. Everything the site shows comes from these four
// requests; nothing is computed by a model in the browser and nothing is
// written anywhere.
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
    throw new Error(`${url}: ${reason}`);
  }
  return r.json();
}

async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

export async function loadAll() {
  const [meta, latest, historyText, aggregate] = await Promise.all([
    getJson(`${base}/meta`),
    getJson(`${base}/data?file=latest`),
    getText(`${base}/data?file=history`).catch(() => ''),
    getJson(`${base}/data?file=aggregate`).catch(() => null),
  ]);
  const history = parseCsv(historyText).filter((r) => r.run_id);
  history.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  return { meta, latest, history, aggregate };
}
