import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayGrid, dotRadius, eligibleOutlets, outletTrail, overallTrail, pointHeadlines, trailDays } from '../site/tonedata.js';

function daily() {
  const days = [];
  for (let i = 0; i < 40; i++) {
    const day = `2026-10-${String(15 + i).padStart(2, '0')}`.replace(/2026-10-(3[2-9]|4\d)/, (m, d) => `2026-11-${String(Number(d) - 31).padStart(2, '0')}`);
    days.push({
      day,
      n: 100,
      sens: 2 + (i % 5) / 10,
      click: 2 + (i % 3) / 10,
      rows: 100,
      outlets: { Big: { n: 10, sens: 3, click: 2 }, Small: { n: i % 2, sens: 1, click: 1 } },
      grid: [{ sens: 2, click: 2, n: 3, verdicts: { VERIFIED: 2, CONTEXTUAL: 1 }, dominant: 'VERIFIED', ids: ['a', 'b', 'c'] }],
      models: i < 20 ? ['m1'] : ['m2'],
      promptHashes: ['p'],
      scorerChanged: i === 20,
      titles: i >= 38 ? { a: { t: 'Headline a', o: 'Big', v: 'VERIFIED' } } : undefined,
    });
  }
  return { days };
}

test('trail is the last 30 days with ages and scorer-change markers', () => {
  const d = daily();
  assert.equal(trailDays(d).length, 30);
  const t = overallTrail(d);
  assert.equal(t.length, 30);
  assert.equal(t[0].age, 29);
  assert.equal(t[29].age, 0);
  assert.equal(t.filter((p) => p.scorerChanged).length, 1);
  assert.equal(t.find((p) => p.scorerChanged).models[0], 'm2');
});

test('eligible outlets need at least 20 rows in the window; outlet trails skip days without a centroid', () => {
  const d = daily();
  assert.deepEqual(eligibleOutlets(d), [{ outlet: 'Big', rows: 300 }]);
  assert.equal(eligibleOutlets(d, { minRows: 10 }).length, 2);
  assert.equal(outletTrail(d, 'Big').length, 30);
  assert.equal(outletTrail(d, 'Nope').length, 0);
});

test('day grid, dot radius, and headlines for a tapped point', () => {
  const d = daily();
  const last = d.days[39].day;
  const g = dayGrid(d, last);
  assert.equal(g.grid.length, 1);
  assert.ok(g.titles);
  assert.deepEqual(dayGrid(d, '1999-01-01'), { day: '1999-01-01', grid: [], titles: null, n: 0 });
  assert.ok(dotRadius(1) < dotRadius(4) && dotRadius(4) < dotRadius(100));
  assert.equal(dotRadius(100000), 14);
  const latest = [{ id: 'b', title: 'Headline b', publication: 'Big', final: { verdict: 'CONTEXTUAL' } }];
  const h = pointHeadlines(g.grid[0], g.titles, latest);
  assert.deepEqual(h.items.map((x) => x.id), ['a', 'b']);
  assert.equal(h.items[1].verdict, 'CONTEXTUAL');
  assert.equal(h.unknown, 1, 'id c is neither titled nor in the current view');
  assert.equal(h.more, 0);
  assert.equal(pointHeadlines({ n: 60, ids: ['a'] }, g.titles, []).more, 59);
});
