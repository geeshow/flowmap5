#!/usr/bin/env node
// 데이터 계약 검증: web/data/*.json
// 사용법: node tests/check-data.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'web', 'data');

let failCount = 0;
const pass = (msg) => console.log(`✅ ${msg}`);
const fail = (msg) => { failCount++; console.log(`❌ ${msg}`); };
const info = (msg) => console.log(`   ${msg}`);

function loadJson(name) {
  const p = join(DATA, name);
  if (!existsSync(p)) return { exists: false, data: null };
  try {
    return { exists: true, data: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    fail(`${name}: JSON 파싱 실패 — ${e.message}`);
    return { exists: true, data: null };
  }
}

// ─────────────────────────────────────────────
// 1. graph.json
// ─────────────────────────────────────────────
console.log('\n=== 1. graph.json ===');
const VALID_KINDS = new Set(['internal', 'external', 's2s', 'batch', 'resource']);
const { exists: graphExists, data: graph } = loadJson('graph.json');
const nodeIds = new Set();
let nodes = [], edges = [];

if (!graphExists) {
  fail('graph.json 파일 없음');
} else if (graph) {
  pass('graph.json: valid JSON');

  if (Array.isArray(graph.meta?.projects)) {
    pass(`meta.projects 배열 존재 (${graph.meta.projects.length}개 프로젝트)`);
  } else {
    fail('meta.projects 배열 없음');
  }

  if (Array.isArray(graph.nodes)) { nodes = graph.nodes; pass(`nodes 배열 존재 (${nodes.length}개)`); }
  else fail('nodes 배열 없음');
  if (Array.isArray(graph.edges)) { edges = graph.edges; pass(`edges 배열 존재 (${edges.length}개)`); }
  else fail('edges 배열 없음');

  // 노드 id/layer 검증
  const badNodes = [];
  for (const n of nodes) {
    if (!n.id || !n.layer) badNodes.push(n.id ?? JSON.stringify(n).slice(0, 80));
    if (n.id) nodeIds.add(n.id);
  }
  if (badNodes.length === 0) pass(`모든 노드(${nodes.length})에 id/layer 존재`);
  else {
    fail(`id 또는 layer 누락 노드 ${badNodes.length}건`);
    badNodes.slice(0, 10).forEach((id) => info(`- ${id}`));
  }

  // 중복 id
  if (nodeIds.size !== nodes.length) fail(`중복 노드 id 존재 (고유 ${nodeIds.size} / 전체 ${nodes.length})`);

  // 엣지 source/target 검증
  const broken = [];
  const badKinds = [];
  for (const e of edges) {
    if (!nodeIds.has(e.source)) broken.push(`source 미존재: ${e.source} → ${e.target}`);
    if (!nodeIds.has(e.target)) broken.push(`target 미존재: ${e.source} → ${e.target}`);
    if (!VALID_KINDS.has(e.kind)) badKinds.push(`kind=${JSON.stringify(e.kind)} (${e.source} → ${e.target})`);
  }
  if (broken.length === 0) pass(`끊긴 엣지 0건 (엣지 ${edges.length}개 전수 검사)`);
  else {
    fail(`끊긴 엣지 ${broken.length}건`);
    broken.slice(0, 10).forEach((b) => info(`- ${b}`));
  }
  if (badKinds.length === 0) pass('모든 엣지 kind ∈ {internal,external,s2s,batch,resource}');
  else {
    fail(`유효하지 않은 kind ${badKinds.length}건`);
    badKinds.slice(0, 10).forEach((b) => info(`- ${b}`));
  }

  // meta 카운트와 실제 수 대조 (참고용)
  if (graph.meta?.nodes != null && graph.meta.nodes !== nodes.length)
    fail(`meta.nodes(${graph.meta.nodes}) ≠ 실제 노드 수(${nodes.length})`);
  if (graph.meta?.edges != null && graph.meta.edges !== edges.length)
    fail(`meta.edges(${graph.meta.edges}) ≠ 실제 엣지 수(${edges.length})`);
}

// ─────────────────────────────────────────────
// 2. openapi.json
// ─────────────────────────────────────────────
console.log('\n=== 2. openapi.json ===');
const { exists: oaExists, data: openapi } = loadJson('openapi.json');
let opIds = [];
let joinRate = 'N/A';

if (!oaExists) {
  fail('openapi.json 파일 없음');
} else if (openapi) {
  pass('openapi.json: valid JSON');

  if (openapi.paths && typeof openapi.paths === 'object' && Object.keys(openapi.paths).length > 0) {
    pass(`paths 존재 (${Object.keys(openapi.paths).length}개 경로)`);
  } else {
    fail('paths 없음 또는 비어 있음');
  }

  // operationId 수집
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
  for (const [, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const [m, op] of Object.entries(pathItem ?? {})) {
      if (HTTP_METHODS.has(m) && op && typeof op === 'object') {
        if (op.operationId) opIds.push(op.operationId);
      }
    }
  }
  const matched = opIds.filter((id) => nodeIds.has(id));
  const unmatched = opIds.filter((id) => !nodeIds.has(id));
  joinRate = opIds.length ? `${matched.length}/${opIds.length} (${((matched.length / opIds.length) * 100).toFixed(1)}%)`
                          : '0/0';
  if (unmatched.length === 0) {
    pass(`operationId ↔ graph 노드 조인 커버리지: ${joinRate}`);
  } else {
    fail(`operationId ↔ graph 노드 조인 커버리지: ${joinRate} — 미매칭 ${unmatched.length}건`);
    unmatched.slice(0, 10).forEach((id) => info(`- 미매칭: ${id}`));
  }

  // $ref 해석 가능 여부
  const schemas = openapi.components?.schemas ?? {};
  const badRefs = [];
  let refCount = 0;
  (function walk(obj) {
    if (Array.isArray(obj)) return obj.forEach(walk);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k === '$ref' && typeof v === 'string') {
          refCount++;
          const m = v.match(/^#\/components\/schemas\/(.+)$/);
          if (!m) badRefs.push(`외부/비표준 ref: ${v}`);
          else if (!(m[1] in schemas)) badRefs.push(`해석 불가: ${v}`);
        } else walk(v);
      }
    }
  })(openapi);
  if (badRefs.length === 0) pass(`모든 $ref 해석 가능 (${refCount}건 검사, schemas ${Object.keys(schemas).length}개)`);
  else {
    fail(`해석 불가 $ref ${badRefs.length}건 / 전체 ${refCount}건`);
    badRefs.slice(0, 10).forEach((b) => info(`- ${b}`));
  }
}

// ─────────────────────────────────────────────
// 3. impact.json
// ─────────────────────────────────────────────
console.log('\n=== 3. impact.json ===');
const { exists: impExists, data: impact } = loadJson('impact.json');
let commitTotal = 0;

if (!impExists) {
  console.log('impact.json 없음 (빈 상태 — 정상)');
} else if (impact) {
  pass('impact.json: valid JSON');

  if (Array.isArray(impact.commits)) {
    commitTotal = impact.commits.length;
    pass(`commits 배열 존재 (${commitTotal}개)`);

    // 필수 필드
    const badCommits = [];
    for (const c of impact.commits) {
      const missing = ['sha', 'shortSha', 'subject', 'changedNodes'].filter((k) => c[k] == null);
      if (missing.length) badCommits.push(`${c.shortSha ?? c.sha ?? '?'}: ${missing.join(',')} 누락`);
    }
    if (badCommits.length === 0) pass('모든 commit에 sha/shortSha/subject/changedNodes 존재');
    else {
      fail(`필수 필드 누락 commit ${badCommits.length}건`);
      badCommits.slice(0, 10).forEach((b) => info(`- ${b}`));
    }

    // changedNodes inGraph==true 표본 검증
    const inGraphIds = impact.commits.flatMap((c) =>
      (Array.isArray(c.changedNodes) ? c.changedNodes : []).filter((n) => n.inGraph === true).map((n) => n.id));
    const sample = inGraphIds.filter((_, i) => i % Math.max(1, Math.floor(inGraphIds.length / 50)) === 0).slice(0, 50);
    const ghost = sample.filter((id) => !nodeIds.has(id));
    if (ghost.length === 0) pass(`changedNodes inGraph==true 표본 검증 통과 (표본 ${sample.length}/${inGraphIds.length}건 모두 graph에 존재)`);
    else {
      fail(`inGraph==true 인데 graph에 없는 노드 ${ghost.length}건 (표본 ${sample.length}건 중)`);
      ghost.slice(0, 10).forEach((id) => info(`- ${id}`));
    }

    // endpointImpact[].commits 의 shortSha 존재 검증
    const shortShas = new Set(impact.commits.map((c) => c.shortSha));
    const orphanRefs = [];
    for (const ep of impact.endpointImpact ?? []) {
      for (const s of ep.commits ?? []) {
        if (!shortShas.has(s)) orphanRefs.push(`${ep.id ?? '?'} → ${s}`);
      }
    }
    if (Array.isArray(impact.endpointImpact)) {
      if (orphanRefs.length === 0) pass(`endpointImpact(${impact.endpointImpact.length}개)의 모든 commits shortSha 가 commits 목록에 존재`);
      else {
        fail(`commits 목록에 없는 shortSha 참조 ${orphanRefs.length}건`);
        orphanRefs.slice(0, 10).forEach((b) => info(`- ${b}`));
      }
    } else {
      info('endpointImpact 배열 없음 — shortSha 검증 생략');
    }
  } else {
    fail('commits 배열 없음');
  }
}

// ─────────────────────────────────────────────
// 4. 요약 통계
// ─────────────────────────────────────────────
console.log('\n=== 4. 요약 통계 ===');
const kafkaTopics = nodes.filter((n) => n.resourceType === 'kafka-topic').length;
console.log(`노드 수            : ${nodes.length}`);
console.log(`엣지 수            : ${edges.length}`);
console.log(`커밋 수            : ${commitTotal}`);
console.log(`kafka 토픽 수      : ${kafkaTopics}`);
console.log(`operationId 조인율 : ${joinRate}`);

console.log(failCount === 0 ? '\n✅ 전체 통과' : `\n❌ 실패 ${failCount}건`);
process.exit(failCount === 0 ? 0 : 1);
