import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../site/csv.js';
import { ALLOWED, readLedgerFile, repoCoordinates } from '../api/_ledger.js';

test('parseCsv handles quotes, doubled quotes, CRLF, numbers and empties', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y",\n2,"say ""hi""",3.5\n');
  assert.deepEqual(rows, [
    { a: 1, b: 'x, y', c: null },
    { a: 2, b: 'say "hi"', c: 3.5 },
  ]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,b\n'), []);
});

test('ledger access serves only the allowed files; the current view is built, never a committed file', async () => {
  assert.deepEqual(Object.keys(ALLOWED), ['latest', 'history', 'aggregate', 'stats', 'daily', 'validation-set', 'validation-agreement']);
  assert.equal(ALLOWED.latest.built, true);
  assert.equal(ALLOWED.latest.file, 'pointer.json');
  assert.ok(!Object.values(ALLOWED).some((v) => /model-labels/.test(v.file)), 'the model labels are never served');
  const r = await readLedgerFile('../package', { env: { SIGNAL_DATA_LOCAL: '1' } });
  assert.deepEqual([r.ok, r.status], [false, 404]);
});

test('ledger access reads from disk locally and from the repository otherwise', async () => {
  const local = await readLedgerFile('aggregate', { env: { SIGNAL_DATA_LOCAL: '1', SIGNAL_DATA_DIR: 'data' } });
  assert.equal(local.ok, true);
  assert.equal(local.source, 'local');
  assert.equal(JSON.parse(local.body).windowHours, 24);

  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization || null });
    return { ok: true, status: 200, text: async () => '{"x":1}' };
  };
  const env = { VERCEL_GIT_REPO_OWNER: 'Owner', VERCEL_GIT_REPO_SLUG: 'Repo', GITHUB_TOKEN: 'secret' };
  const remote = await readLedgerFile('history', { env, fetch });
  assert.equal(remote.ok, true);
  assert.equal(remote.source, 'github');
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/Owner/Repo/main/data/history.csv');
  assert.equal(calls[0].auth, 'token secret');

  const anon = await readLedgerFile('history', { env: {}, fetch: async () => ({ ok: false, status: 404 }) });
  assert.deepEqual([anon.ok, anon.status], [false, 404]);
  assert.equal(anon.reason, 'data/history.csv: upstream HTTP 404', 'the real reason and the path, no guess about visibility');
  assert.equal(anon.upstream, 'https://raw.githubusercontent.com/CaptainMig/SIGNAL/main/data/history.csv');
  assert.deepEqual(repoCoordinates({}), { owner: 'CaptainMig', repo: 'SIGNAL', ref: 'main' });
});

test('aggregate endpoint keeps the v1 contract shape on failure', async () => {
  const { default: handler } = await import('../api/aggregate.js');
  process.env.SIGNAL_DATA_LOCAL = '1';
  process.env.SIGNAL_DATA_DIR = '/nonexistent';
  let status = 0;
  let body = null;
  const res = { setHeader() {}, status: (c) => ((status = c), res), json: (o) => ((body = o), res), send: (b) => ((body = JSON.parse(b)), res), end() {} };
  await handler({ method: 'GET', query: {} }, res);
  delete process.env.SIGNAL_DATA_LOCAL;
  delete process.env.SIGNAL_DATA_DIR;
  assert.equal(status, 200);
  assert.equal(body.scored, 0);
  assert.equal(body.windowHours, 24);
  assert.equal(body.meanIntegrity, null);
});

test('daily report groups history rows by UTC day with totals and means', async () => {
  const { dailyReport } = await import('../scripts/report-daily.js');
  const rows = [
    { started_at: '2026-11-23T18:00:00Z', rows_total: 196, rows_scored: 196, rows_unscored: 0, model_calls: 200, tokens_input: 100, tokens_output: 50, tokens_cache_read: 1000, cost_usd: 0.3, fi_v2_low: 89, fi_v2_high: 92, coverage_pct: 80, feeds_live: 22 },
    { started_at: '2026-11-23T19:00:00Z', rows_total: 200, rows_scored: 198, rows_unscored: 2, model_calls: 60, tokens_input: 50, tokens_output: 20, tokens_cache_read: 500, cost_usd: 0.1, fi_v2_low: 91, fi_v2_high: 94, coverage_pct: 82, feeds_live: 23 },
    { started_at: '2026-11-24T00:00:00Z', rows_total: 190, rows_scored: 190, rows_unscored: 0, model_calls: 50, tokens_input: 40, tokens_output: 10, tokens_cache_read: 400, cost_usd: 0.05, fi_v2_low: 90, fi_v2_high: 93, coverage_pct: 79, feeds_live: 22 },
  ];
  const r = dailyReport(rows);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].day, r[0].runs, r[0].complete, r[0].rows_mean, r[0].unscored_total, r[0].model_calls, r[0].cost_usd, r[0].cost_per_run_usd, r[0].fi_v2_low_mean, r[0].coverage_mean], ['2026-11-23', 2, false, 198, 2, 260, 0.4, 0.2, 90, 81]);
  assert.equal(r[1].day, '2026-11-24');
});


test('trigger route: configured secrets, constant-time token, workflow_dispatch call, GitHub errors relayed', async () => {
  const { createHandler, WORKFLOW_FILE } = await import('../api/trigger.js');
  const { presentedToken } = await import('../api/_auth.js');
  const calls = [];
  const res = () => {
    const r = { headers: {}, statusCode: null, body: null, setHeader: (k, v) => (r.headers[k] = v), status: (c) => ((r.statusCode = c), r), json: (b) => ((r.body = b), r) };
    return r;
  };
  const gh = (status, text = '') => async (url, opts) => {
    calls.push({ url, opts });
    return { status, text: async () => text };
  };
  const env = { SIGNAL_TRIGGER_TOKEN: 'shared', SIGNAL_GH_TOKEN: 'ghp_x', SIGNAL_REPO_OWNER: 'CaptainMig', SIGNAL_REPO_NAME: 'SIGNAL' };
  let r = res();
  await createHandler({ env: {}, fetch: gh(204) })({ method: 'POST', headers: {}, url: '/api/trigger' }, r);
  assert.equal(r.statusCode, 503);
  r = res();
  await createHandler({ env, fetch: gh(204) })({ method: 'POST', headers: { 'x-signal-trigger-token': 'wrong' }, url: '/api/trigger' }, r);
  assert.equal(r.statusCode, 401);
  assert.equal(calls.length, 0, 'GitHub is never called without the shared secret');
  r = res();
  await createHandler({ env, fetch: gh(204) })({ method: 'POST', headers: { 'x-signal-trigger-token': 'shared' }, url: '/api/trigger' }, r);
  assert.equal(r.statusCode, 202);
  assert.deepEqual([r.body.ok, r.body.dispatched, r.body.workflow, r.body.ref, r.body.force], [true, true, WORKFLOW_FILE, 'main', false]);
  assert.equal(calls[0].url, 'https://api.github.com/repos/CaptainMig/SIGNAL/actions/workflows/scan.yml/dispatches');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ghp_x');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { ref: 'main', inputs: { force: 'false' } });
  r = res();
  await createHandler({ env, fetch: gh(204) })({ method: 'GET', headers: { authorization: 'Bearer shared' }, url: '/api/trigger?force=1' }, r);
  assert.deepEqual([r.statusCode, r.body.force], [202, true]);
  assert.deepEqual(JSON.parse(calls[1].opts.body).inputs, { force: 'true' });
  r = res();
  await createHandler({ env, fetch: gh(404, 'Not Found') })({ method: 'GET', headers: {}, url: '/api/trigger?token=shared' }, r);
  assert.deepEqual([r.statusCode, r.body.ok, r.body.detail], [502, false, 'GitHub HTTP 404: Not Found']);
  r = res();
  await createHandler({ env, fetch: gh(204) })({ method: 'DELETE', headers: {}, url: '/api/trigger' }, r);
  assert.equal(r.statusCode, 405);
  assert.equal(presentedToken({ headers: { 'x-signal-trigger-token': 'h' }, url: '/?token=q' }, 'x-signal-trigger-token'), 'h', 'the header wins');
  assert.equal(presentedToken({ headers: {}, url: '/?token=q' }, 'x-signal-trigger-token'), 'q');
  assert.equal(presentedToken({ headers: {}, url: '/' }, 'x-signal-trigger-token'), '');
});

test('method page: the byline section renders with and without coverage data', async () => {
  const { bylineSection } = await import('../site/method.js');
  assert.ok(bylineSection(null).includes('PENDING'));
  const html = bylineSection({ summary: { bylines: { rows: 4, withByline: 3, fromFeed: 2, fromArticle: 1, pct: 75, byOutlet: { A: { rows: 4, withByline: 3, fromFeed: 2, fromArticle: 1, pct: 75 } } } } });
  assert.ok(html.includes('3 of 4') && html.includes('75%') && html.includes('<td class="l">A</td>'));
  assert.ok(html.includes('No per-author metric'));
});

test('the current view is assembled from pointer.json, the latest scan and the scans its carried references name; cached per pointer', async () => {
  const { buildLatestView } = await import('../api/_ledger.js');
  const files = {
    'pointer.json': JSON.stringify({ latest: { id: '2026-11-24T02', startedAt: '2026-11-24T02:00:00Z', file: 'scans/2026-11-24/02.json' }, runs: { '2026-11-24T01': 'scans/2026-11-24/01.json', '2026-11-24T02': 'scans/2026-11-24/02.json' } }),
    'scans/2026-11-24/02.json': JSON.stringify({ id: '2026-11-24T02', startedAt: '2026-11-24T02:00:00Z', summary: { n: 'nat' }, packs: { national: { n: 'nat' }, regional: { n: 'reg' } }, views: { national: { scorecards: { cards: [] } }, regional: { scorecards: { cards: [] }, metros: { cards: [] } } }, rows: [{ id: 'a', pack: 'national' }, { id: 'c', pack: 'regional' }], carried: [{ id: 'b', run: '2026-11-24T01' }, { id: 'ghost', run: '2026-11-24T00' }] }),
    'scans/2026-11-24/01.json': JSON.stringify({ id: '2026-11-24T01', rows: [{ id: 'b', pack: 'national' }], carried: [] }),
  };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const key = url.replace(/^.*\/data\//, '').replace(/\?t=\d+$/, '');
    return files[key] ? { ok: true, status: 200, text: async () => files[key] } : { ok: false, status: 404 };
  };
  const env = { VERCEL_GIT_REPO_OWNER: 'O', VERCEL_GIT_REPO_SLUG: 'R' };
  const nat = await buildLatestView({ env, fetch, pack: 'national' });
  assert.equal(nat.ok, true);
  const v = JSON.parse(nat.body);
  assert.deepEqual(v.rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual([v.pack, v.summary.n, v.unresolvedCarried, v.id], ['national', 'nat', 1, '2026-11-24T02']);
  assert.ok(!('rows' in v && 'carried' in v) && !('views' in v) && !('packs' in v), 'the view carries neither the delta bookkeeping nor other packs');
  assert.ok(v.scorecards && !v.metros);
  assert.equal(calls.filter((u) => u.endsWith('/00.json')).length, 0, 'a reference to a run outside the pointer is counted, not fetched');
  const reg = await buildLatestView({ env, fetch, pack: 'regional' });
  const r = JSON.parse(reg.body);
  assert.deepEqual([r.rows.map((x) => x.id), r.summary.n, !!r.metros], [['c'], 'reg', true]);
  const again = await buildLatestView({ env, fetch, pack: 'regional' });
  assert.match(again.source, /instance cache/);
  const missing = await buildLatestView({ env, fetch: async () => ({ ok: false, status: 404 }), pack: 'national' });
  assert.deepEqual([missing.ok, missing.status, missing.reason], [false, 404, 'no run recorded yet (data/pointer.json: upstream HTTP 404)']);
  assert.deepEqual((await buildLatestView({ env, fetch, pack: 'nope' })).status, 404);
});

test('a pack with no prior runs: its first run appears on the next request, nothing cached in between (DEFECTS.md v2-50)', async () => {
  const { buildLatestView, readDataPath } = await import('../api/_ledger.js');
  const files = {
    'pointer.json': JSON.stringify({ latest: { id: '2026-11-24T00', startedAt: '2026-11-24T00:00:00Z', file: 'scans/2026-11-24/00.json' }, runs: { '2026-11-24T00': 'scans/2026-11-24/00.json' } }),
    'scans/2026-11-24/00.json': JSON.stringify({ id: '2026-11-24T00', startedAt: '2026-11-24T00:00:00Z', summary: { n: 'nat' }, packs: { national: { n: 'nat' } }, views: { national: { scorecards: { cards: [] } } }, rows: [{ id: 'a', pack: 'national' }], carried: [] }),
  };
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const key = url.replace(/^.*\/data\//, '').replace(/\?t=\d+$/, '');
    return files[key] ? { ok: true, status: 200, text: async () => files[key] } : { ok: false, status: 404 };
  };
  const env = { VERCEL_GIT_REPO_OWNER: 'O', VERCEL_GIT_REPO_SLUG: 'R' };
  // Before the pack's first run: a 404 that names the reason, from the shared pointer and scan file.
  const before = await buildLatestView({ env, fetch, pack: 'regional' });
  assert.deepEqual([before.ok, before.status, before.reason], [false, 404, 'no run recorded yet for pack regional']);
  assert.ok(urls.some((u) => /\/data\/pointer\.json\?t=\d+$/.test(u)), 'the pointer is read fresh, past the raw CDN copy');
  assert.ok(!urls.some((u) => u.includes('packs/regional')), 'no per-pack pointer is ever looked for');
  const nat = await buildLatestView({ env, fetch, pack: 'national' });
  assert.equal(nat.ok, true);
  // The pack's first run lands: new pointer, new shared scan file with the pack's rows and summary.
  files['pointer.json'] = JSON.stringify({ latest: { id: '2026-11-24T01', startedAt: '2026-11-24T01:00:00Z', file: 'scans/2026-11-24/01.json' }, runs: { '2026-11-24T00': 'scans/2026-11-24/00.json', '2026-11-24T01': 'scans/2026-11-24/01.json' } });
  files['scans/2026-11-24/01.json'] = JSON.stringify({ id: '2026-11-24T01', startedAt: '2026-11-24T01:00:00Z', summary: { n: 'nat' }, packs: { national: { n: 'nat' }, regional: { n: 'reg', rows: { total: 105 } } }, views: { national: { scorecards: { cards: [] } }, regional: { scorecards: { cards: [] }, metros: { cards: [] } } }, rows: Array.from({ length: 105 }, (_, i) => ({ id: `r${i}`, pack: 'regional' })), carried: [{ id: 'a', run: '2026-11-24T00' }] });
  const after = await buildLatestView({ env, fetch, pack: 'regional' });
  assert.equal(after.ok, true, 'the very next request succeeds');
  const v = JSON.parse(after.body);
  assert.deepEqual([v.pack, v.rows.length, v.summary.n, !!v.metros, v.unresolvedCarried], ['regional', 105, 'reg', true, 0]);
  const natAfter = JSON.parse((await buildLatestView({ env, fetch, pack: 'national' })).body);
  assert.deepEqual(natAfter.rows.map((r) => r.id), ['a'], 'the carried national row resolves from the shared scan file');
  // Local reads name the path that failed too.
  const missing = await readDataPath('packs/regional/latest.json', { env: { SIGNAL_DATA_LOCAL: '1', SIGNAL_DATA_DIR: 'data' } });
  assert.deepEqual([missing.ok, missing.status, missing.reason], [false, 404, 'data/packs/regional/latest.json: not found on disk']);
});
