#!/usr/bin/env node
// Draw the human validation set from the ledger (DEFECTS.md v2-21).
//
//   node scripts/build-validation-set.js [--days 30] [--size 100] [--version N] [--seed S] [--root DIR]
//
// Writes data/validation/set.json (served to reviewers, no scores),
// data/validation/set-v<N>.json (archive) and
// data/validation/model-labels-v<N>.json (never served). Refuses to
// overwrite an existing version: a new draw is a new version.
import { promises as fs } from 'node:fs';
import { readRecentScans, resolveRuns } from '../pipeline/ledger.js';
import { drawValidationSet, validationPaths, refreshAgreement } from '../pipeline/validation.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const root = String(arg('--root', '.'));
const days = Number(arg('--days', 30)) || 30;
const size = Number(arg('--size', 100)) || 100;
const version = Number(arg('--version', 1)) || 1;
const seed = String(arg('--seed', `v${version}`));

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const paths = validationPaths(root);
if (await exists(paths.versioned(version))) {
  console.error(`[signal] validation set v${version} already exists; pass --version ${version + 1} for a new draw`);
  process.exit(1);
}
const now = Date.now();
const runs = resolveRuns(await readRecentScans({ root, now, windowMs: days * 86400e3 }));
const { set, modelLabels, shortfall, strata } = drawValidationSet(runs, { size, seed, version });
await fs.mkdir(paths.base, { recursive: true });
await fs.writeFile(paths.versioned(version), JSON.stringify(set, null, 2) + '\n');
await fs.writeFile(paths.set, JSON.stringify(set, null, 2) + '\n');
await fs.writeFile(paths.modelLabels(version), JSON.stringify(modelLabels, null, 2) + '\n');
await refreshAgreement({ root });
console.log(`[signal] validation set v${version}: ${set.size} of ${size} items from ${runs.length} runs over ${days} days${shortfall ? ` (shortfall ${shortfall})` : ''}`);
for (const s of strata) console.log(`  ${s.stratum.padEnd(24)} candidates ${String(s.candidates).padStart(4)}  taken ${s.taken}`);
console.log(`[signal] wrote ${paths.set}, ${paths.versioned(version)}, ${paths.modelLabels(version)} (not served)`);
