#!/usr/bin/env node
// build-index.js — (re)generate the repoUrl → local-checkout index.
//
//   node flowmap-ai/build-index.js [--out <path>]
//
// Default output: flowmap-ai/repo-locations.json (machine-specific, gitignored).

import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRepoIndex } from './lib/repo-index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const flowmapRoot = path.resolve(here, '..');

const outArg = process.argv.indexOf('--out');
const outFile =
  outArg >= 0 ? process.argv[outArg + 1] : path.join(here, 'repo-locations.json');

const index = buildRepoIndex(flowmapRoot);
const byPath = new Map();
for (const e of index.entries) {
  if (e.key.startsWith('dir:') || !e.key.includes('/')) continue;
  if (!byPath.has(e.localPath)) byPath.set(e.localPath, e);
}
const unique = [...byPath.values()];
writeFileSync(outFile, JSON.stringify(index, null, 2));

console.log(`[flowmap-ai] scanned roots:`);
for (const r of index.generatedFrom) console.log(`  - ${r}`);
console.log(`[flowmap-ai] indexed ${unique.length} repo(s):`);
for (const e of unique) console.log(`  ${e.ownerRepo}  (${e.branch})  → ${e.localPath}`);
console.log(`[flowmap-ai] wrote ${outFile}`);
