#!/usr/bin/env node
// Fails the build if a locked term appears as a WHOLE WORD in human-readable
// text anywhere in the tree: code, comments, docs, and the ledger's
// headlines and rationales. The terms are assembled from fragments so this
// file cannot match itself.
//
// Whole word, case-insensitive: an opaque token that happens to contain the
// letters (a Google News article id, a hash) is not the term (DEFECTS.md
// v2-38). In data/ JSON files the link and id fields are skipped entirely,
// because they are never prose; everything else in them is checked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCKED = [['AM', 'DG'].join(''), ['Clear', ' Channel'].join(''), ['clear', 'channel'].join('')];
export const PATTERNS = LOCKED.map((t) => new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?![A-Za-z0-9])`, 'i'));
// Never prose: identifiers and URLs in ledger files.
export const SKIP_KEYS = new Set(['id', 'ids', 'link', 'canonical', 'url', 'urls', 'carriedFrom', 'writtenIn', 'run', 'runId', 'auditSampledIn', 'promptHash', 'promptHashes', 'channelId']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.pdf', '.zip']);
const SKIP_FILES = new Set([path.basename(fileURLToPath(import.meta.url))]);

// Whole-word hits in a text: [{ term index, line }].
export function findLockedTerms(text) {
  const hits = [];
  PATTERNS.forEach((re, i) => {
    const m = re.exec(String(text || ''));
    if (m) hits.push({ term: i, line: String(text).slice(0, m.index).split('\n').length });
  });
  return hits;
}

// Walk a parsed JSON value; skip SKIP_KEYS; report the path of each hit.
export function findInJson(value, { skipKeys = SKIP_KEYS, at = '$' } = {}) {
  const hits = [];
  const visit = (v, p) => {
    if (typeof v === 'string') {
      for (const h of findLockedTerms(v)) hits.push({ term: h.term, path: p });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${p}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (skipKeys.has(k)) continue;
        visit(x, `${p}.${k}`);
      }
    }
  };
  visit(value, at);
  return hits;
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (!SKIP_FILES.has(entry.name) && !SKIP_EXT.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(dir, entry.name);
    }
  }
}

export async function scanTree(root = '.') {
  const problems = [];
  for await (const file of walk(root)) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, file) || file;
    const inData = rel.split(path.sep)[0] === 'data';
    if (inData && rel.endsWith('.json')) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        for (const h of findLockedTerms(text)) problems.push(`${rel}:${h.line}`);
        continue;
      }
      for (const h of findInJson(parsed)) problems.push(`${rel} ${h.path}`);
    } else {
      for (const h of findLockedTerms(text)) problems.push(`${rel}:${h.line}`);
    }
  }
  return problems;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, '/'));
if (invokedDirectly) {
  const problems = await scanTree('.');
  for (const p of problems) console.error(`locked term in ${p}`);
  if (problems.length) {
    console.error(`${problems.length} locked-term hit(s)`);
    process.exit(1);
  }
  console.log('locked-term scan clean');
}
