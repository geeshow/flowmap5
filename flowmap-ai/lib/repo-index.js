// repo-index.js — repoUrl → local checkout location index.
//
// impact.json / pulls.json carry `repoUrl` (the GitHub remote) but NOT a local
// filesystem path. Local clones live under each analyzer's `.repo/<dir>` and a
// few fallback roots. This module scans those candidate roots, reads each git
// `origin` remote, and builds a robust repoUrl → {localPath, branch} map keyed
// by the normalized `owner/repo` (so dir-name mismatches — e.g. the nexcore
// monorepo where per-root != repo dir — don't break resolution).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Normalize any git remote URL to a `host/owner/repo` key (lowercased, no .git). */
export function repoKey(url) {
  if (!url) return null;
  let s = String(url).trim().replace(/\.git$/i, '');
  // git@github.com:owner/repo  → github.com/owner/repo
  s = s.replace(/^git@([^:]+):/, '$1/');
  // https://github.com/owner/repo → github.com/owner/repo
  s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@]+@/, '');
  return s.toLowerCase().replace(/\/+$/, '');
}

/** `host/owner/repo` → `owner/repo` (looser key for fallback matching). */
export function ownerRepoKey(url) {
  const k = repoKey(url);
  if (!k) return null;
  const parts = k.split('/');
  return parts.length >= 2 ? parts.slice(-2).join('/') : k;
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir) {
  return existsSync(path.join(dir, '.git'));
}

/** Candidate roots to scan for clones. `flowmapRoot` is the repo top-level. */
export function candidateRoots(flowmapRoot) {
  const roots = [
    path.join(flowmapRoot, 'flowmap-spring', '.repo'),
    path.join(flowmapRoot, 'flowmap-react', '.repo'),
    path.join(flowmapRoot, 'flowmap-nexcore', '.repo'),
  ];
  // Fallback roots for analyzers whose `.repo` is empty (e.g. nexcore monorepo
  // clones living elsewhere). Override / extend with FLOWMAP_REPO_ROOTS (a
  // path-separator-delimited list of parent dirs whose children are clones).
  const extra = (process.env.FLOWMAP_REPO_ROOTS || '')
    .split(path.delimiter)
    .filter(Boolean);
  const defaults = [
    path.join(homedir(), 'study', 'nexcore'),
    path.join(homedir(), 'tera-backend'),
  ];
  return [...roots, ...extra, ...defaults].map((p) => p.replace(/^~(?=\/)/, homedir()));
}

/**
 * Build the repo-location index by scanning candidate roots.
 * @returns {{generatedFrom:string[], entries:Object[]}}
 *   each entry: { key, ownerRepo, repoUrl, branch, localPath, source }
 */
export function buildRepoIndex(flowmapRoot) {
  const seen = new Map(); // key -> entry (first win, but prefer a clone with origin)
  const scanned = [];
  for (const root of candidateRoots(flowmapRoot)) {
    if (!existsSync(root)) continue;
    scanned.push(root);
    let children;
    try {
      children = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of children) {
      const dir = path.join(root, name);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory() || !isGitRepo(dir)) continue;
      const origin = git(dir, ['remote', 'get-url', 'origin']);
      const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const key = repoKey(origin) || `local/${name}`;
      const entry = {
        key,
        ownerRepo: ownerRepoKey(origin) || name,
        repoUrl: origin,
        branch,
        localPath: dir,
        source: root,
      };
      if (!seen.has(key)) seen.set(key, entry);
      // Also index by loose owner/repo and by bare dir name for resilience.
      const loose = entry.ownerRepo;
      if (loose && !seen.has(loose)) seen.set(loose, { ...entry, key: loose });
      if (!seen.has(`dir:${name}`)) seen.set(`dir:${name}`, { ...entry, key: `dir:${name}` });
    }
  }
  return { generatedFrom: scanned, entries: [...seen.values()] };
}

/** Resolve a repoUrl (and optional bare repo dir name) against a built index. */
export function resolveRepo(index, repoUrl, dirName) {
  const byKey = new Map(index.entries.map((e) => [e.key, e]));
  return (
    byKey.get(repoKey(repoUrl)) ||
    byKey.get(ownerRepoKey(repoUrl)) ||
    (dirName ? byKey.get(`dir:${dirName}`) : null) ||
    null
  );
}
