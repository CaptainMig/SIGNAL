import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HISTORY_COLUMNS, STATS_COLUMNS, appendHistory, appendStats, countHistoryRuns, csvEscape, ledgerPaths, readLatest, readRecentScans, resolveRuns, scanPathFor, toCsvLine, writeLatest, writeScan } from '../pipeline/ledger.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'signal-ledger-'));
const run = (startedAt, id = startedAt.slice(0, 13)) => ({ id, startedAt, finishedAt: startedAt, summary: {} });

test('scan path is data/scans/YYYY-MM-DD/HH.json in UTC', async () => {
  const p = scanPathFor('2026-11-23T04:07:00.000Z', ledgerPaths('.'));
  assert.equal(p.dir, path.join('data', 'scans', '2026-11-23'));
  assert.equal(p.file, '04.json');
});

test('writeScan never overwrites: a second run in the same hour gets a suffixed file', async () => {
  const root = await tmp();
  const a = await writeScan(run('2026-11-23T04:07:00.000Z'), [{ id: 'a' }], { root });
  const b = await writeScan(run('2026-11-23T04:40:00.000Z'), [{ id: 'b' }], { root });
  assert.ok(a.endsWith(path.join('2026-11-23', '04.json')));
  assert.ok(b.endsWith(path.join('2026-11-23', '04.2.json')));
  assert.equal(JSON.parse(await fs.readFile(a, 'utf8')).rows[0].id, 'a');
  assert.equal(JSON.parse(await fs.readFile(b, 'utf8')).rows[0].id, 'b');
});

test('history.csv: header on first write, append-only, header mismatch refused', async () => {
  const root = await tmp();
  const rec = Object.fromEntries(HISTORY_COLUMNS.map((c) => [c, c === 'run_id' ? 'r1' : 1]));
  await appendHistory(rec, { root });
  await appendHistory({ ...rec, run_id: 'r2', model: 'a,b' }, { root });
  const text = await fs.readFile(ledgerPaths(root).history, 'utf8');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], HISTORY_COLUMNS.join(','));
  assert.ok(lines[1].startsWith('r1,'));
  assert.ok(lines[2].startsWith('r2,'));
  assert.ok(lines[2].includes('"a,b"'), 'commas are quoted');
  assert.equal(lines[1].split(',').length, HISTORY_COLUMNS.length);

  await fs.writeFile(ledgerPaths(root).history, 'foo,bar\n1,2\n');
  await assert.rejects(appendHistory(rec, { root }), /header does not match/);
  assert.equal(await fs.readFile(ledgerPaths(root).history, 'utf8'), 'foo,bar\n1,2\n', 'refusal leaves the file untouched');
});

test('csv escaping', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a "q" b'), '"a ""q"" b"');
  assert.equal(toCsvLine({ a: 1, b: null }, ['a', 'b', 'c']), '1,,');
});

test('readRecentScans returns runs in the window, newest first, skipping corrupt files', async () => {
  const root = await tmp();
  const now = Date.parse('2026-11-23T12:00:00Z');
  for (const h of ['2026-11-22T10', '2026-11-22T13', '2026-11-23T11', '2026-11-23T12']) {
    await writeScan(run(`${h}:00:00.000Z`), [], { root });
  }
  await writeScan(run('2026-11-23T14:00:00.000Z'), [], { root }); // future (not yet)
  await fs.writeFile(path.join(ledgerPaths(root).scans, '2026-11-23', '09.json'), '{not json');
  const runs = await readRecentScans({ root, now, windowMs: 24 * 3600e3 });
  assert.deepEqual(runs.map((r) => r.id), ['2026-11-23T12', '2026-11-23T11', '2026-11-22T13']);
  assert.deepEqual(await readRecentScans({ root: path.join(root, 'nope'), now }), []);
});

test('writeScan stores a delta: fresh rows plus carried references', async () => {
  const root = await tmp();
  const p = await writeScan(run('2026-11-23T06:00:00.000Z'), { rows: [{ id: 'fresh' }], carried: [{ id: 'old', run: '2026-11-23T04' }] }, { root });
  const file = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.deepEqual(file.rows, [{ id: 'fresh' }]);
  assert.deepEqual(file.carried, [{ id: 'old', run: '2026-11-23T04' }]);
  const q = await writeScan(run('2026-11-23T07:00:00.000Z'), [{ id: 'x' }], { root });
  assert.deepEqual(JSON.parse(await fs.readFile(q, 'utf8')).carried, []);
});

test('resolveRuns expands carried references from the named run, then latest, and counts the unresolvable', () => {
  const a = { id: 'A', rows: [{ id: 'a', writtenIn: 'A' }, { id: 'b', writtenIn: 'A' }], carried: [] };
  const b = { id: 'B', rows: [{ id: 'c', writtenIn: 'B' }], carried: [{ id: 'a', run: 'A' }, { id: 'zz', run: 'OLD' }] };
  const withLatest = resolveRuns([b, a], { latest: { rows: [{ id: 'zz', writtenIn: 'OLD' }] } });
  assert.deepEqual(withLatest[0].rows.map((r) => r.id), ['c', 'a', 'zz']);
  assert.equal(withLatest[0].unresolvedCarried, 0);
  assert.deepEqual(withLatest[1].rows.map((r) => r.id), ['a', 'b']);
  const without = resolveRuns([b, a]);
  assert.deepEqual(without[0].rows.map((r) => r.id), ['c', 'a']);
  assert.equal(without[0].unresolvedCarried, 1, 'never fabricated');
});

test('readLatest returns the full view or null', async () => {
  const root = await tmp();
  assert.equal(await readLatest({ root }), null);
  await writeLatest(run('2026-11-23T04:00:00.000Z'), [{ id: 'x' }], { root });
  assert.equal((await readLatest({ root })).rows[0].id, 'x');
});

test('writeLatest overwrites in place', async () => {
  const root = await tmp();
  await writeLatest(run('2026-11-23T04:00:00.000Z'), [{ id: 'x' }], { root });
  await writeLatest(run('2026-11-23T05:00:00.000Z'), [{ id: 'y' }], { root });
  const latest = JSON.parse(await fs.readFile(ledgerPaths(root).latest, 'utf8'));
  assert.equal(latest.rows[0].id, 'y');
});

test('stats.csv is a second append-only ledger keyed by run_id; run count comes from history.csv', async () => {
  const root = await tmp();
  assert.equal(await countHistoryRuns({ root }), 0);
  const rec = Object.fromEntries(HISTORY_COLUMNS.map((c) => [c, c === 'run_id' ? 'r1' : 1]));
  await appendHistory(rec, { root });
  await appendHistory({ ...rec, run_id: 'r2' }, { root });
  assert.equal(await countHistoryRuns({ root }), 2);
  const st = Object.fromEntries(STATS_COLUMNS.map((c) => [c, c === 'run_id' ? 'r1' : null]));
  await appendStats(st, { root });
  await appendStats({ ...st, run_id: 'r2', fi_strict_low: 33.3 }, { root });
  const text = await fs.readFile(ledgerPaths(root).stats, 'utf8');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines[0], STATS_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.ok(lines[2].startsWith('r2,,33.3,'));
  await fs.writeFile(ledgerPaths(root).stats, 'foo\n');
  await assert.rejects(appendStats(st, { root }), /stats.csv header does not match/);
});
