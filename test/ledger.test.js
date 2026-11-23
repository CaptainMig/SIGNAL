import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HISTORY_COLUMNS, appendHistory, csvEscape, ledgerPaths, readRecentScans, scanPathFor, toCsvLine, writeLatest, writeScan } from '../pipeline/ledger.js';

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

test('writeLatest overwrites in place', async () => {
  const root = await tmp();
  await writeLatest(run('2026-11-23T04:00:00.000Z'), [{ id: 'x' }], { root });
  await writeLatest(run('2026-11-23T05:00:00.000Z'), [{ id: 'y' }], { root });
  const latest = JSON.parse(await fs.readFile(ledgerPaths(root).latest, 'utf8'));
  assert.equal(latest.rows[0].id, 'y');
});
