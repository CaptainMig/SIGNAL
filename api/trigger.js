// POST (or GET) /api/trigger — the external scan trigger.
//
// GitHub's own cron for scan.yml never fired for this repository (DEFECTS.md
// v2-30, v2-37), and Vercel Hobby cron jobs run at most once a day, so an
// outside scheduler calls this route hourly and it asks GitHub to start the
// scan workflow (workflow_dispatch). The GitHub cron stays on as a backup;
// the workflow's concurrency group serialises runs and the scan itself skips
// when the previous run started less than SCAN_MIN_GAP_MINUTES ago, so two
// triggers in one hour cannot score twice.
//
// Guard rails: a shared secret (SIGNAL_TRIGGER_TOKEN) is required, so
// visitors cannot start runs; the GitHub token (SIGNAL_GH_TOKEN, a
// fine-grained token with Actions: write on this repository only) never
// leaves the server; no model is called and no key is read here.
import { presentedToken, tokenMatches } from './_auth.js';
import { repoCoordinates } from './_ledger.js';

export const WORKFLOW_FILE = 'scan.yml';

export function createHandler({ env = process.env, fetch = globalThis.fetch } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ ok: false, detail: 'GET or POST' });
    if (!env.SIGNAL_TRIGGER_TOKEN) return res.status(503).json({ ok: false, detail: 'trigger not configured: SIGNAL_TRIGGER_TOKEN is not set' });
    if (!tokenMatches(presentedToken(req, 'x-signal-trigger-token'), env.SIGNAL_TRIGGER_TOKEN)) return res.status(401).json({ ok: false, detail: 'unauthorized' });
    if (!env.SIGNAL_GH_TOKEN) return res.status(503).json({ ok: false, detail: 'trigger not configured: SIGNAL_GH_TOKEN is not set' });
    const { owner, repo, ref } = repoCoordinates(env);
    const force = /^(1|true|yes)$/i.test(String(new URL(req.url || '/', 'http://local').searchParams.get('force') || (req.body && req.body.force) || ''));
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SIGNAL_GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'signal-trigger',
        },
        body: JSON.stringify({ ref, inputs: { force: force ? 'true' : 'false' } }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return res.status(502).json({ ok: false, detail: e?.name === 'TimeoutError' ? 'GitHub API timeout' : `GitHub API: ${e?.message || 'error'}` });
    }
    if (r.status === 204) return res.status(202).json({ ok: true, dispatched: true, workflow: WORKFLOW_FILE, ref, force, at: new Date().toISOString() });
    let detail = '';
    try {
      detail = (await r.text()).slice(0, 200);
    } catch {
      /* no body */
    }
    return res.status(502).json({ ok: false, dispatched: false, detail: `GitHub HTTP ${r.status}${detail ? `: ${detail}` : ''}` });
  };
}

export default createHandler();
