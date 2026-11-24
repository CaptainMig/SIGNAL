import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PACK, FEEDS, PACKS, PACK_KEYS, feedsForPack, packOf } from '../pipeline/config.js';
import { ledgerPaths } from '../pipeline/ledger.js';
import { packPath } from '../api/_ledger.js';
import { fileUrl } from '../site/data.js';
import { packView } from '../scripts/scan.js';

test('every feed belongs to exactly one pack; the original 24 are national; regional feeds carry a metro and a coverage reason', () => {
  assert.deepEqual(PACK_KEYS, ['national', 'regional-business']);
  assert.equal(DEFAULT_PACK, 'national');
  assert.ok(FEEDS.every((f) => PACK_KEYS.includes(f.pack)));
  assert.equal(feedsForPack('national').length, 24);
  const regional = feedsForPack('regional-business');
  assert.equal(regional.length, 18);
  const metros = PACKS.find((p) => p.key === 'regional-business').metros;
  assert.deepEqual(metros, ['Washington DC', 'Baltimore', 'New York', 'Kansas City']);
  for (const f of regional) {
    assert.ok(metros.includes(f.metro), `${f.name} has a metro`);
    assert.ok(['full-text', 'headline-only'].includes(f.coverage), `${f.name} has a coverage type`);
    assert.ok(f.coverageReason, `${f.name} has a reason`);
    assert.equal(f.coverage === 'headline-only', !!f.thinBody, `${f.name}: headline-only feeds are tone-only (thinBody)`);
  }
  // One Business Journals feed per metro, headline-only, through Google News.
  for (const m of metros) {
    const bj = regional.filter((f) => f.metro === m && /Business Journal/.test(f.name));
    assert.equal(bj.length, 1, `${m} has one Business Journals feed`);
    assert.ok(bj[0].thinBody && /news\.google\.com/.test(bj[0].url));
    assert.ok(regional.filter((f) => f.metro === m && f.coverage === 'full-text').length >= 1, `${m} has at least one full-text source`);
  }
  assert.equal(packOf({ pack: 'regional-business' }), 'regional-business');
  assert.equal(packOf({}), 'national');
  assert.equal(packOf(undefined), 'national');
});

test('ledger paths: scan files are shared, every derived file is per pack; the API maps packs to paths; the site asks per pack', () => {
  const nat = ledgerPaths('/r', 'data', 'national');
  const reg = ledgerPaths('/r', 'data', 'regional-business');
  assert.equal(nat.scans, reg.scans);
  assert.equal(nat.history, '/r/data/history.csv');
  assert.equal(reg.history, '/r/data/packs/regional-business/history.csv');
  assert.equal(reg.latest, '/r/data/packs/regional-business/latest.json');
  assert.equal(reg.daily, '/r/data/packs/regional-business/daily.json');
  assert.equal(ledgerPaths('/r').history, nat.history, 'default is national');
  assert.equal(packPath('latest'), 'latest.json');
  assert.equal(packPath('latest', 'national'), 'latest.json');
  assert.equal(packPath('latest', 'regional-business'), 'packs/regional-business/latest.json');
  assert.equal(packPath('validation-set', 'regional-business'), 'validation/set.json', 'the validation set is national only');
  assert.equal(packPath('latest', 'nope'), null);
  assert.equal(packPath('latest', '../etc'), null);
  assert.equal(fileUrl('history'), '/api/data?file=history');
  assert.equal(fileUrl('history', 'regional-business'), '/api/data?file=history&pack=regional-business');
  const run = { id: 'r', rows: [{ id: 'a', pack: 'national' }, { id: 'b', pack: 'regional-business' }, { id: 'c' }] };
  assert.deepEqual(packView(run, 'national').rows.map((r) => r.id), ['a', 'c']);
  assert.deepEqual(packView(run, 'regional-business').rows.map((r) => r.id), ['b']);
});
