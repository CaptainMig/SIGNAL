#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Extraction probe — a diagnostic, never part of a scan. Takes the rows whose
// full-text fetch failed in the current ledger view, retries each URL with a
// set of fetch strategies from wherever this runs (the GitHub runner, via
// extract-probe.yml), and reports which strategy would have succeeded.
// Spends no tokens, writes nothing to the ledger. Article text is measured
// (character count) and discarded; only the page <title> is reported.
//
//   node scripts/probe-extract.js [--per-outlet N] [--timeout MS] [--report FILE] [--root DIR]
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractText } from '../pipeline/extract.js';
import { EXTRACT_MIN_CHARS, USER_AGENT } from '../pipeline/config.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const perOutlet = Number(arg('--per-outlet', 4)) || 4;
const timeoutMs = Number(arg('--timeout', 20_000)) || 20_000;
const reportPath = arg('--report', null);
const root = String(arg('--root', '.'));

const CHROME_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const CHROME_FULL = {
  ...CHROME_HEADERS,
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0',
};
const FIREFOX = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};
const HONEST = {
  'User-Agent': 'Mozilla/5.0 (compatible; SignalScan/2; +https://github.com/CaptainMig/SIGNAL)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

// Host-specific alternate URLs: a text or AMP rendering the publisher offers.
export function alternateUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'washingtonpost.com') {
    u.searchParams.set('outputType', 'amp');
    return u.toString();
  }
  if (host === 'npr.org') {
    const m = u.pathname.match(/\/(nx-s\d+-\d+|g-s\d+-\d+|\d{6,})\b/);
    return m ? `https://text.npr.org/${m[1]}` : null;
  }
  if (host === 'cbsnews.com' || host === 'nbcnews.com' || host === 'abcnews.go.com') {
    return u.pathname.includes('/video/') ? null : `${u.origin}${u.pathname.replace(/\/$/, '')}/amp/`;
  }
  return null;
}

const STRATEGIES = [
  { key: 'chrome', headers: CHROME_HEADERS },
  { key: 'chrome-full', headers: CHROME_FULL },
  { key: 'firefox', headers: FIREFOX },
  { key: 'honest-bot', headers: HONEST },
  { key: 'alternate', headers: CHROME_HEADERS, url: alternateUrl },
];

async function attempt(url, strategy) {
  const target = strategy.url ? strategy.url(url) : url;
  if (!target) return { key: strategy.key, skipped: true };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: strategy.headers });
  } catch (e) {
    return { key: strategy.key, status: 0, ms: Date.now() - t0, error: e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'error' };
  }
  const ms = Date.now() - t0;
  let html = '';
  try {
    html = await res.text();
  } catch {
    /* partial read counts as what it is */
  }
  const { text, title } = extractText(html);
  const finalHost = (() => {
    try {
      return new URL(res.url || target).hostname;
    } catch {
      return '';
    }
  })();
  return { key: strategy.key, status: res.status, ms, chars: text.length, ok: res.ok && text.length >= EXTRACT_MIN_CHARS, title: title.slice(0, 90), finalHost, bytes: html.length };
}

async function pool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export async function main() {
  const latest = JSON.parse(await fs.readFile(path.join(root, 'data/latest.json'), 'utf8'));
  const failed = latest.rows.filter((r) => r.fulltextError && !r.fulltext);
  const byOutlet = new Map();
  for (const r of failed) {
    const k = r.outlet || r.publication;
    if (!byOutlet.has(k)) byOutlet.set(k, []);
    if (byOutlet.get(k).length < perOutlet) byOutlet.get(k).push(r);
  }
  const targets = [...byOutlet.values()].flat();
  console.log(`[probe] ${failed.length} failed row(s) in ${latest.id}; probing ${targets.length} (≤${perOutlet} per outlet) with ${STRATEGIES.length} strategies, timeout ${timeoutMs} ms`);
  const results = [];
  await pool(targets, 3, async (row) => {
    const out = { outlet: row.outlet || row.publication, id: row.id, url: row.link, prior: `${row.fulltextError.reason}${row.fulltextError.detail && row.fulltextError.detail !== row.fulltextError.reason ? ' ' + row.fulltextError.detail : ''}`, attempts: [] };
    for (const s of STRATEGIES) {
      const a = await attempt(row.link, s);
      out.attempts.push(a);
      console.log(`[probe] ${out.outlet} · ${s.key.padEnd(11)} → ${a.skipped ? 'n/a' : `${a.status || a.error} · ${a.ms} ms · ${a.chars ?? 0} chars${a.ok ? ' · OK' : ''}`}`);
    }
    results.push(out);
  });
  results.sort((a, b) => (a.outlet < b.outlet ? -1 : a.outlet > b.outlet ? 1 : 0));

  const L = [];
  L.push(`# Extraction probe · from ${latest.id}`);
  L.push('');
  L.push(`${failed.length} failed row(s) in the current view; ${targets.length} probed (≤${perOutlet} per outlet), ${STRATEGIES.length} strategies, ${timeoutMs} ms timeout. Text is counted and discarded.`);
  L.push('');
  L.push('## By outlet: first strategy that extracts');
  L.push('');
  L.push('| Outlet | Probed | Prior failure | chrome | chrome-full | firefox | honest-bot | alternate | Any |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const [outlet, rows] of byOutlet) {
    const rs = results.filter((r) => r.outlet === outlet);
    const okCount = (key) => rs.filter((r) => r.attempts.find((a) => a.key === key)?.ok).length;
    const any = rs.filter((r) => r.attempts.some((a) => a.ok)).length;
    const prior = [...new Set(rs.map((r) => r.prior))].join(', ');
    L.push(`| ${outlet} | ${rs.length} | ${prior} | ${STRATEGIES.map((s) => `${okCount(s.key)}/${rs.length}`).join(' | ')} | **${any}/${rs.length}** |`);
  }
  L.push('');
  L.push('## Every attempt');
  L.push('');
  L.push('| Outlet | Prior | Strategy | HTTP | ms | Chars | Final host | Title |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    for (const a of r.attempts) {
      if (a.skipped) continue;
      L.push(`| ${r.outlet} | ${r.prior} | ${a.key} | ${a.status || a.error} | ${a.ms} | ${a.chars ?? ''}${a.ok ? ' ✓' : ''} | ${a.finalHost || ''} | ${(a.title || '').replace(/\|/g, '/')} |`);
    }
  }
  L.push('');
  const report = L.join('\n');
  if (reportPath) {
    await fs.writeFile(String(reportPath), report);
    console.log(`[probe] report written to ${reportPath}`);
  } else {
    console.log(report);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, '/'));
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[probe] fatal:', e);
    process.exit(1);
  });
}
