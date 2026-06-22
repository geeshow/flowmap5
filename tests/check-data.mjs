#!/usr/bin/env node
// 데이터 계약 검증: web/data/ (매니페스트 + 프로젝트별 파일)
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
  try { return { exists: true, data: JSON.parse(readFileSync(p, 'utf8')) }; }
  catch (e) { fail(`${name}: JSON 파싱 실패 — ${e.message}`); return { exists: true, data: null }; }
}

// ─────────────────────────────────────────────
// 1. manifest.json + 프로젝트별 graph 병합
// ─────────────────────────────────────────────
console.log('\n=== 1. manifest.json + 프로젝트 그래프 ===');
const VALID_KINDS = new Set(['internal', 'external', 's2s', 'batch', 'resource', 'join']);
const { exists: mExists, data: manifest } = loadJson('manifest.json');

const nodeById = new Map();   // 병합 노드
let allEdges = [];
let projects = [];

if (!mExists) {
  // 하위호환: 단일 graph.json
  const { exists, data } = loadJson('graph.json');
  if (!exists) { fail('manifest.json / graph.json 둘 다 없음'); }
  else if (data) {
    pass('graph.json: valid JSON (하위호환 모드)');
    (data.nodes || []).forEach((n) => n.id && nodeById.set(n.id, n));
    allEdges = data.edges || [];
    projects = [{ name: 'graph', graph: 'graph.json' }];
  }
} else if (manifest) {
  pass('manifest.json: valid JSON');
  if (manifest.version !== 1) fail(`manifest.version 이 1이 아님 (${manifest.version})`);
  if (!Array.isArray(manifest.projects) || !manifest.projects.length) fail('manifest.projects 비어 있음');
  else pass(`projects ${manifest.projects.length}개 (backend ${manifest.projects.filter(p=>p.type==='backend').length}, frontend ${manifest.projects.filter(p=>p.type==='frontend').length})`);
  projects = manifest.projects || [];

  // 각 프로젝트 아티팩트 존재 + graph 로드 + 병합
  for (const p of projects) {
    for (const key of ['graph', 'openapi', 'impact', 'join', 'screens']) {
      const fn = p[key];
      if (fn && !existsSync(join(DATA, fn))) fail(`${p.name}.${key} 파일 없음: ${fn}`);
    }
    if (!p.graph) { fail(`${p.name}: graph 파일명 없음`); continue; }
    const { exists, data } = loadJson(p.graph);
    if (!exists || !data) continue;
    for (const n of data.nodes || []) {
      const prev = nodeById.get(n.id);
      if (!prev || (n.file && !prev.file)) nodeById.set(n.id, n);
    }
    allEdges.push(...(data.edges || []));
  }
}

const nodeIds = new Set(nodeById.keys());
const nodes = [...nodeById.values()];

// 노드 id/layer
const badNodes = nodes.filter((n) => !n.id || !n.layer);
if (badNodes.length === 0) pass(`모든 병합 노드(${nodes.length})에 id/layer 존재`);
else { fail(`id/layer 누락 노드 ${badNodes.length}건`); badNodes.slice(0, 10).forEach((n) => info(`- ${n.id ?? JSON.stringify(n).slice(0,80)}`)); }

// 엣지 source/target/kind (병합 그래프 내 — s2s/join 은 앱이 런타임 계산하므로 소스 파일엔 없음)
const broken = [];
const badKinds = [];
for (const e of allEdges) {
  if (!nodeIds.has(e.source)) broken.push(`source 미존재: ${e.source} → ${e.target}`);
  if (!nodeIds.has(e.target)) broken.push(`target 미존재: ${e.source} → ${e.target}`);
  if (!VALID_KINDS.has(e.kind)) badKinds.push(`kind=${JSON.stringify(e.kind)} (${e.source} → ${e.target})`);
}
if (broken.length === 0) pass(`끊긴 엣지 0건 (병합 엣지 ${allEdges.length}개 전수 검사)`);
else { fail(`끊긴 엣지 ${broken.length}건`); broken.slice(0, 10).forEach((b) => info(`- ${b}`)); }
if (badKinds.length === 0) pass(`모든 엣지 kind ∈ {${[...VALID_KINDS].join(',')}}`);
else { fail(`유효하지 않은 kind ${badKinds.length}건`); badKinds.slice(0, 10).forEach((b) => info(`- ${b}`)); }

// ─────────────────────────────────────────────
// 2. openapi (프로젝트별) — operationId ↔ 노드 조인
// ─────────────────────────────────────────────
console.log('\n=== 2. openapi (프로젝트별) ===');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
let opIds = [];
let joinRate = 'N/A';
const oaFiles = projects.filter((p) => p.openapi).map((p) => p.openapi);
if (!oaFiles.length) { info('openapi 파일 없음 (스킵)'); }
else {
  let badRefAll = 0, refCountAll = 0, pathCount = 0;
  for (const f of oaFiles) {
    const { data: oa } = loadJson(f);
    if (!oa) continue;
    pathCount += Object.keys(oa.paths || {}).length;
    for (const item of Object.values(oa.paths || {}))
      for (const [m, op] of Object.entries(item || {}))
        if (HTTP_METHODS.has(m) && op && op.operationId) opIds.push(op.operationId);
    const schemas = oa.components?.schemas ?? {};
    (function walk(o) {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
        if (k === '$ref' && typeof v === 'string') {
          refCountAll++;
          const mm = v.match(/^#\/components\/schemas\/(.+)$/);
          if (!mm || !(mm[1] in schemas)) badRefAll++;
        } else walk(v);
      }
    })(oa);
  }
  pass(`openapi 파일 ${oaFiles.length}개, paths ${pathCount}개, operationId ${opIds.length}개`);
  // ~N 오버로드 operationId 는 그래프에 base id 만 존재 → 미매칭이 정상(실패로 보지 않음)
  const overloads = opIds.filter((id) => /~\d+$/.test(id));
  const real = opIds.filter((id) => !/~\d+$/.test(id));
  const unmatched = real.filter((id) => !nodeIds.has(id));
  const matched = real.length - unmatched.length;
  joinRate = real.length ? `${matched}/${real.length} (${((matched / real.length) * 100).toFixed(1)}%)` : '0/0';
  if (unmatched.length === 0) pass(`operationId ↔ 노드 조인: ${joinRate} (오버로드 ~N ${overloads.length}건 제외)`);
  else { fail(`operationId 미매칭 ${unmatched.length}건 (조인 ${joinRate})`); unmatched.slice(0, 10).forEach((id) => info(`- ${id}`)); }
  if (badRefAll === 0) pass(`모든 $ref 해석 가능 (${refCountAll}건)`);
  else fail(`해석 불가 $ref ${badRefAll}건 / 전체 ${refCountAll}건`);
}

// ─────────────────────────────────────────────
// 3. impact (프로젝트별)
// ─────────────────────────────────────────────
console.log('\n=== 3. impact (프로젝트별) ===');
let commitTotal = 0;
const impFiles = projects.filter((p) => p.impact).map((p) => p.impact);
if (!impFiles.length) { console.log('impact 파일 없음 (빈 상태 — 정상)'); }
else for (const f of impFiles) {
  const { data: impact } = loadJson(f);
  if (!impact) continue;
  if (!Array.isArray(impact.commits)) { fail(`${f}: commits 배열 없음`); continue; }
  commitTotal += impact.commits.length;
  const badCommits = impact.commits.filter((c) => ['sha','shortSha','subject','changedNodes'].some((k) => c[k] == null));
  if (badCommits.length === 0) pass(`${f}: commits ${impact.commits.length}개, 필수 필드 OK`);
  else fail(`${f}: 필수 필드 누락 commit ${badCommits.length}건`);
  // inGraph==true 표본이 병합 그래프에 존재하는지
  const inGraphIds = impact.commits.flatMap((c) => (c.changedNodes || []).filter((n) => n.inGraph === true).map((n) => n.id));
  const ghost = inGraphIds.filter((id) => !nodeIds.has(id));
  if (ghost.length === 0) pass(`${f}: inGraph 노드 ${inGraphIds.length}건 모두 그래프에 존재`);
  else { fail(`${f}: inGraph 인데 그래프에 없는 노드 ${ghost.length}건`); ghost.slice(0, 5).forEach((id) => info(`- ${id}`)); }
  // endpointImpact shortSha 참조 무결성
  const shas = new Set(impact.commits.map((c) => c.shortSha));
  const orphan = (impact.endpointImpact || []).flatMap((ep) => (ep.commits || []).filter((s) => !shas.has(s)));
  if (orphan.length === 0) pass(`${f}: endpointImpact shortSha 참조 무결성 OK`);
  else fail(`${f}: 잘못된 shortSha 참조 ${orphan.length}건`);
}

// ─────────────────────────────────────────────
// 4. 요약
// ─────────────────────────────────────────────
console.log('\n=== 4. 요약 통계 ===');
const byType = (t) => projects.filter((p) => p.type === t).length;
console.log(`프로젝트 수        : ${projects.length} (backend ${byType('backend')}, frontend ${byType('frontend')})`);
console.log(`병합 노드 수       : ${nodes.length}`);
console.log(`병합 엣지 수       : ${allEdges.length}`);
console.log(`커밋 수            : ${commitTotal}`);
console.log(`kafka 토픽 수      : ${nodes.filter((n) => n.resourceType === 'kafka-topic').length}`);
console.log(`operationId 조인율 : ${joinRate}`);

console.log(failCount === 0 ? '\n✅ 전체 통과' : `\n❌ 실패 ${failCount}건`);
process.exit(failCount === 0 ? 0 : 1);
