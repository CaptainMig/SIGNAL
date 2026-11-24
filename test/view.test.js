import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCurrentView, currentViewFromDisk, referencedRuns } from '../pipeline/view.js';
import { writePointer, writeScan, scanFileRelative } from '../pipeline/ledger.js';

test('buildCurrentView resolves carried references through the loader, filters by pack, drops delta bookkeeping and other packs', async () => {
  const run = { id: 'r2', startedAt: '2026-11-24T02:00:00Z', summary: { k: 'nat' }, packs: { national: { k: 'nat' }, regional: { k: 'reg' } }, views: { national: { scorecards: { cards: [1] } } }, rows: [{ id: 'a', pack: 'national' }], carried: [{ id: 'b', run: 'r1' }, { id: 'c', run: 'r1' }, { id: 'z', run: 'r0' }] };
  const loads = [];
  const loadRun = async (id) => {
    loads.push(id);
    return id === 'r1' ? { id: 'r1', rows: [{ id: 'b', pack: 'national' }, { id: 'c', pack: 'regional' }] } : null;
  };
  assert.deepEqual(referencedRuns(run), ['r1', 'r0']);
  const v = await buildCurrentView({ run, loadRun, pack: 'national' });
  assert.deepEqual(v.rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual([v.pack, v.summary.k, v.scorecards.cards, v.unresolvedCarried], ['national', 'nat', [1], 1]);
  assert.ok(!('carried' in v) && !('views' in v) && !('packs' in v));
  assert.deepEqual(loads.sort(), ['r0', 'r1'], 'each referenced run is loaded once');
  const r = await buildCurrentView({ run, loadRun, pack: 'regional' });
  assert.deepEqual([r.rows.map((x) => x.id), r.summary.k, r.scorecards], [['c'], 'reg', null]);
});

test('currentViewFromDisk reads pointer.json and the scan files it names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-view-'));
  const r1 = await writeScan({ id: '2026-11-24T01', startedAt: '2026-11-24T01:00:00.000Z', summary: {} }, [{ id: 'b', pack: 'national' }], { root });
  const r2 = await writeScan({ id: '2026-11-24T02', startedAt: '2026-11-24T02:00:00.000Z', summary: { k: 1 }, views: { national: { scorecards: { cards: [] } } } }, { rows: [{ id: 'a', pack: 'national' }], carried: [{ id: 'b', run: '2026-11-24T01' }] }, { root });
  assert.equal(await currentViewFromDisk({ root }), null, 'no pointer yet');
  await writePointer({ latest: { id: '2026-11-24T02', startedAt: '2026-11-24T02:00:00.000Z', file: scanFileRelative(r2, { root }) }, runs: { '2026-11-24T01': scanFileRelative(r1, { root }), '2026-11-24T02': scanFileRelative(r2, { root }) } }, { root });
  const v = await currentViewFromDisk({ root });
  assert.deepEqual(v.rows.map((r) => r.id), ['a', 'b']);
  assert.equal(v.summary.k, 1);
});
