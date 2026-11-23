#!/usr/bin/env node
// Fails the build if a locked term appears anywhere in the tree: code,
// comments, docs, data. The terms are assembled from fragments so this file
// cannot match itself.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOCKED = [['AM', 'DG'].join(''), ['Clear', ' Channel'].join(''), ['clear', 'channel'].join('')];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const SKIP_FILES = new Set([path.basename(new URL(import.meta.url).pathname)]);

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (!SKIP_FILES.has(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

let hits = 0;
for await (const file of walk('.')) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    continue;
  }
  for (const term of LOCKED) {
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx !== -1) {
      hits++;
      const line = text.slice(0, idx).split('\n').length;
      console.error(`locked term in ${file}:${line}`);
    }
  }
}
if (hits) {
  console.error(`${hits} locked-term hit(s)`);
  process.exit(1);
}
console.log('locked-term scan clean');
