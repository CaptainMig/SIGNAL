import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PACK, FEEDS, PACKS, PACK_KEYS, feedsForPack, packOf } from '../pipeline/config.js';
import { ledgerPaths } from '../pipeline/ledger.js';
import { packPath } from '../api/_ledger.js';
import { fileUrl } from '../site/data.js';
import { packView } from '../scripts/scan.js';

test('every feed belongs to exactly one pack; the original 24 are national; regional feeds carry a metro and a coverage reason', () => {
  assert.deepEqual(PACK_KEYS, ['national', 'regional']);
  assert.ok(FEEDS.every((f) => ['business', 'general'].includes(f.scope)), 'every feed carries a scope');
  assert.deepEqual(feedsForPack('national').filter((f) => f.scope === 'business').map((f) => f.outlet), ['CNBC', 'WSJ', 'Fortune', 'Financial Times']);
  assert.equal(feedsForPack('regional').filter((f) => f.scope === 'business').length, 10);
  assert.equal(DEFAULT_PACK, 'national');
  assert.ok(FEEDS.every((f) => PACK_KEYS.includes(f.pack)));
  assert.equal(feedsForPack('national').length, 24);
  const regional = feedsForPack('regional');
  assert.equal(regional.length, 18);
  const metros = PACKS.find((p) => p.key === 'regional').metros;
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
  assert.equal(packOf({ pack: 'regional' }), 'regional');
  assert.equal(packOf({}), 'national');
  assert.equal(packOf(undefined), 'national');
});

test('ledger paths: scan files are shared, every derived file is per pack; the API maps packs to paths; the site asks per pack', () => {
  const nat = ledgerPaths('/r', 'data', 'national');
  const reg = ledgerPaths('/r', 'data', 'regional');
  assert.equal(nat.scans, reg.scans);
  assert.equal(nat.history, '/r/data/history.csv');
  assert.equal(reg.history, '/r/data/packs/regional/history.csv');
  assert.equal(reg.daily, '/r/data/packs/regional/daily.json');
  assert.equal(ledgerPaths('/r').history, nat.history, 'default is national');
  assert.equal(packPath('daily'), 'daily.json');
  assert.equal(packPath('daily', 'national'), 'daily.json');
  assert.equal(packPath('daily', 'regional'), 'packs/regional/daily.json');
  assert.equal(packPath('validation-set', 'regional'), 'validation/set.json', 'the validation set is national only');
  assert.equal(packPath('daily', 'nope'), null);
  assert.equal(packPath('daily', '../etc'), null);
  assert.equal(fileUrl('history'), '/api/data?file=history');
  assert.equal(fileUrl('history', 'regional'), '/api/data?file=history&pack=regional');
  const run = { id: 'r', rows: [{ id: 'a', pack: 'national' }, { id: 'b', pack: 'regional' }, { id: 'c' }] };
  assert.deepEqual(packView(run, 'national').rows.map((r) => r.id), ['a', 'c']);
  assert.deepEqual(packView(run, 'regional').rows.map((r) => r.id), ['b']);
});

test('per-metro scorecards: grouped by metro, gated at n ≥ minN text rows over ≥ minDays days, pack-level pooled rate kept', async () => {
  const { buildScorecards } = await import('../pipeline/scorecards.js');
  const row = (id, metro, day, verdict = 'VERIFIED') => ({ id, outlet: `O-${metro}`, publication: `O-${metro}`, owner: 'o', metro, pubDate: `2026-11-${day}T12:00:00Z`, sweep: { mode: 'sweep' }, fulltext: { verdict }, final: { verdict, fidelity: 8, sens: 2, click: 2, source: 'fulltext' }, escalation: { eligible: false, unresolved: false } });
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push(row(`kc${i}`, 'Kansas City', String(20 + (i % 4)).padStart(2, '0')));
  for (let i = 0; i < 5; i++) rows.push(row(`dc${i}`, 'Washington DC', '21'));
  rows.push({ ...row('x', null, '21'), metro: null });
  const sc = buildScorecards([{ id: 'r', startedAt: '2026-11-23T18:00:00Z', rows }], { groupBy: 'metro', minN: 20, minDays: 3 });
  assert.equal(sc.groupBy, 'metro');
  assert.deepEqual(sc.cards.map((c) => [c.metro, c.ranked, c.nText, c.days]), [['Kansas City', true, 24, 4], ['Washington DC', false, 5, 1]]);
  assert.equal(sc.cards[1].progress, '5 of 20 · 1 of 3 days');
  assert.deepEqual(sc.cards[0].outlets, ['O-Kansas City']);
  assert.equal(sc.pooled.broad.n, 30, 'the pooled rate covers every text row, metro or not: 24 + 5 + 1');
});
