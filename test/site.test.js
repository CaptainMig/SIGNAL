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

test('ledger access serves only the three allowed files', async () => {
  assert.deepEqual(Object.keys(ALLOWED), ['latest', 'history', 'aggregate', 'stats', 'daily']);
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
  const remote = await readLedgerFile('latest', { env, fetch });
  assert.equal(remote.ok, true);
  assert.equal(remote.source, 'github');
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/Owner/Repo/main/data/latest.json');
  assert.equal(calls[0].auth, 'token secret');

  const anon = await readLedgerFile('history', { env: {}, fetch: async () => ({ ok: false, status: 404 }) });
  assert.deepEqual([anon.ok, anon.status], [false, 404]);
  assert.match(anon.reason, /private repository needs GITHUB_TOKEN/);
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
