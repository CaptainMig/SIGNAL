// ---------------------------------------------------------------------------
// robots.txt, honoured before every article fetch.
//
// Signal fetches with one honest user agent that names it (config
// USER_AGENT, product token "Signal") and a contact URL. A publisher that
// disallows that token, or every agent, for the article's path is not
// fetched: the row is SOURCE BLOCKED (robots.txt) and scored headline-only.
// A robots.txt the publisher refuses to serve us (401/403/451) counts as a
// refusal too. A missing robots.txt (404/410) allows everything; a server
// error or a timeout is transient and the row is retried next run.
//
// Matching follows RFC 9309: the group for our token wins over the "*"
// group; within a group the longest matching rule wins and Allow wins a
// tie; "*" and "$" in paths are honoured. One robots.txt fetch per host per
// run (the checker caches).
// ---------------------------------------------------------------------------
import { ROBOTS_TIMEOUT_MS, USER_AGENT } from './config.js';

export const ROBOTS_TOKEN = 'signal';

// Parse into [{ agents: [lowercase tokens], rules: [{ type, path }] }].
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (!cur) {
        cur = { agents: ['*'], rules: [] };
        groups.push(cur);
      }
      cur.rules.push({ type: key, path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegExp(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

// The group that applies to our token: an exact or product-token match,
// else "*". No group at all means everything is allowed.
export function groupFor(groups, token = ROBOTS_TOKEN) {
  const t = String(token).toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a === t || a.startsWith(`${t}/`) || a.startsWith(`${t} `)));
  if (own.length) return { agents: own.flatMap((g) => g.agents), rules: own.flatMap((g) => g.rules) };
  const star = groups.filter((g) => g.agents.includes('*'));
  if (star.length) return { agents: ['*'], rules: star.flatMap((g) => g.rules) };
  return null;
}

/** True when `path` may be fetched under this robots.txt by our token. */
export function isAllowed(robotsText, path, token = ROBOTS_TOKEN) {
  const group = groupFor(parseRobots(robotsText), token);
  if (!group) return true;
  const p = String(path || '/');
  let best = null;
  for (const rule of group.rules) {
    if (!rule.path) {
      // "Disallow:" with no path allows everything; it never outranks a match.
      continue;
    }
    if (!patternToRegExp(rule.path).test(p)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.type === 'allow' && best.type === 'disallow')) best = { len, type: rule.type };
  }
  return !best || best.type === 'allow';
}

/**
 * A per-run checker: fetches each host's robots.txt once and answers
 * { allowed: true } or { allowed: false, reason, detail }. Never throws.
 */
export function createRobotsChecker({ fetch = globalThis.fetch, userAgent = USER_AGENT, token = ROBOTS_TOKEN, timeoutMs = ROBOTS_TIMEOUT_MS } = {}) {
  const cache = new Map();
  async function load(origin) {
    if (cache.has(origin)) return cache.get(origin);
    const p = (async () => {
      let res;
      try {
        res = await fetch(`${origin}/robots.txt`, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': userAgent, Accept: 'text/plain,*/*;q=0.8' } });
      } catch (e) {
        return { state: 'unavailable', detail: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'robots.txt timeout' : `robots.txt ${e?.message || 'unreachable'}` };
      }
      if (res.status === 401 || res.status === 403 || res.status === 451) return { state: 'refused', detail: `robots.txt refused (HTTP ${res.status})` };
      if (res.status === 404 || res.status === 410) return { state: 'absent' };
      if (res.status >= 500) return { state: 'unavailable', detail: `robots.txt HTTP ${res.status}` };
      if (res.status < 200 || res.status >= 300) return { state: 'absent' };
      try {
        return { state: 'present', text: await res.text() };
      } catch {
        return { state: 'unavailable', detail: 'robots.txt read error' };
      }
    })();
    cache.set(origin, p);
    return p;
  }
  return {
    async check(url) {
      let u;
      try {
        u = new URL(url);
      } catch {
        return { allowed: false, reason: 'error', detail: 'invalid url' };
      }
      const r = await load(u.origin);
      if (r.state === 'absent') return { allowed: true };
      if (r.state === 'refused') return { allowed: false, reason: 'blocked', detail: r.detail };
      if (r.state === 'unavailable') return { allowed: false, reason: 'timeout', detail: r.detail };
      return isAllowed(r.text, u.pathname + u.search, token) ? { allowed: true } : { allowed: false, reason: 'blocked', detail: 'robots.txt disallows' };
    },
    size: () => cache.size,
  };
}
