// Shared test helpers: fixture loading with date substitution, a mock fetch,
// and a mock Anthropic-shaped client.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const NOW = Date.parse('2026-11-23T17:00:00Z');

export function fixture(name, dates = {}) {
  let s = readFileSync(path.join(here, 'fixtures', name), 'utf8');
  const fresh1 = new Date(NOW - 2 * 3600e3).toUTCString();
  const fresh2 = new Date(NOW - 5 * 3600e3).toUTCString();
  const stale1 = new Date(NOW - 30 * 24 * 3600e3).toUTCString();
  s = s.replace(/FRESH_1/g, dates.fresh1 || fresh1).replace(/FRESH_2/g, dates.fresh2 || fresh2).replace(/STALE_1/g, dates.stale1 || stale1);
  return s;
}

// routes: { [urlPrefix]: { status, body } | (url) => ({status, body}) | Error }
export function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    let r = key ? routes[key] : { status: 404, body: '' };
    if (typeof r === 'function') r = r(url);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

// A client whose messages.create returns canned responses. `respond` gets the
// request and returns either a JSON-able score object, a full response, or
// throws.
export function mockClient(respond) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (req) => {
        requests.push(req);
        const out = await respond(req, requests.length);
        if (out && out.content) return out;
        return {
          model: req.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(out) }],
          usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
        };
      },
    },
  };
}

export const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
