#!/usr/bin/env node
// run-batch.js — drive PER-PR AI change-impact analysis across all projects.
//
//   node flowmap-ai/run-batch.js [options]
//     --server <url>     AI-model API base (default http://localhost:8790)
//     --only <substr>    only projects whose impact path contains <substr>
//     --pr <number>      only this PR number (use with --only)
//     --force            re-analyze even if the per-PR result file exists
//     --dry-run          build context + prompt, but don't call the model
//     --rebuild-index    rescan .repo clones before running
//     --model <id>       pass a model id to the AI server
//
// For each <base>.impact.json it iterates the project's PRs and, per PR, writes
// <base>.AI분석결과/<PR번호>.md (Korean). Already-analyzed PRs (file exists) are
// skipped. The local repo is resolved via the location index so the model can
// read full source around each diff.

import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildRepoIndex, resolveRepo } from './lib/repo-index.js';
import { listPrNumbers, buildPrContext } from './lib/context.js';
import { renderPrompt, SYSTEM_PROMPT } from './lib/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const flowmapRoot = path.resolve(here, '..');
const dataRoot = path.join(flowmapRoot, 'web', 'data', 'projects');
const indexFile = path.join(here, 'repo-locations.json');
// 결과는 <base>.AI분석결과/<PR번호>.md (pulls 샤드 디렉토리와 대칭).
const RESULT_DIR_SUFFIX = '.AI분석결과';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const server = opt('--server', process.env.FLOWMAP_AI_SERVER || 'http://localhost:8790');
const only = opt('--only', null);
const onlyPr = opt('--pr', null);
const force = flag('--force');
const dryRun = flag('--dry-run');
const model = opt('--model', null);

/** Walk dataRoot for *.impact.json → [{dir, baseName, impactFile}]. */
function findTargets(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.impact.json'))
        out.push({ dir, baseName: name.replace(/\.impact\.json$/, ''), impactFile: p });
    }
  };
  walk(root);
  return out;
}

function loadIndex() {
  if (!force && existsSync(indexFile) && !flag('--rebuild-index')) {
    try {
      return JSON.parse(readFileSync(indexFile, 'utf8'));
    } catch {
      /* fall through to rebuild */
    }
  }
  const idx = buildRepoIndex(flowmapRoot);
  writeFileSync(indexFile, JSON.stringify(idx, null, 2));
  return idx;
}

// Plain node:http POST — no client-side timeout (unlike global fetch/undici,
// which aborts at ~300s; analyses with repo exploration routinely run longer).
function callServer(prompt, repoPath) {
  const payload = JSON.stringify({ prompt, system: SYSTEM_PROMPT, repoPath, model });
  const u = new URL(`${server}/analyze`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data || '{}');
          } catch {
            return reject(new Error(`bad response (HTTP ${res.statusCode}): ${data.slice(0, 300)}`));
          }
          if (res.statusCode !== 200) reject(new Error(body.error || `HTTP ${res.statusCode}`));
          else resolve(body);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(0); // disable socket inactivity timeout
    req.write(payload);
    req.end();
  });
}

async function main() {
  const index = loadIndex();
  let targets = findTargets(dataRoot);
  if (only) targets = targets.filter((t) => t.impactFile.includes(only));

  let done = 0,
    skipped = 0,
    failed = 0,
    totalPrs = 0;

  for (const t of targets) {
    const rel = path.relative(flowmapRoot, t.impactFile);
    let prNumbers;
    try {
      prNumbers = listPrNumbers(t.dir, t.baseName);
    } catch (e) {
      console.log(`FAIL  ${rel}  (pulls: ${e.message})`);
      failed++;
      continue;
    }
    if (onlyPr != null) prNumbers = prNumbers.filter((n) => String(n) === String(onlyPr));
    if (!prNumbers.length) {
      console.log(`SKIP  ${rel}  (분석할 PR 없음)`);
      skipped++;
      continue;
    }

    const resultDir = path.join(t.dir, `${t.baseName}${RESULT_DIR_SUFFIX}`);
    // repo 는 프로젝트 단위 1회 해석 — 소스 인라인(옵션 2)을 위해 PR 컨텍스트 빌드 전에 필요.
    let repoUrl = null;
    try {
      repoUrl = JSON.parse(readFileSync(t.impactFile, 'utf8')).repoUrl || null;
    } catch {
      /* ignore */
    }
    const repo = resolveRepo(index, repoUrl, t.baseName);
    const repoPath = repo?.localPath || null;

    for (const prNumber of prNumbers) {
      totalPrs++;
      const resultFile = path.join(resultDir, `${prNumber}.md`);
      const rrel = path.relative(flowmapRoot, resultFile);
      if (!force && existsSync(resultFile)) {
        console.log(`SKIP  ${rrel}  (결과 존재)`);
        skipped++;
        continue;
      }

      let context;
      try {
        context = buildPrContext(t.dir, t.baseName, prNumber, repoPath);
      } catch (e) {
        console.log(`FAIL  ${rrel}  (context: ${e.message})`);
        failed++;
        continue;
      }
      if (!context) {
        console.log(`SKIP  ${rrel}  (PR 인덱스에 없음)`);
        skipped++;
        continue;
      }

      const prompt = renderPrompt(context);
      console.log(
        `ANALYZE ${t.baseName} #${prNumber}  files=${context.pr.files.length}  repo=${
          repoPath ? path.relative(flowmapRoot, repoPath) : 'UNRESOLVED (diffs only)'
        }  prompt=${(prompt.length / 1024).toFixed(0)}KB`,
      );
      if (dryRun) {
        done++;
        continue;
      }

      try {
        const { markdown, durationMs } = await callServer(prompt, repoPath);
        if (!markdown) throw new Error('empty model response');
        // 모델이 제목 앞에 붙일 수 있는 서두 제거.
        const h = markdown.search(/^#\s+AI 영향도 분석/m);
        const clean = h > 0 ? markdown.slice(h) : markdown;
        const header = `<!-- generated by flowmap-ai (local claude CLI) · repo: ${
          repoPath || 'unresolved'
        } -->\n\n`;
        mkdirSync(resultDir, { recursive: true });
        writeFileSync(resultFile, header + clean + '\n');
        console.log(`  → wrote ${rrel}  (${(durationMs / 1000).toFixed(1)}s)`);
        done++;
      } catch (e) {
        console.log(`  FAIL ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n[flowmap-ai] done=${done} skipped=${skipped} failed=${failed} PR총계=${totalPrs}`);
  if (failed) process.exitCode = 1;
}

main();
