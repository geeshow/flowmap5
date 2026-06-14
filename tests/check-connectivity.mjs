#!/usr/bin/env node
// 연결성/고아 검증 (tester): docs/web/data/ 의 manifest + 프로젝트 그래프를 로드해
// 앱(app.js)의 병합 → reconcileS2S → loadAndApplyJoins(gatewayMatch) 를 헤드리스로 재현한 뒤,
// 데모 프로젝트(DEMO_PROJECTS)의 화면/엔드포인트/호출이 모두 연결되어 고아가 없는지 검사한다.
//
// 사용법: node tests/check-connectivity.mjs
//   DEMO_PROJECTS=shopflow,shopflow-web  (기본값)  — 게이트 대상 프로젝트
// 종료코드: 데모 게이트 실패 시 1, 통과 시 0.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'web', 'data');
const DEMO = new Set((process.env.DEMO_PROJECTS ?? 'shopflow,shopflow-web').split(',').map(s => s.trim()).filter(Boolean));

let failCount = 0;
const pass = (m) => console.log(`✅ ${m}`);
const fail = (m) => { failCount++; console.log(`❌ ${m}`); };
const info = (m) => console.log(`   ${m}`);

function loadJson(name) {
  const p = join(DATA, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { fail(`${name}: JSON 파싱 실패 — ${e.message}`); return null; }
}

// ── app.js 포팅: 경로 정규화 / verb 호환 ──────────────────────────────
function normPath(p) {
  if (!p) return '';
  let s = String(p).split('?')[0].replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
  return s === '' ? '/' : s;
}
const verbCompatible = (a, b) => {
  const x = (a || 'ANY').toUpperCase(), y = (b || 'ANY').toUpperCase();
  return x === 'ANY' || y === 'ANY' || x === y;
};

// ── 1. manifest + 프로젝트 그래프 병합 (app.js loadGraphData 재현) ──────
const manifest = loadJson('manifest.json');
if (!manifest || !Array.isArray(manifest.projects)) {
  fail('manifest.json 없음/형식오류 — 파이프라인을 먼저 실행하세요');
  process.exit(1);
}
const projects = manifest.projects;
const frontProjects = new Set(projects.filter(p => p.type === 'frontend').map(p => p.name));

const nodeById = new Map();
let EDGES = [];
for (const p of projects) {
  if (!p.graph) continue;
  const g = loadJson(p.graph);
  if (!g) continue;
  for (const n of g.nodes || []) {
    const prev = nodeById.get(n.id);
    if (!prev || (n.file && !prev.file)) nodeById.set(n.id, { ...n, _project: n.project ?? p.name });
  }
  for (const e of g.edges || []) EDGES.push(e);
}
let NODES = [...nodeById.values()];
const nodeIndex = new Map(NODES.map(n => [n.id, n]));

// ── 2. reconcileS2S 재현 (백엔드 external → s2s 승격) ───────────────────
{
  const ctrlByPath = new Map();
  for (const n of NODES) {
    if (n.layer === 'CONTROLLER' && n.endpoint) {
      const k = normPath(n.endpoint);
      (ctrlByPath.get(k) || ctrlByPath.set(k, []).get(k)).push(n);
    }
  }
  const absorbed = new Set();
  for (const e of EDGES) {
    if (e.kind !== 'external') continue;
    const src = nodeIndex.get(e.source);
    if (src && frontProjects.has(src._project)) continue;       // 프론트 외부호출은 join 담당
    const ext = nodeIndex.get(e.target);
    if (!ext || !ext.endpoint) continue;
    const cands = (ctrlByPath.get(normPath(ext.endpoint)) || [])
      .filter(c => verbCompatible(ext.httpMethod, c.httpMethod) && (c._project !== ext._project || c.module !== ext.module));
    if (cands.length !== 1) continue;
    e.kind = 's2s'; e.relation = 'call'; e.target = cands[0].id;
    absorbed.add(ext.id);
  }
  // app.js 와 동일: s2s 로 흡수되어 더 이상 참조되지 않는 ext: 노드는 그래프에서 제거
  if (absorbed.size) {
    const refed = new Set();
    for (const e of EDGES) { refed.add(e.source); refed.add(e.target); }
    NODES = NODES.filter(n => !(absorbed.has(n.id) && !refed.has(n.id)));
    nodeIndex.clear();
    for (const n of NODES) nodeIndex.set(n.id, n);
  }
}

// ── 3. loadAndApplyJoins + gatewayMatch 재현 ───────────────────────────
const idSet = new Set(NODES.map(n => n.id));
const ctrlByPath = new Map();
for (const n of NODES) {
  if (n.layer === 'CONTROLLER' && n.endpoint) {
    const k = normPath(n.endpoint);
    (ctrlByPath.get(k) || ctrlByPath.set(k, []).get(k)).push(n);
  }
}
function gatewayMatch(path, method) {
  if (!path) return null;
  const segs = normPath(path).split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const stripped = normPath('/' + segs.slice(1).join('/'));
  const cands = (ctrlByPath.get(stripped) || []).filter(c => verbCompatible(method, c.httpMethod));
  return cands.length === 1 ? cands[0].id : null;
}
const joinFiles = projects.filter(p => p.join).map(p => p.join);
const joinReport = { matched: 0, gateway: 0, unmatched: 0 };
const joinedFrontIds = new Set();
for (const jf of joinFiles) {
  const j = loadJson(jf);
  if (!j || !Array.isArray(j.links)) continue;
  for (const link of j.links) {
    if (!idSet.has(link.frontendNodeId)) continue;
    let target = null;
    if (link.matchStatus === 'matched' && idSet.has(link.backendNodeId)) { target = link.backendNodeId; joinReport.matched++; }
    else {
      const direct = (ctrlByPath.get(normPath(link.normalizedPath)) || []).filter(c => verbCompatible(link.httpMethod, c.httpMethod));
      if (direct.length === 1) { target = direct[0].id; joinReport.matched++; }
      else { target = gatewayMatch(link.normalizedPath, link.httpMethod); if (target) joinReport.gateway++; }
    }
    if (target) {
      EDGES.push({ source: link.frontendNodeId, target, mode: 'sync', kind: 'join', relation: 'http', confidence: link.confidence });
      joinedFrontIds.add(link.frontendNodeId);
    } else joinReport.unmatched++;
  }
}

// ── 4. 무방향 인접 구성 ────────────────────────────────────────────────
const adj = new Map();
const deg = new Map();
for (const n of NODES) { adj.set(n.id, new Set()); deg.set(n.id, 0); }
for (const e of EDGES) {
  if (!nodeIndex.has(e.source) || !nodeIndex.has(e.target)) continue;
  adj.get(e.source).add(e.target); adj.get(e.target).add(e.source);
  deg.set(e.source, deg.get(e.source) + 1); deg.set(e.target, deg.get(e.target) + 1);
}
// 방향 인접(타깃 도달용) — SCREEN→API 도달 판정
const out = new Map();
for (const n of NODES) out.set(n.id, []);
for (const e of EDGES) if (nodeIndex.has(e.source) && nodeIndex.has(e.target)) out.get(e.source).push(e.target);
function reaches(startId, predicate) {
  const seen = new Set([startId]); const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    for (const t of out.get(id) || []) {
      if (seen.has(t)) continue;
      const tn = nodeIndex.get(t);
      if (tn && predicate(tn)) return tn;
      seen.add(t); stack.push(t);
    }
  }
  return null;
}
const isApiLike = (n) => n.layer === 'API' || n.layer === 'EXTERNAL' || n.layer === 'CONTROLLER';
const inDemo = (n) => DEMO.has(n._project);

// ── 5. 전역 통계 (참고용) ──────────────────────────────────────────────
console.log('\n=== 전역 통계 (참고) ===');
const screens = NODES.filter(n => n.layer === 'SCREEN');
const endpoints = NODES.filter(n => n.layer === 'CONTROLLER' && n.endpoint);
pass(`프로젝트 ${projects.length} · 노드 ${NODES.length} · 엣지 ${EDGES.length}`);
info(`화면 ${screens.length} · 엔드포인트 ${endpoints.length}`);
info(`조인: 직접매칭 ${joinReport.matched} · 게이트웨이매칭 ${joinReport.gateway} · 미매칭 ${joinReport.unmatched}`);
const s2sCount = EDGES.filter(e => e.kind === 's2s').length;
info(`S2S 엣지 ${s2sCount} · join 엣지 ${EDGES.filter(e => e.kind === 'join').length}`);

// ── 6. 데모 게이트 ─────────────────────────────────────────────────────
console.log(`\n=== 데모 게이트 (DEMO_PROJECTS=${[...DEMO].join(',')}) ===`);
const demoNodes = NODES.filter(inDemo);
if (!demoNodes.length) {
  fail(`데모 프로젝트 노드가 없음 — 샘플(${[...DEMO].join(',')})이 분석/동기화되지 않음`);
  console.log(`\n결과: 실패 ${failCount}건`);
  process.exit(1);
}
pass(`데모 노드 ${demoNodes.length}건 로드`);

// 6-1. 데모 SCREEN → API 도달
const demoScreens = demoNodes.filter(n => n.layer === 'SCREEN');
const screenOrphans = demoScreens.filter(s => !reaches(s.id, isApiLike));
if (demoScreens.length === 0) fail('데모 SCREEN 노드가 0건 — 화면 샘플 누락');
else if (screenOrphans.length === 0) pass(`데모 화면 ${demoScreens.length}개 전부 API/엔드포인트에 도달`);
else { fail(`API에 도달 못하는 화면 ${screenOrphans.length}건`); screenOrphans.slice(0, 10).forEach(s => info(`- ${s.id}`)); }

// 6-2. 데모 화면이 도달하는 프론트 API/EXTERNAL 노드는 모두 join 되어야 함 + URL resolved
const reachedApi = new Map();
for (const s of demoScreens) {
  const seen = new Set([s.id]); const stack = [s.id];
  while (stack.length) {
    const id = stack.pop();
    for (const t of out.get(id) || []) {
      if (seen.has(t)) continue; seen.add(t); stack.push(t);
      const tn = nodeIndex.get(t);
      if (tn && (tn.layer === 'API' || tn.layer === 'EXTERNAL')) reachedApi.set(tn.id, tn);
    }
  }
}
const unjoined = [...reachedApi.values()].filter(n => !joinedFrontIds.has(n.id));
if (reachedApi.size === 0) fail('데모 화면에서 도달하는 프론트 API 호출이 0건');
else if (unjoined.length === 0) pass(`프론트 API 호출 ${reachedApi.size}건 전부 백엔드 엔드포인트에 조인됨`);
else { fail(`백엔드에 조인되지 않은 프론트 API 호출 ${unjoined.length}건`); unjoined.slice(0, 10).forEach(n => info(`- ${n.id}`)); }

const unresolved = [...reachedApi.values()].filter(n => (n.confidence && n.confidence !== 'resolved') || n.urlPlaceholder);
if (unresolved.length === 0) pass(`프론트 API URL 전부 resolved (placeholder 없음)`);
else { fail(`미해결 URL ${unresolved.length}건 (confidence≠resolved 또는 placeholder)`); unresolved.slice(0, 10).forEach(n => info(`- ${n.id} conf=${n.confidence} ph=${n.urlPlaceholder}`)); }

// 6-3. 데모 백엔드 CONTROLLER 엔드포인트는 인바운드 ≥1 (join/s2s/internal)
const inbound = new Map();
for (const n of NODES) inbound.set(n.id, 0);
for (const e of EDGES) if (nodeIndex.has(e.target)) inbound.set(e.target, inbound.get(e.target) + 1);
const demoEndpoints = demoNodes.filter(n => n.layer === 'CONTROLLER' && n.endpoint);
const endpointOrphans = demoEndpoints.filter(n => inbound.get(n.id) === 0);
if (demoEndpoints.length === 0) fail('데모 백엔드 CONTROLLER 엔드포인트가 0건 — 백엔드 샘플 누락');
else if (endpointOrphans.length === 0) pass(`데모 엔드포인트 ${demoEndpoints.length}개 전부 인바운드 ≥1`);
else { fail(`인바운드 0인 고아 엔드포인트 ${endpointOrphans.length}건`); endpointOrphans.slice(0, 10).forEach(n => info(`- ${n.id} [${n.httpMethod} ${n.endpoint}]`)); }

// 6-4. 데모 노드 전체 degree 0 고아 없음 (CONFIG/OTHER 등 비호출 레이어는 제외)
const SKIP_ORPHAN_LAYERS = new Set(['CONFIG', 'OTHER', 'RESOURCE']);
const orphans = demoNodes.filter(n => deg.get(n.id) === 0 && !SKIP_ORPHAN_LAYERS.has(n.layer));
if (orphans.length === 0) pass(`데모 고아 노드(degree 0) 없음`);
else { fail(`고아 노드 ${orphans.length}건`); orphans.slice(0, 15).forEach(n => info(`- ${n.id} [${n.layer}]`)); }

// 6-5. S2S 존재 확인 (데모 백엔드 간 호출이 살아있는지)
const demoS2s = EDGES.filter(e => e.kind === 's2s' && nodeIndex.get(e.source) && inDemo(nodeIndex.get(e.source)));
if (demoS2s.length > 0) pass(`데모 S2S 엣지 ${demoS2s.length}건 존재`);
else fail('데모 S2S 엣지가 0건 — server-to-server 호출이 연결되지 않음');

console.log(`\n${failCount === 0 ? '✅ 통과' : '❌ 실패'}: ${failCount}건`);
process.exit(failCount === 0 ? 0 : 1);
