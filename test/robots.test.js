import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRobotsChecker, groupFor, isAllowed, parseRobots } from '../pipeline/robots.js';

test('parseRobots: groups, comments, blank disallow; the Signal group wins over *, else *', () => {
  const txt = `# comment
User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /search
Allow: /search/help

User-agent: Signal
Disallow: /premium/
`;
  const groups = parseRobots(txt);
  assert.equal(groups.length, 3);
  assert.deepEqual(groupFor(groups, 'signal').rules, [{ type: 'disallow', path: '/premium/' }]);
  assert.deepEqual(groupFor(groups, 'other').agents, ['*']);
  assert.equal(groupFor(parseRobots('User-agent: GPTBot\nDisallow: /\n'), 'signal'), null, 'no group for us and no * means everything is allowed');
});

test('isAllowed: longest match wins, Allow wins a tie, wildcards and anchors, AI-agent groups do not bind Signal', () => {
  const txt = `User-agent: *\nDisallow: /search\nAllow: /search/help\nDisallow: /*.pdf$\nDisallow: /private*\n`;
  assert.equal(isAllowed(txt, '/news/story'), true);
  assert.equal(isAllowed(txt, '/search?q=x'), false);
  assert.equal(isAllowed(txt, '/search/help'), true);
  assert.equal(isAllowed(txt, '/files/a.pdf'), false);
  assert.equal(isAllowed(txt, '/files/a.pdfx'), true);
  assert.equal(isAllowed(txt, '/private-notes'), false);
  assert.equal(isAllowed('User-agent: ClaudeBot\nDisallow: /\nUser-agent: anthropic-ai\nDisallow: /\n', '/news/x'), true, 'named AI agents are not Signal');
  assert.equal(isAllowed('User-agent: *\nDisallow: /\n', '/news/x'), false, 'everyone disallowed');
  assert.equal(isAllowed('User-agent: *\nDisallow:\n', '/news/x'), true, 'an empty Disallow allows');
  assert.equal(isAllowed('User-agent: Signal/2\nDisallow: /\n', '/news/x'), false, 'a product token with a version still names us');
  assert.equal(isAllowed('User-agent: *\nAllow: /news/\nDisallow: /news\n', '/news/x'), true, 'Allow wins the tie at equal length (/news/ vs /news: longer wins, then allow)');
});

test('createRobotsChecker: one fetch per host, cached; refused 403 is blocked; 404 allows; 5xx and timeouts are transient', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://ok.example/')) return { status: 200, text: async () => 'User-agent: *\nDisallow: /no/\n' };
    if (url.startsWith('https://refuses.example/')) return { status: 403, text: async () => '' };
    if (url.startsWith('https://none.example/')) return { status: 404, text: async () => '' };
    if (url.startsWith('https://down.example/')) return { status: 503, text: async () => '' };
    throw Object.assign(new Error('x'), { name: 'TimeoutError' });
  };
  const c = createRobotsChecker({ fetch, userAgent: 'Signal/2 test' });
  assert.deepEqual(await c.check('https://ok.example/news/1'), { allowed: true });
  assert.deepEqual(await c.check('https://ok.example/no/1'), { allowed: false, reason: 'blocked', detail: 'robots.txt disallows' });
  assert.equal(calls.filter((u) => u.startsWith('https://ok.example/')).length, 1, 'cached per host');
  assert.deepEqual(await c.check('https://refuses.example/a'), { allowed: false, reason: 'blocked', detail: 'robots.txt refused (HTTP 403)' });
  assert.deepEqual(await c.check('https://none.example/a'), { allowed: true });
  assert.deepEqual(await c.check('https://down.example/a'), { allowed: false, reason: 'timeout', detail: 'robots.txt HTTP 503' });
  assert.deepEqual(await c.check('https://slow.example/a'), { allowed: false, reason: 'timeout', detail: 'robots.txt timeout' });
  assert.deepEqual(await c.check('not a url'), { allowed: false, reason: 'error', detail: 'invalid url' });
  assert.equal(c.size(), 5);
});
