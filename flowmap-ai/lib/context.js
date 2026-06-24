// context.js — assemble the per-PR analysis context fed to the AI model.
//
// Pulls together, for one PR of one project:
//   - impact.json   : per-PR impacted endpoints + deleted/breaking endpoints
//   - pulls.json    : per-PR metadata, pointing at the per-PR diff file
//   - <pulls>/<n>.json : the actual code diffs (patches)
//   - <name>.json   : the call graph, used to compute the impact subgraph
//
// Patches are truncated to keep the prompt bounded; the local repo (resolved
// separately) lets the model read full context on demand.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadGraph, buildSubgraph } from './graph.js';

const PATCH_CHARS = 5000; // per-file patch cap
const FILES_PER_PR = 40; // files per PR cap
const PR_PATCH_BUDGET = 80000; // overall patch char budget per PR
// 옵션 2 — 주변 소스 인라인(API 모델이 repo 접근 없이도 분석 가능하게):
const SOURCE_CHARS = 7000; // 변경 파일 전체 소스 per-file cap
const SOURCE_BUDGET = 60000; // 변경 파일 소스 총 예산
const RELATED_MAX = 16; // 영향 노드 주변 소스 최대 개수
const RELATED_WINDOW = 14; // 노드 정의 라인 ±N 줄 발췌
const RELATED_BUDGET = 36000; // 주변 소스 총 예산

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n}자 생략]` : s;
}

// node.file / pulls path → 로컬 working-tree 절대경로.
//   node.file 은 `<repoName>/...` 접두사를 가질 수 있어 제거. pulls path 는 이미 repo 상대.
function repoFilePath(repoPath, file) {
  const repoName = path.basename(repoPath);
  let rel = String(file || '').replace(/\\/g, '/');
  if (rel.startsWith(repoName + '/')) rel = rel.slice(repoName.length + 1);
  return path.join(repoPath, rel);
}
function readRepoFile(repoPath, file) {
  try {
    const p = repoFilePath(repoPath, file);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}
// 노드 정의 라인 주변 ±window 줄 발췌(1-based line).
function excerptAround(text, line, window) {
  const lines = text.split('\n');
  const c = Math.max(1, line | 0);
  const from = Math.max(0, c - 1 - window);
  const to = Math.min(lines.length, c + window);
  return lines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`)
    .join('\n');
}

function projectFiles(projectDir, baseName) {
  return {
    impactFile: path.join(projectDir, `${baseName}.impact.json`),
    pullsFile: path.join(projectDir, `${baseName}.pulls.json`),
    graphFile: path.join(projectDir, `${baseName}.json`),
  };
}

/** PR numbers (in index order) for a project, or [] if no pulls index. */
export function listPrNumbers(projectDir, baseName) {
  const { pullsFile } = projectFiles(projectDir, baseName);
  if (!existsSync(pullsFile)) return [];
  return (readJson(pullsFile).pulls || []).map((p) => p.number);
}

// Build one PR's `pull` object (files + subgraph), with its own patch budget.
// repoPath(있으면) 로 변경 파일 전체 소스 + 영향 노드 주변 소스를 인라인(옵션 2).
function buildPull(meta, projectDir, graph, impactedEndpoints, deletedForPr, repoPath) {
  const deletedCount = (deletedForPr || []).length;
  const breakingCount = (deletedForPr || []).filter((d) => d.breaking).length;
  const detailPath = meta.file ? path.join(projectDir, meta.file) : null;
  let budget = PR_PATCH_BUDGET;
  let srcBudget = SOURCE_BUDGET;
  let files = [];
  if (detailPath && existsSync(detailPath)) {
    const detail = readJson(detailPath);
    files = (detail.files || []).slice(0, FILES_PER_PR).map((f) => {
      const cap = Math.min(PATCH_CHARS, Math.max(0, budget));
      const patch = truncate(f.patch || '', cap);
      budget -= (patch || '').length;
      const out = {
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        previousPath: f.previousPath || undefined,
        patch: patch || undefined,
      };
      // 변경 파일 전체 소스(working tree) 인라인 — diff 주변 맥락. (삭제 파일 제외)
      if (repoPath && srcBudget > 0 && f.status !== 'removed') {
        const full = readRepoFile(repoPath, f.path);
        if (full) {
          const s = truncate(full, Math.min(SOURCE_CHARS, srcBudget));
          srcBudget -= s.length;
          out.source = s;
        }
      }
      return out;
    });
  }
  const changedPaths = files.map((f) => f.path);
  const subgraph = graph ? buildSubgraph(graph, changedPaths) : null;

  // 영향 노드 주변 소스(옵션 2): upstream 엔드포인트 + downstream 외부호출 지점 + 변경 노드의
  //   정의 라인 ±N 줄 발췌. repo 접근 없는 API 모델에 실제 시그니처/호출부를 제공.
  let relatedSources;
  if (repoPath && subgraph) {
    const cand = [
      ...(subgraph.upstreamEndpoints || []),
      ...(subgraph.downstreamExternals || []),
      ...(subgraph.changedNodes || []),
    ].filter((n) => n && n.file && n.line);
    const seen = new Set();
    let relBudget = RELATED_BUDGET;
    relatedSources = [];
    for (const n of cand) {
      if (relatedSources.length >= RELATED_MAX || relBudget <= 0) break;
      const key = n.file + ':' + n.line;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = readRepoFile(repoPath, n.file);
      if (!text) continue;
      const ex = truncate(excerptAround(text, n.line, RELATED_WINDOW), Math.max(0, relBudget));
      relBudget -= ex.length;
      relatedSources.push({ id: n.id, file: n.file, line: n.line, excerpt: ex });
    }
    if (!relatedSources.length) relatedSources = undefined;
  }
  const eps = impactedEndpoints || [];
  // 정량 지표(템플릿) — 모델이 그대로 전사하도록 미리 계산해 일관성 보장.
  const metrics = {
    changedFiles: meta.changedFiles ?? files.length,
    additions: meta.additions ?? null,
    deletions: meta.deletions ?? null,
    changedNodeCount: subgraph ? subgraph.changedNodeCount : null,
    impactedEndpointCount: eps.length,
    upstreamEndpointCount: subgraph ? subgraph.upstreamEndpointCount : null,
    downstreamExternalCount: subgraph ? subgraph.downstreamExternalCount : null,
    deletedEndpointCount: deletedCount,
    breakingDeletionCount: breakingCount,
    edgeKindsTouched: subgraph ? subgraph.edgeKindsTouched : [],
  };
  return {
    number: meta.number,
    title: meta.title,
    author: meta.author,
    mergedAt: meta.mergedAt,
    url: meta.url,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
    impactedEndpoints: eps,
    files,
    subgraph,
    relatedSources,
    metrics,
  };
}

/**
 * Build the analysis context for a single PR.
 * @param {string} projectDir absolute dir holding <base>.impact.json etc.
 * @param {string} baseName   per-root file prefix (e.g. "tera-cloud-user")
 * @param {number|string} prNumber
 * @returns {object|null} null if the PR is not in the pulls index
 */
export function buildPrContext(projectDir, baseName, prNumber, repoPath) {
  const { impactFile, pullsFile, graphFile } = projectFiles(projectDir, baseName);
  const impact = readJson(impactFile);
  const pullsIdx = existsSync(pullsFile) ? readJson(pullsFile) : { pulls: [] };
  const graph = existsSync(graphFile) ? loadGraph(graphFile) : null;

  const meta = (pullsIdx.pulls || []).find((p) => String(p.number) === String(prNumber));
  if (!meta) return null;

  // 이 PR 에서 제거된 엔드포인트만 필터.
  const deletedEndpoints = (impact.deletedEndpoints || []).filter(
    (d) => Array.isArray(d.removedInPulls) && d.removedInPulls.map(String).includes(String(prNumber)),
  );

  const imp = (impact.pulls || []).find((p) => String(p.number) === String(prNumber)) || {};
  const pr = buildPull(meta, projectDir, graph, imp.impactedEndpoints, deletedEndpoints, repoPath);

  return {
    project: baseName,
    repoUrl: impact.repoUrl || pullsIdx.repoUrl || null,
    base: impact.base || pullsIdx.base || null,
    pr,
    deletedEndpoints,
    graphPresent: !!graph,
  };
}
