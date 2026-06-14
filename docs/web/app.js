'use strict';

/* =========================================================================
   flowmap — 호출관계분석 중심 단일 뷰
     • 진입(빈 상태): 서비스 → 경로(path) → 엔드포인트 드릴다운 브라우저.
     • 노드(엔드포인트/검색결과) 선택 → 그 노드 기준 "호출관계분석"
         (피호출 ← 기준 노드 → 호출, 깊이 조절).
     • 기준 노드 "프로세스 상세보기" → 내부 controller→service→repository→infra
         실행 흐름을 인라인으로 확장.
   바닐라 JS, 의존성 없음.
   ========================================================================= */

const LAYER_CLASS = {
  CONTROLLER: 'controller', SERVICE: 'service', REPOSITORY: 'repository',
  COMPONENT: 'component', CONFIG: 'config', BATCH: 'batch',
  EXTERNAL: 'external', RESOURCE: 'resource', OTHER: 'other',
  // 프론트엔드(react/vue) 레이어
  SCREEN: 'screen', HOOK: 'hook', STORE: 'store', API: 'api',
};
const RES_ICON = { 'kafka-topic': '📨', 'redis': '🔴', 'db-table': '🗄️' };
const HTTP_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'];
function methodRank(m) { const i = HTTP_ORDER.indexOf(String(m || 'ANY').toUpperCase()); return i < 0 ? HTTP_ORDER.length : i; }
const KIND_COLOR = {
  internal: '#94a3b8', s2s: '#2563eb', external: '#dc2626', batch: '#7c3aed',
  kafka: '#c026d3', redis: '#db2777', db: '#b45309', join: '#4f46e5',
};

// ---- 전역 데이터 / 인덱스 ----
let NODES = [];
let EDGES = [];
let META = {};
let MANIFEST = null;   // data/manifest.json (프로젝트별 독립 분석 목록); 없으면 단일 graph.json 폴백
let COMPRESSED = false; // manifest.compressed=true → 데이터를 <path>.gz 로 받아 DecompressionStream 으로 해제
const nodeById = new Map();
const outEdges = new Map();
const inEdges = new Map();
const cardEls = new Map();

let currentEdges = [];
const currentAdjOut = new Map();
const currentAdjIn = new Map();
// 뷰 전용 합성(aggregate) 노드 — 프론트 화면을 {path1} 그룹 노드로 묶을 때 nodeById 에 임시 등록한다.
// 다음 render 에서 정리(cleanSynthNodes)해 다른 뷰를 오염시키지 않는다.
let synthNodeIds = [];
function cleanSynthNodes() { for (const id of synthNodeIds) nodeById.delete(id); synthNodeIds = []; }

const state = {
  view: null,                // 기능 모듈 뷰 (commits/topic/api — features/*.js lazy load)
  overview: false,           // 전체 서비스 지도 모드
  structure: false,          // 어플리케이션구조 메뉴 컨텍스트 (3단계 드릴다운)
  structSvc: null,           //   ② 선택 서비스 — endpoint path {path1}/{path2} 그룹 보기
  structPath: null,          //   ③ 선택 경로 — 그 경로 관련 파일 단위 그래프
  structFile: null,          //   ④ 선택 파일 — 그 파일이 쓰는 메서드 구조(레이어 흐름)
  service: null,             // 서비스 단위 보기(전체보기 → 서비스 드릴다운)
  svcPath: null,             // 프론트 서비스 보기 → {path1} 그룹 드릴(그 경로 화면들의 프로세스 흐름)
  svcPick: null,             // 서비스 보기에서 선택한 노드(활성화된 연결 노드만 단계 필터)
  infraType: null,           // 인프라/외부 타입 보기(전체보기 → 타입 노드 드릴다운)
  fromService: null,         // 호출관계분석으로 들어온 출처 서비스(브레드크럼 체인용)
  fromOverview: false,       // 전체보기(인프라/외부 노드)에서 드릴다운한 경우
  focus: null,               // 호출관계분석 기준 노드 id
  sel: null,                 // 상세 패널 선택
  expanded: false,           // 기준 노드 내부 프로세스 flow 인라인 확장
  up: 2,
  down: 2,
  hideOther: true,           // OTHER 레이어 노이즈는 항상 숨김
  hideOrphans: true,         // 호출/피호출 관계 없는 고아노드 숨김 (기본 켜짐)
  zoom: 1,                   // 트랙패드 핀치 확대/축소 배율
};
const ZOOM_MIN = 0.3, ZOOM_MAX = 3;

// =========================================================================
// 부트
// =========================================================================
async function boot() {
  await loadGraphData();       // manifest + 프로젝트별 graph 병렬 로드 → NODES/EDGES/META 병합
  reconcileS2S();              // kind:external → s2s 재현 (서비스 간 호출 연결)
  await loadAndApplyJoins();   // join.json matched 링크 → kind:'join' 엣지 (프론트→백엔드)
  await loadAndApplyScreens(); // screens.json 정규 route/name → SCREEN 노드 보정 (sub-root 화면 식별)
  reclassifyUnjoinedExternals(); // join 으로 백엔드에 안 붙은 프론트 외부호출 → 외부 API 로 환원
  buildIndexes();              // nodeById/outEdges/inEdges 1회 빌드
  renderSidebarStats();        // 좌측 사이드바 하단 통계

  parseUrl();
  attachHandlers();
  render();
  renderDetail();

  window.addEventListener('popstate', () => { parseUrl(); render(); renderDetail(); });
}

// =========================================================================
// 데이터 로딩 / 병합 — 프로젝트별 독립 분석 파일을 매니페스트로 모아 브라우저에서 통합
//   계약: data/manifest.json (docs/FEATURE-API.md, 매니페스트 규약)
// =========================================================================
// COMPRESSED 면 <path>.gz 를 먼저 받아 DecompressionStream(gzip)으로 해제 — 로컬/정적 서버에서도 전송량 −95%.
// .gz 부재·미지원·해제 실패 시 원본 path 로 폴백. manifest 자체는 COMPRESSED 결정 전에 받으므로 항상 평문.
async function jsonFetch(path) {
  if (COMPRESSED && typeof DecompressionStream === 'function') {
    try {
      const r = await fetch(path + '.gz');
      if (r.ok && r.body) {
        const stream = r.body.pipeThrough(new DecompressionStream('gzip'));
        return JSON.parse(await new Response(stream).text());
      }
    } catch (e) { /* 폴백 */ }
  }
  return fetch(path).then(r => r.ok ? r.json() : null).catch(() => null);
}

// (source,target,relation,callSiteLine) 기준 엣지 중복 제거 (scripts/build.py 규칙 동일)
function dedupEdges(list) {
  const m = new Map();
  for (const e of list) m.set([e.source, e.target, e.relation, e.callSiteLine].join(''), e);
  return [...m.values()];
}

async function loadGraphData() {
  const manifest = await jsonFetch('data/manifest.json');
  if (!manifest || !Array.isArray(manifest.projects) || !manifest.projects.length) {
    // 하위호환: 매니페스트가 없으면 기존 단일 통합 그래프
    const data = await jsonFetch('data/graph.json');
    if (data) { NODES = data.nodes || []; EDGES = data.edges || []; META = data.meta || {}; }
    MANIFEST = null;
    return;
  }
  MANIFEST = manifest;
  COMPRESSED = !!manifest.compressed;   // 이후 프로젝트 graph/join·lazy 데이터는 .gz 로 로드
  const results = await Promise.all(manifest.projects.map(p =>
    jsonFetch('data/' + p.graph).then(g => ({ p, g }))));

  // 프론트 정규 이름 결정 (1차 스캔): 그래프 노드들의 다수결 project.
  //   매니페스트 name 은 그래프 파일명(graph-*) 기준이라 노드 project 와 어긋날 수 있어, 다수결 값을
  //   깔끔한 정규 이름으로 쓴다. 단, 모노레포(프론트 sub-root)에서는 여러 패키지 노드가 모두 루트
  //   이름(예: fe-service-workspace) 하나로 찍혀 다수결 값이 겹친다 → 그대로 쓰면 패키지들이 한
  //   서비스로 합쳐져 전체보기에서 동일 카드로 보인다. 따라서 겹치는 이름은 매니페스트 name 으로 분리한다.
  const rawCanon = new Map();   // p.name → 그 그래프의 다수결 project (없으면 p.name)
  for (const { p, g } of results) {
    if (p.type !== 'frontend' || !g || !Array.isArray(g.nodes)) continue;
    const c = new Map();
    for (const n of g.nodes) if (n.project) c.set(n.project, (c.get(n.project) || 0) + 1);
    rawCanon.set(p.name, c.size ? [...c.entries()].sort((a, b) => b[1] - a[1])[0][0] : p.name);
  }
  const canonFreq = new Map();  // 다수결 이름별 등장 프로젝트 수 (2+ = 모노레포 충돌)
  for (const v of rawCanon.values()) canonFreq.set(v, (canonFreq.get(v) || 0) + 1);

  const nodeMap = new Map();    // id → node (file 채워진 노드 우선)
  const okProjects = [];
  let edgeAccum = [];
  for (const { p, g } of results) {
    if (!g || !Array.isArray(g.nodes)) { console.warn('[flowmap] 프로젝트 그래프 로드 실패, 건너뜀:', p.name, p.graph); continue; }
    // 다수결 이름이 유일하면 그걸 정규 이름으로(깔끔). 여러 프로젝트와 겹치면(모노레포 sub-root)
    // 매니페스트 name 을 유지해 패키지별로 분리한다.
    let canon = p.name, forceProject = false;
    if (p.type === 'frontend') {
      const raw = rawCanon.get(p.name);
      if (raw && canonFreq.get(raw) === 1) canon = raw;        // 유일 → 실제 프로젝트명 채택(기존 동작)
      else forceProject = true;                                // 겹침 → 매니페스트 name 으로 분리
      p.name = canon;   // 다운스트림(서비스 보기·티어 분류·join)도 동일 이름을 쓰게 매니페스트도 정규화
    }
    okProjects.push(canon);
    for (const n of g.nodes) {
      // 분리 모드면 노드 project 를 그래프 파일 단위(매니페스트 name)로 통일 — 모노레포 패키지 분리.
      // 일반 모드면 외부호출 등 project 없는 노드만 프론트 서비스(정규 이름)에 귀속(기존 동작).
      if (p.type === 'frontend' && (forceProject || !n.project)) n.project = canon;
      const prev = nodeMap.get(n.id);
      if (!prev || (n.file && !prev.file)) nodeMap.set(n.id, n);
    }
    if (Array.isArray(g.edges)) edgeAccum.push(...g.edges);
  }
  NODES = [...nodeMap.values()];
  EDGES = dedupEdges(edgeAccum);
  META = { projects: okProjects.sort(), nodes: NODES.length, edges: EDGES.length, manifest: true };
}

// 호출관계 경로 정규화 (백엔드 CrossRun.normPath 재현): 쿼리 제거 → {var}→{} → 끝슬래시 제거
function normPath(p) {
  if (!p) return '';
  let s = String(p).split('?')[0].replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
  return s === '' ? '/' : s;
}
function verbCompatible(a, b) {
  const x = (a || 'ANY').toUpperCase(), y = (b || 'ANY').toUpperCase();
  return x === 'ANY' || y === 'ANY' || x === y;
}

// 브라우저 s2s 재현: 백엔드 kind:external 엣지의 ext: 타깃을 다른 백엔드 프로젝트 CONTROLLER와 매칭 → s2s 승격.
//   프론트엔드의 외부호출(http)은 join.json 이 명시적으로 담당하므로 여기서 건드리지 않는다.
function reconcileS2S() {
  if (!MANIFEST) return;   // 단일 통합 그래프는 이미 s2s 처리됨
  const frontProjects = new Set(MANIFEST.projects.filter(p => p.type === 'frontend').map(p => p.name));
  const ctrlByPath = new Map();
  const nodeIndex = new Map();
  for (const n of NODES) {
    nodeIndex.set(n.id, n);
    if (n.layer === 'CONTROLLER' && n.endpoint) {
      const k = normPath(n.endpoint);
      if (!ctrlByPath.has(k)) ctrlByPath.set(k, []);
      ctrlByPath.get(k).push(n);
    }
  }
  const absorbed = new Set();
  for (const e of EDGES) {
    if (e.kind !== 'external') continue;
    const src = nodeIndex.get(e.source);
    if (src && frontProjects.has(src.project)) continue;   // 프론트 외부호출은 join 으로 처리
    const ext = nodeIndex.get(e.target);
    if (!ext || !ext.endpoint) continue;        // endpoint 없는 서드파티(외부 URL만)는 external 유지
    const cands = (ctrlByPath.get(normPath(ext.endpoint)) || [])
      // 서비스 단위(프로젝트 또는 모듈)가 다르면 S2S 후보 — 멀티모듈 모노레포(모듈=서비스) 지원
      .filter(c => verbCompatible(ext.httpMethod, c.httpMethod) && (c.project !== ext.project || c.module !== ext.module));
    if (cands.length !== 1) continue;            // 0=미매칭 유지, 2+=ambiguous 보수적 유지
    e.kind = 's2s'; e.relation = 'call'; e.target = cands[0].id;
    absorbed.add(ext.id);
  }
  if (absorbed.size) {
    const refed = new Set();
    for (const e of EDGES) { refed.add(e.source); refed.add(e.target); }
    NODES = NODES.filter(n => !(absorbed.has(n.id) && !refed.has(n.id)));
  }
}

// 게이트웨이 프리픽스(첫 경로 세그먼트) 제거 후 백엔드 CONTROLLER 와 매칭.
//   프론트는 게이트웨이 경로(/user/v3/rsa)로 호출하지만 백엔드는 프리픽스가 벗겨진 실제 경로(/v3/rsa)를
//   기록하므로, join 의 정확매칭이 실패한다. 첫 세그먼트를 떼고 단일 후보일 때만 연결한다.
function gatewayMatch(path, method, ctrlByPath) {
  if (!path) return null;
  const segs = normPath(path).split('/').filter(Boolean);
  if (segs.length < 2) return null;                       // 프리픽스 + 최소 1세그먼트
  const stripped = normPath('/' + segs.slice(1).join('/'));
  const cands = (ctrlByPath.get(stripped) || []).filter(c => verbCompatible(method, c.httpMethod));
  return cands.length === 1 ? cands[0].id : null;
}

// 프론트→백엔드 연결: <project>.join.json 의 matched 링크 + 게이트웨이 프리픽스 매칭을 kind:'join' 엣지로 추가
async function loadAndApplyJoins() {
  if (!MANIFEST) return;
  const joinFiles = MANIFEST.projects.filter(p => p.join).map(p => p.join);
  if (!joinFiles.length) return;
  const idSet = new Set(NODES.map(n => n.id));
  // 백엔드 CONTROLLER 인덱스 (게이트웨이 프리픽스 제거 매칭용)
  const ctrlByPath = new Map();
  for (const n of NODES) {
    if (n.layer === 'CONTROLLER' && n.endpoint) {
      const k = normPath(n.endpoint);
      if (!ctrlByPath.has(k)) ctrlByPath.set(k, []);
      ctrlByPath.get(k).push(n);
    }
  }
  const joins = await Promise.all(joinFiles.map(f => jsonFetch('data/' + f)));
  const added = [];
  for (const j of joins) {
    if (!j || !Array.isArray(j.links)) continue;
    for (const link of j.links) {
      if (!idSet.has(link.frontendNodeId)) continue;
      let target = null, conf = link.confidence;
      if (link.matchStatus === 'matched' && idSet.has(link.backendNodeId)) {
        target = link.backendNodeId;                       // join 이 이미 매칭한 직접 경로
      } else {
        // 직접매칭 폴백: 프론트 normalizedPath 가 백엔드 CONTROLLER 엔드포인트와 정확히 일치 (프리픽스 없는 직접 호출)
        const direct = (ctrlByPath.get(normPath(link.normalizedPath)) || [])
          .filter(c => verbCompatible(link.httpMethod, c.httpMethod));
        if (direct.length === 1) { target = direct[0].id; conf = conf || 'direct'; }
        else {
          const t = gatewayMatch(link.normalizedPath, link.httpMethod, ctrlByPath);
          if (t) { target = t; conf = conf || 'gateway'; } // 게이트웨이 프리픽스 매칭
        }
      }
      if (target) added.push({ source: link.frontendNodeId, target,
        mode: 'sync', kind: 'join', relation: 'http', confidence: conf,
        callSiteFile: null, callSiteLine: null });
    }
  }
  if (added.length) EDGES = dedupEdges(EDGES.concat(added));
}

// 화면(SCREEN) 식별 보정: <project>.screens.json 의 정규 route/name 을 그래프 SCREEN 노드에 덮어쓴다.
//   그래프 build 의 endpoint 는 프론트 sub-root(예: src/pages, apps/web)를 못 벗기면 모든 화면이 같은
//   {path1} 로 뭉쳐 전체보기/서비스보기에서 동일하게 보인다(경로 그룹 키 = endpoint 기반).
//   manifest 가 가리키는 screens 결과의 route 가 정규값이므로, 이를 기준으로 endpoint·표시 이름을 맞춘다.
//   screens 에 없는 화면은 그래프 endpoint 를 그대로 유지 — 정상 동작 프로젝트는 무변(route===endpoint).
async function loadAndApplyScreens() {
  if (!MANIFEST) return;
  const files = MANIFEST.projects.filter(p => p.screens).map(p => p.screens);
  if (!files.length) return;
  const byId = new Map(NODES.map(n => [n.id, n]));
  const docs = await Promise.all(files.map(f => jsonFetch('data/' + f)));
  for (const d of docs) {
    if (!d || !Array.isArray(d.screens)) continue;
    for (const s of d.screens) {
      const n = byId.get(s.id);
      if (!n || n.layer !== 'SCREEN') continue;
      if (s.route) n.endpoint = normPath(s.route);   // 정규 route → 기준 경로(path 그룹·표시 공용)
      if (s.name) n.screenName = s.name;             // 화면 표시 이름(파일 경로 id 대신)
    }
  }
}

// 프론트 외부호출(ext:) 노드 분류 — loadGraphData 가 프론트 노드에 일괄로 project 를 부여하므로,
//   join 결과를 본 뒤 여기서 되돌린다.
//   · join 으로 백엔드에 연결된 ext 노드 → project 유지(프론트 서비스에 흡수) → 깔끔한 front→backend.
//   · 연결 안 된 ext 노드 → project 비움 → isInfra=true → superId=infra:external → 외부 API 로 표시.
//   안 그러면 미연결 외부호출이 svc:front 끼리 합쳐져(ss===st) 전체보기/서비스보기에서 엣지가 사라진다.
function reclassifyUnjoinedExternals() {
  if (!MANIFEST) return;
  const joined = new Set();
  for (const e of EDGES) if (e.kind === 'join') joined.add(e.source);   // join 엣지 source = ext 노드 id
  for (const n of NODES) {
    if (n.layer === 'EXTERNAL' && n.project && !joined.has(n.id)) n.project = null;
  }
}

// 좌측 사이드바 하단 통계 — 로드된 그래프에서 집계
function renderSidebarStats() {
  const box = document.getElementById('sidebar-stats');
  if (!box) return;
  const services  = (META.projects || []).length;
  const endpoints = NODES.filter(n => n.layer === 'CONTROLLER' && n.endpoint).length;
  const screens   = NODES.filter(n => n.layer === 'SCREEN').length;
  const rows = [
    ['API', endpoints], ['화면', screens], ['서비스', services],
    ['노드', NODES.length], ['관계', EDGES.length],
  ];
  box.innerHTML = '<div class="sb-stats-title">통계</div>' +
    rows.map(([k, v]) =>
      `<div class="sb-stat"><span class="sb-stat-k">${k}</span><span class="sb-stat-v">${v.toLocaleString()}</span></div>`
    ).join('');
}

function buildIndexes() {
  nodeById.clear(); outEdges.clear(); inEdges.clear();
  for (const n of NODES) nodeById.set(n.id, n);
  for (const id of nodeById.keys()) { outEdges.set(id, []); inEdges.set(id, []); }
  for (const e of EDGES) {
    if (outEdges.has(e.source)) outEdges.get(e.source).push(e);
    if (inEdges.has(e.target)) inEdges.get(e.target).push(e);
  }
}

// =========================================================================
// URL 동기화
// =========================================================================
function rawParam(name) {
  const m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return m ? m[1] : null;
}
function clampDepth(v) { v = parseInt(v, 10); return isNaN(v) ? 2 : Math.max(0, Math.min(6, v)); }

function parseUrl() {
  const viewRaw = rawParam('view');
  state.view = viewRaw && FEATURE_OF_VIEW[viewRaw] ? viewRaw : null;
  state.overview = viewRaw === 'overview';
  const svcView = rawParam('service');
  state.service = svcView && (META.projects || []).includes(decodeURIComponent(svcView)) ? decodeURIComponent(svcView) : null;
  // 어플리케이션구조 3단계: view=structure (picker) → app=<svc> (경로 그룹) → p=<path> (프로세스 흐름)
  state.structure = viewRaw === 'structure';
  const appSvc = rawParam('app');
  state.structSvc = state.structure && appSvc && (META.projects || []).includes(decodeURIComponent(appSvc)) ? decodeURIComponent(appSvc) : null;
  state.structPath = state.structSvc && rawParam('p') ? decodeURIComponent(rawParam('p')) : null;
  state.structFile = state.structPath && rawParam('f') ? decodeURIComponent(rawParam('f')) : null;
  const infraView = rawParam('infra');
  state.infraType = infraView && INFRA_LABEL[infraView] ? infraView : null;
  if (state.service || state.infraType) state.overview = false;
  state.svcPath = state.service && rawParam('pp') ? decodeURIComponent(rawParam('pp')) : null;   // 서비스 보기 → 경로(path1) 드릴
  const pick = rawParam('pick');
  state.svcPick = state.service && !state.svcPath && pick && nodeById.has(decodeURIComponent(pick)) ? decodeURIComponent(pick) : null;
  const focus = rawParam('focus');
  state.focus = focus ? decodeURIComponent(focus) : null;
  const from = rawParam('from');
  state.fromService = from && (META.projects || []).includes(decodeURIComponent(from)) ? decodeURIComponent(from) : null;
  state.fromOverview = rawParam('fo') === '1';
  state.up = rawParam('up') != null ? clampDepth(rawParam('up')) : (state.service ? 1 : 2);
  state.down = rawParam('down') != null ? clampDepth(rawParam('down')) : (state.service ? 1 : 2);
  const sel = rawParam('sel');
  state.sel = sel ? decodeURIComponent(sel) : (state.focus || null);
  state.expanded = rawParam('exp') === '1';
  if (state.focus && !nodeById.has(state.focus)) state.focus = null;
}

function pushUrl() {
  const parts = [];
  if (state.overview) {
    parts.push('view=overview');
    history.pushState({}, '', location.pathname + '?' + parts.join('&'));
    return;
  }
  if (state.structure) {                       // 어플리케이션구조 3단계
    parts.push('view=structure');
    if (state.structSvc) parts.push('app=' + encodeURIComponent(state.structSvc));
    if (state.structSvc && state.structPath) parts.push('p=' + encodeURIComponent(state.structPath));
    if (state.structPath && state.structFile) parts.push('f=' + encodeURIComponent(state.structFile));
    if (state.sel) parts.push('sel=' + encodeURIComponent(state.sel));
    history.pushState({}, '', location.pathname + '?' + parts.join('&'));
    return;
  }
  if (state.service || state.infraType) {
    parts.push(state.service ? 'service=' + encodeURIComponent(state.service) : 'infra=' + encodeURIComponent(state.infraType));
    parts.push('up=' + state.up, 'down=' + state.down);
    if (state.service && state.svcPath) parts.push('pp=' + encodeURIComponent(state.svcPath));   // 경로(path1) 드릴 뷰
    if (state.service && state.svcPick) parts.push('pick=' + encodeURIComponent(state.svcPick));
    if (state.sel) parts.push('sel=' + encodeURIComponent(state.sel));
    history.pushState({}, '', location.pathname + '?' + parts.join('&'));
    return;
  }
  if (state.focus) {
    parts.push('focus=' + encodeURIComponent(state.focus));
    if (state.fromService) parts.push('from=' + encodeURIComponent(state.fromService));
    if (state.fromOverview) parts.push('fo=1');
    parts.push('up=' + state.up, 'down=' + state.down);
    if (state.expanded) parts.push('exp=1');
  }
  if (state.sel && state.sel !== state.focus) parts.push('sel=' + encodeURIComponent(state.sel));
  history.pushState({}, '', location.pathname + (parts.length ? '?' + parts.join('&') : ''));
}
function shareUrl() { return location.origin + location.pathname + location.search; }

// =========================================================================
// 액션
// =========================================================================
function setOverview(on) {
  state.view = null;
  state.overview = !!on;
  if (on) { state.structure = false; state.structSvc = null; state.structPath = null; state.structFile = null; state.focus = null; state.service = null; state.infraType = null; state.svcPick = null; state.fromService = null; state.fromOverview = false; state.expanded = false; state.sel = null; }
  pushUrl(); render(); renderDetail();
}
function setStructure(on) {                     // 어플리케이션구조 메뉴 — ① 프로젝트 유형별 서비스 picker
  state.view = null;
  state.structure = !!on;
  state.structSvc = null; state.structPath = null; state.structFile = null;
  if (on) { state.overview = false; state.focus = null; state.service = null; state.infraType = null; state.svcPick = null; state.fromService = null; state.fromOverview = false; state.expanded = false; state.sel = null; }
  pushUrl(); render(); renderDetail();
}
function setStructSvc(svc) {                    // ② 서비스 선택 → endpoint path {path1}/{path2} 그룹 보기
  if (!svc) return;
  state.view = null;
  state.structure = true; state.structSvc = svc; state.structPath = null; state.structFile = null;
  state.overview = false; state.service = null; state.infraType = null; state.svcPick = null; state.focus = null; state.fromService = null; state.fromOverview = false; state.expanded = false; state.sel = null;
  pushUrl(); render(); renderDetail();
}
function setStructPath(svc, path) {             // ③ 경로 선택 → 파일 단위 그래프
  if (!svc || !path) return;
  state.view = null;
  state.structure = true; state.structSvc = svc; state.structPath = path; state.structFile = null;
  state.overview = false; state.service = null; state.infraType = null; state.svcPick = null; state.focus = null; state.fromService = null; state.fromOverview = false; state.expanded = false; state.sel = null;
  pushUrl(); render(); renderDetail();
}
function setStructFile(svc, path, file) {       // ④ 파일 선택 → 그 파일이 쓰는 메서드 구조
  if (!svc || !path || !file) return;
  state.view = null;
  state.structure = true; state.structSvc = svc; state.structPath = path; state.structFile = file;
  state.overview = false; state.service = null; state.infraType = null; state.svcPick = null; state.focus = null; state.fromService = null; state.fromOverview = false; state.expanded = false; state.sel = null;
  pushUrl(); render(); renderDetail();
}
function setServicePick(id) {                  // 서비스 보기: 노드 선택 → 활성화된 연결 노드만 단계 필터 (재클릭=해제)
  if (!nodeById.has(id)) return;
  state.svcPick = state.svcPick === id ? null : id;
  state.sel = state.svcPick ? id : null;
  pushUrl(); render(); renderDetail();
}
function setInfraType(type) {                  // 전체보기 → 인프라/외부 타입 노드 목록·관계 보기
  if (!INFRA_LABEL[type]) return;
  state.view = null;
  state.infraType = type; state.svcPick = null; state.overview = false; state.structure = false; state.service = null; state.focus = null;
  state.fromService = null; state.fromOverview = false; state.expanded = false;
  state.up = 1; state.down = 1; state.sel = null;
  pushUrl(); render(); renderDetail();
}
function setFocusFromOverview(id) {            // 전체보기 인프라/외부 노드 → 호출관계분석 (전체보기 › 노드)
  if (!nodeById.has(id)) return;
  state.view = null;
  state.fromOverview = true; state.fromService = null;
  state.focus = id; state.sel = id; state.expanded = false; state.overview = false; state.structure = false; state.service = null; state.infraType = null; state.svcPick = null;
  pushUrl(); render(); renderDetail();
}
function setService(svc) {                      // 전체보기 → 서비스 단위 API/관계 보기 (BFS 호출/피호출)
  if (!svc) return;
  state.view = null;
  state.structure = false; state.structSvc = null; state.structPath = null;
  state.service = svc; state.overview = false; state.infraType = null; state.svcPath = null; state.svcPick = null; state.focus = null; state.fromService = null; state.fromOverview = false; state.expanded = false;
  state.up = 1; state.down = 1; state.sel = null;
  pushUrl(); render(); renderDetail();
}
// 프론트 서비스 보기 → {path1} 그룹 드릴 (그 경로 화면들 + 다운스트림 프로세스 흐름)
function setSvcPath(svc, path) {
  if (!svc || !path) return;
  state.view = null;
  state.service = svc; state.svcPath = path; state.svcPick = null; state.sel = null;
  state.overview = false; state.structure = false; state.infraType = null; state.focus = null;
  pushUrl(); render(); renderDetail();
}
// origin: 생략 → 기존 출처 유지(분석 내 이동), 값/ null → 출처 설정
function setFocus(id, origin) {                // 노드 기준 호출관계분석
  if (!nodeById.has(id)) return;
  state.view = null;
  if (origin !== undefined) { state.fromService = origin || null; state.fromOverview = false; }
  state.focus = id; state.sel = id; state.expanded = false; state.overview = false; state.structure = false; state.service = null; state.infraType = null; state.svcPick = null;
  pushUrl(); render(); renderDetail();
}
function clearFocus() {
  state.view = null;
  state.focus = null; state.expanded = false; state.overview = false; state.structure = false; state.service = null; state.infraType = null; state.svcPick = null; state.fromService = null; state.fromOverview = false;
  state.sel = null;
  pushUrl(); render(); renderDetail();
}
function toggleExpand() {
  state.expanded = !state.expanded;
  pushUrl(); render(); renderDetail();
}
function setSel(id) { state.sel = id; pushUrl(); renderDetail(); renderProcessDock(); applyHighlight(); }

// ---- 줌 (트랙패드 핀치 / 버튼) ----
function applyZoom() {
  document.getElementById('zoom-layer').style.zoom = state.zoom;
  const pct = document.getElementById('zoom-pct');
  if (pct) pct.textContent = Math.round(state.zoom * 100) + '%';
  if (currentEdges.length) requestAnimationFrame(drawConnectors);
}
// cx,cy: 화면 좌표 기준 확대 중심(없으면 뷰포트 중앙)
function setZoom(z, cx, cy) {
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const old = state.zoom;
  if (Math.abs(z - old) < 1e-4) return;
  const flow = document.getElementById('flow');
  const r = flow.getBoundingClientRect();
  if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  // 커서 아래 콘텐츠 지점을 줌 전후 고정
  const lx = (flow.scrollLeft + (cx - r.left)) / old;
  const ly = (flow.scrollTop + (cy - r.top)) / old;
  state.zoom = z;
  applyZoom();
  flow.scrollLeft = lx * z - (cx - r.left);
  flow.scrollTop = ly * z - (cy - r.top);
}
function zoomBy(factor, cx, cy) { setZoom(state.zoom * factor, cx, cy); }
function resetZoom() { setZoom(1); }
function setDepth(which, dir) {
  state[which] = Math.max(0, Math.min(6, state[which] + dir));
  pushUrl(); render();
}

// =========================================================================
// 공통 헬퍼
// =========================================================================
function byCallSite(a, b) {
  return (a.callSiteLine == null ? 1e9 : a.callSiteLine) - (b.callSiteLine == null ? 1e9 : b.callSiteLine);
}
function passFilter(id) {
  const n = nodeById.get(id);
  if (!n) return false;
  if (state.hideOther && n.layer === 'OTHER') return false;
  return true;
}
function isInfra(id, n) {
  n = n || nodeById.get(id);
  if (!n) return /^(kafka:|db:|redis$|ext:)/.test(id);
  // RESOURCE 는 공유 인프라. EXTERNAL 은 project 가 없을 때만 공유 인프라(백엔드 서드파티 호출);
  // project 가 붙은 프론트 외부호출 노드는 그 프론트 서비스의 노드로 취급한다.
  return n.layer === 'RESOURCE' || (n.layer === 'EXTERNAL' && !n.project);
}
function kindClass(e) {
  if (e.kind === 'resource') {
    if (e.relation && e.relation.startsWith('kafka')) return 'kafka';
    if (e.relation && e.relation.startsWith('redis')) return 'redis';
    if (e.relation && e.relation.startsWith('db')) return 'db';
  }
  return e.kind || 'internal';
}
function serviceEndpoints(svc) {
  const eps = NODES.filter(n => n.project === svc && n.layer === 'CONTROLLER' && n.endpoint);
  if (eps.length) return eps;
  // 컨트롤러가 없는 서비스(프론트엔드 등) → 화면(SCREEN) 페이지를 기준 목록으로 사용
  return NODES.filter(n => n.project === svc && n.layer === 'SCREEN');
}
function segsOf(ep) { return (ep.endpoint || '').split('/').filter(Boolean); }

// =========================================================================
// 라우팅
// =========================================================================
function render() {
  cardEls.clear();
  pinned.clear();          // 핀(강조 고정)은 뷰 컨텍스트 한정 — 다른 단계로 이동하면 해제
  cleanSynthNodes();       // 이전 뷰의 합성(화면 그룹) 노드 제거
  // 기본 홈 = 전체 서비스 지도. 어떤 뷰도 활성이 아니면(빈 상태/홈 복귀) 전체보기로 떨어진다.
  // (토글 active 표시보다 먼저 처리해야 메뉴 하이라이트가 맞는다.)
  if (!state.view && !state.overview && !state.service && !state.structure && !state.infraType
      && !(state.focus && nodeById.has(state.focus)))
    state.overview = true;
  if (!state.service) state.svcPath = null;   // 서비스 컨텍스트를 벗어나면 경로 드릴 해제
  document.getElementById('grid-toolbar')?.remove();
  if ((!state.service && !state.infraType) || state.svcPath) {
    document.getElementById('svc-filter-wrap')?.remove();   // 경로 드릴 뷰에는 목록 좁히기 필터 없음
    document.getElementById('analysis-bar').classList.remove('svc-mode');
  }
  document.getElementById('analysis-bar').classList.remove('no-depth');
  document.getElementById('overview-btn').classList.toggle('active', state.overview);
  document.getElementById('structure-btn').classList.toggle('active', state.structure);
  document.querySelectorAll('#nav .nav-btn[data-view]').forEach(b => b.classList.toggle('active', state.view === b.dataset.view));
  if (state.view) { renderFeatureView(); return; }
  if (state.overview) renderOverview();
  else if (state.structure) renderStructure();
  else if (state.service && state.svcPath) renderServicePathDrill();
  else if (state.service) renderServiceView();
  else if (state.infraType) renderInfraTypeView();
  else if (state.focus && nodeById.has(state.focus)) renderAnalysis();
  else renderOverview();
  renderProcessDock();
}

// 서비스 보기 선택 노드의 브레드크럼/독 표기: 엔드포인트는 "METHOD /path", 그 외는 메서드명
function pickLabelOf(n) {
  if (n.layer === 'CONTROLLER' && n.endpoint) return `${n.httpMethod || ''} ${n.endpoint}`.trim();
  if (n.layer === 'RESOURCE') return (RES_ICON[n.resourceType] || '⬡') + ' ' + (n.method || n.id);
  if (n.layer === 'EXTERNAL') return n.externalUrl || n.method || n.id;
  return n.method || n.id;
}

// =========================================================================
// 하단 프로세스 독 — 서비스 보기 3단계(노드 선택) 시 application 내부
// controller→service→repository→infra 관계 전체 표시
// =========================================================================
// 3단계 체인 전체의 실행 그래프 수집 — 체인 시작점부터 경계(S2S/Kafka 등)를 넘어 끝까지.
// 서비스가 바뀔 때마다 segment(컬럼 그룹)가 오른쪽으로 이어진다. 인프라 노드는 호출한 서비스의 segment 에 붙인다.
// adjOut/adjIn 기본값 = 현재 컬럼 엣지(currentAdj). 기능 뷰는 실제 그래프 기준 인접을 넘겨 전체 체인을 그린다.
function collectChainFlow(base, adjOut, adjIn) {
  adjOut = adjOut || currentAdjOut;
  adjIn = adjIn || currentAdjIn;
  const bases = Array.isArray(base) ? base : [base];   // 단일/다중 기준 모두 지원
  // 3단계 활성 체인 + 체인 방향 레벨 (피호출 음수 ← 기준 0 → 호출 양수)
  const level = new Map(bases.map(b => [b, 0]));
  for (const [adj, dir] of [[adjOut, 1], [adjIn, -1]]) {
    let frontier = [...bases];
    while (frontier.length) {
      const next = [];
      for (const id of frontier)
        for (const o of adj.get(id) || [])
          if (!level.has(o)) { level.set(o, level.get(id) + dir); next.push(o); }
      frontier = next;
    }
  }
  const active = [...level.keys()];

  const segOfProject = new Map();   // project → segment index
  const segOf = new Map();          // nodeId → segment index
  const segFor = proj => {
    if (!segOfProject.has(proj)) segOfProject.set(proj, segOfProject.size);
    return segOfProject.get(proj);
  };
  // segment 순서 선등록: 체인 레벨이 낮은(왼쪽) 서비스부터
  const projLevel = new Map();
  for (const [id, lv] of level) {
    const nn = nodeById.get(id);
    if (!nn || isInfra(id, nn) || !nn.project) continue;
    if (!projLevel.has(nn.project) || lv < projLevel.get(nn.project)) projLevel.set(nn.project, lv);
  }
  for (const proj of [...projLevel.keys()].sort((a, b) => projLevel.get(a) - projLevel.get(b))) segFor(proj);

  const nodes = []; const nodeSet = new Set();
  const edges = []; const eSeen = new Set();
  let count = 0; const MAX = 200;
  function place(id, callerSeg) {
    const n = nodeById.get(id);
    const seg = isInfra(id, n) ? callerSeg : segFor(n.project || '(unknown)');
    if (nodeSet.has(id)) return;
    nodeSet.add(id); nodes.push(id); segOf.set(id, seg);
    if (count >= MAX) return;
    for (const e of (outEdges.get(id) || []).slice().sort(byCallSite)) {
      if (count >= MAX) break;
      const t = e.target, tn = nodeById.get(t);
      if (!tn || (state.hideOther && tn.layer === 'OTHER')) continue;
      const k = id + '|' + t + '|' + (e.relation || e.kind) + '|' + (e.mode || '');   // 동기/비동기는 별개 엣지로 유지
      if (!eSeen.has(k)) { eSeen.add(k); edges.push(e); count++; }
      if (!nodeSet.has(t)) place(t, seg);   // 내부·경계 구분 없이 끝까지 이어감
    }
  }
  // 체인 시작점(피호출 없는 노드)부터, 이어서 3단계의 모든 활성 노드를 빠짐없이 walk
  const roots = active.filter(id => !(adjIn.get(id) || []).some(s => level.has(s)));
  const seeds = [...roots, ...active.sort((a, b) => level.get(a) - level.get(b))];
  for (const id of seeds) {
    if (nodeSet.has(id)) continue;
    const n = nodeById.get(id);
    if (!n) continue;
    if (state.hideOther && n.layer === 'OTHER') continue;   // OTHER 노이즈는 프로세스 흐름에서도 숨김
    // 인프라 시드는 활성 호출자의 segment 에 붙임 (없으면 0)
    const callerSeg = isInfra(id, n)
      ? (segOf.get((adjIn.get(id) || []).find(s => segOf.has(s))) ?? 0)
      : 0;
    place(id, callerSeg);
  }
  const segLabels = [];
  for (const [proj, idx] of segOfProject) segLabels[idx] = proj;
  return { nodes, edges, segOf, segLabels, truncated: count >= MAX };
}

// 기능 뷰(커밋 영향도 등) 프로세스 독용 — 실제 그래프에서 base 의 다운스트림 폐포로 제한한 인접.
// 컬럼이 경계만 보여줘도, 독에서는 내부 실행 체인 전체(CONTROLLER→SERVICE→…→EXTERNAL)를 그린다.
function downstreamChainAdj(base) {
  const bases = Array.isArray(base) ? base : [base];
  const seen = new Set(bases);
  let frontier = [...bases];
  while (frontier.length) {
    const next = [];
    for (const id of frontier)
      for (const e of (outEdges.get(id) || []))
        if (nodeById.has(e.target) && !seen.has(e.target)) { seen.add(e.target); next.push(e.target); }
    frontier = next;
  }
  const aOut = new Map(), aIn = new Map();
  for (const e of EDGES) {
    if (!seen.has(e.source) || !seen.has(e.target)) continue;
    if (!aOut.has(e.source)) aOut.set(e.source, []);
    if (!aIn.has(e.target)) aIn.set(e.target, []);
    aOut.get(e.source).push(e.target);
    aIn.get(e.target).push(e.source);
  }
  return { aOut, aIn };
}

const DOCK_COLS = [
  ['CONTROLLER', 'Controller'], ['SERVICE', 'Service'], ['COMPONENT', 'Component'],
  ['BATCH', 'Batch'], ['CONFIG', 'Config'], ['REPOSITORY', 'Repository'], ['INFRA', 'Infra / External'],
];
const DOCK_CHIP_COLOR = { Kafka: '--c-kafka', Redis: '--c-redis', DB: '--c-db' };

// 독 미니 노드 카드 — 메서드/엔드포인트/클래스/설명/파일:라인까지 표시
function dockCardEl(id, rootId) {
  const n = nodeById.get(id);
  const el = document.createElement('div');
  el.className = 'dock-node' + (id === rootId ? ' root' : '');
  el.dataset.node = id;
  el.style.setProperty('--lc', (layerColor(n) || '#9ca3af').trim());
  let badge, ep = '', sub = n.fqcn && n.fqcn !== n.id ? shortClass(n.fqcn) : '';
  if (n.layer === 'CONTROLLER') {
    badge = n.httpMethod ? `<span class="nc-badge http ${methodClass(n.httpMethod)}">${esc(n.httpMethod)}</span>` : `<span class="nc-badge">CONTROLLER</span>`;
    if (n.endpoint) ep = `<div class="dn-ep">${esc(n.endpoint)}</div>`;
  } else if (n.layer === 'RESOURCE') {
    badge = `<span class="nc-badge">${RES_ICON[n.resourceType] || '⬡'} ${esc(n.resourceType || 'resource')}</span>`;
    sub = '';
  } else if (n.layer === 'EXTERNAL') {
    badge = `<span class="nc-badge">EXTERNAL</span>`;
    if (n.externalUrl) ep = `<div class="dn-ep">${esc(n.externalUrl)}</div>`;
  } else if (n.layer === 'SCREEN') {
    badge = `<span class="nc-badge screen">🖥 화면</span>`;
  } else {
    badge = `<span class="nc-badge">${esc(n.layer || 'OTHER')}</span>`;   // 축약 없이 레이어 풀네임
  }
  const file = n.file ? `<div class="dn-file">${esc(n.file.split('/').pop())}${n.line ? ':' + n.line : ''}</div>` : '';
  const desc = n.description ? `<div class="dn-desc">${esc(n.description)}</div>` : '';
  el.innerHTML = `<div class="dn-top">${badge}${n.async ? '<span class="nc-async">async</span>' : ''}</div>`
    + `<div class="dn-name">${esc(n.method || id)}</div>` + ep
    + (sub ? `<div class="dn-sub">${esc(sub)}</div>` : '') + desc + file;
  el.title = [n.fqcn, n.file ? n.file + (n.line ? ':' + n.line : '') : null, n.description].filter(Boolean).join('\n');
  return el;
}

// 독 내부 SVG 연결선 — kind 색/화살표/sync·async 구분/relation 라벨 (hoverId: 연결선 강조)
function drawDockConnectors(dock, edges, elOf, hoverId) {
  const wrap = dock.querySelector('.dock-flow');
  const svg = dock.querySelector('.dock-svg');
  if (!wrap || !svg || !wrap.offsetParent) return;
  const wr = wrap.getBoundingClientRect();
  svg.setAttribute('width', wrap.scrollWidth);
  svg.setAttribute('height', wrap.scrollHeight);
  const used = new Set();
  let paths = '', labels = '';
  for (const e of edges) {
    const sc = elOf.get(e.source), tc = elOf.get(e.target);
    if (!sc || !tc) continue;
    const sr = sc.getBoundingClientRect(), tr = tc.getBoundingClientRect();
    const y1 = sr.top + sr.height / 2 - wr.top, y2 = tr.top + tr.height / 2 - wr.top;
    let x1, x2;
    if (tr.left >= sr.right - 1) { x1 = sr.right - wr.left; x2 = tr.left - wr.left; }
    else if (tr.right <= sr.left + 1) { x1 = sr.left - wr.left; x2 = tr.right - wr.left; }
    else { x1 = sr.right - wr.left; x2 = tr.left - wr.left; }
    const fwd = x2 >= x1;
    const dx = Math.max(24, Math.abs(x2 - x1) * 0.45);
    const kc = kindClass(e); used.add(kc);
    const isAsync = e.mode === 'async';
    const stateCls = hoverId ? (e.source === hoverId || e.target === hoverId ? ' hot' : ' dim') : '';
    paths += `<path class="edge-path k-${kc}${isAsync ? ' async' : ''}${stateCls}" `
      + `d="M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + (fwd ? dx : -dx)).toFixed(1)},${y1.toFixed(1)} ${(x2 - (fwd ? dx : -dx)).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" `
      + `marker-end="url(#dk-${kc})"/>`;
    let rel = e.kind === 'resource' ? (e.relation || '') : e.kind === 's2s' ? 'S2S' : e.kind === 'external' ? 'EXT' : '';
    if (isAsync) rel = rel ? rel + ' · async' : 'async';
    if (rel) labels += `<text class="edge-label dock-el${stateCls}" x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2) / 2 - 5).toFixed(1)}" fill="${KIND_COLOR[kc] || '#94a3b8'}">${esc(rel)}</text>`;
  }
  let defs = '<defs>';
  for (const kc of used)
    defs += `<marker id="dk-${kc}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${KIND_COLOR[kc] || '#94a3b8'}"/></marker>`;
  svg.innerHTML = defs + '</defs>' + paths + labels;
}

// 같은 레이어 노드들을 호출 깊이별로 나눈다 — 예: service→service 호출이 있으면 옆 컬럼으로 확장
// 반환: Map(depth → [nodeId…]). 호출 관계가 없으면 전부 depth 0.
function layerCallDepth(nids, edgeList) {
  const set = new Set(nids);
  const adj = new Map(nids.map(id => [id, []]));
  for (const e of edgeList)
    if (e.source !== e.target && set.has(e.source) && set.has(e.target)) adj.get(e.source).push(e.target);
  const level = new Map(nids.map(id => [id, 0]));
  // 최장경로 레벨링 (사이클은 패스 수·상한으로 가드)
  for (let pass = 0; pass < nids.length; pass++) {
    let changed = false;
    for (const u of nids) for (const v of adj.get(u)) {
      const nl = Math.min(level.get(u) + 1, nids.length - 1);
      if (level.get(v) < nl) { level.set(v, nl); changed = true; }
    }
    if (!changed) break;
  }
  const byLevel = new Map();
  for (const id of nids) {
    const lv = level.get(id);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(id);
  }
  return byLevel;
}

let dockDraw = null;     // 창 크기 변경 시 재그리기용
let dockFeature = false;  // 기능 뷰(커밋 영향도 등)가 state.sel 기준으로 프로세스 독을 요청
function renderProcessDock() {
  const dock = document.getElementById('process-dock');
  // 서비스 보기 = svcPick 기준(현재 컬럼 엣지), 기능 뷰 = 선택 노드(state.sel) 기준(실제 그래프 체인)
  const svcMode = !!state.service;
  const base = svcMode ? state.svcPick : (dockFeature ? state.sel : null);
  if (!base || !nodeById.has(base)) { dock.classList.add('hidden'); dock.innerHTML = ''; dockDraw = null; return; }
  const n = nodeById.get(base);
  const { nodes, edges, segOf, segLabels, truncated } = svcMode
    ? collectChainFlow(base)
    : (() => { const { aOut, aIn } = downstreamChainAdj(base); return collectChainFlow(base, aOut, aIn); })();

  // 레이어 구성 요약 칩
  const counts = new Map();
  for (const nid of nodes) {
    const nn = nodeById.get(nid);
    const key = nn.layer === 'RESOURCE'
      ? (nn.resourceType === 'kafka-topic' ? 'Kafka' : nn.resourceType === 'db-table' ? 'DB' : 'Redis')
      : nn.layer;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const cs = getComputedStyle(document.documentElement);
  const chipOrder = ['CONTROLLER', 'SERVICE', 'COMPONENT', 'BATCH', 'CONFIG', 'REPOSITORY', 'EXTERNAL', 'Kafka', 'Redis', 'DB'];
  const chips = chipOrder.filter(k => counts.has(k)).map(k => {
    const color = cs.getPropertyValue(DOCK_CHIP_COLOR[k] || ('--c-' + (LAYER_CLASS[k] || 'other')));
    return `<span class="dock-chip"><i style="background:${color}"></i>${esc(k)}${counts.get(k) > 1 ? ' ×' + counts.get(k) : ''}</span>`;
  }).join('<span class="dock-arrow">→</span>');

  dock.innerHTML = `
    <div class="dock-resizer" title="드래그해서 높이 조절"></div>
    <div class="dock-head">
      <span class="dock-title">🧭 프로세스 흐름 <b>${esc(pickLabelOf(n))}</b><span class="ab-proj">체인 전체</span></span>
      <span class="dock-path">${chips}</span>
      <span class="ab-proj">노드 ${nodes.length} · 호출 ${edges.length}${truncated ? ' (일부만 표시)' : ''}</span>
      <span class="dock-legend"><i class="dl-solid"></i>sync<i class="dl-dash"></i>async</span>
      <button class="dock-close" title="선택 해제">✕</button>
    </div>
    ${n.description ? `<div class="dock-desc">${esc(n.description)}</div>` : ''}
    <div class="dock-body"><div class="dock-flow"><svg class="dock-svg"></svg><div class="dock-cols"></div></div></div>`;

  // segment(서비스)별로 레이어 컬럼을 오른쪽으로 이어 배치:
  //   [svc A] controller → service → … → infra | [svc B] controller → … | …
  const colsEl = dock.querySelector('.dock-cols');
  const elOf = new Map();
  const colKeyOf = nn => isInfra(nn.id, nn) ? 'INFRA' : (nn.layer || 'OTHER');
  for (let s = 0; s < segLabels.length; s++) {
    const segNodes = nodes.filter(nid => segOf.get(nid) === s);
    if (!segNodes.length) continue;
    const groups = new Map();
    for (const nid of segNodes) {
      const k = colKeyOf(nodeById.get(nid));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(nid);
    }
    const segEl = document.createElement('div');
    segEl.className = 'dock-seg';
    segEl.innerHTML = `<div class="dock-seg-head">${esc(segLabels[s])}</div><div class="dock-seg-cols"></div>`;
    const segCols = segEl.querySelector('.dock-seg-cols');
    const appendCol = (label, list) => {
      const col = document.createElement('div');
      col.className = 'dock-col';
      col.innerHTML = `<div class="dock-col-head">${esc(label)} · ${list.length}</div>`;
      for (const nid of list) { const card = dockCardEl(nid, base); col.appendChild(card); elOf.set(nid, card); }
      segCols.appendChild(col);
    };
    for (const [key, label] of DOCK_COLS) {
      if (!groups.has(key)) continue;
      const list = groups.get(key);
      groups.delete(key);
      // SERVICE 가 다른 SERVICE 를 호출하면 호출 깊이별로 컬럼을 나눠 옆으로 펼친다
      if (key === 'SERVICE' && list.length > 1) {
        const byLevel = layerCallDepth(list, edges);
        const lvs = [...byLevel.keys()].sort((a, b) => a - b);
        if (lvs.length > 1) { lvs.forEach((lv, i) => appendCol(`${label} ${i + 1}`, byLevel.get(lv))); continue; }
      }
      appendCol(label, list);
    }
    for (const [key, list] of groups) appendCol(key, list);   // 정의 밖 레이어 잔여
    colsEl.appendChild(segEl);
  }

  dock.querySelector('.dock-close').addEventListener('click', () =>
    svcMode ? setServicePick(state.svcPick) : setSel(null));
  const savedH = parseInt(localStorage.getItem('fm.dockH'), 10);
  if (savedH) dock.style.height = savedH + 'px';
  dock.querySelector('.dock-resizer').addEventListener('mousedown', e => startDockResize(e, dock));
  dock.classList.remove('hidden');

  // hover/클릭 강조: 마우스 오버 시 연결 노드만 강조(.overlay+dim), 노드를 클릭하면 그 강조를 고정(pin)
  let hoverId = null, pinnedId = null;
  const applyDockHover = () => {
    const active = hoverId || pinnedId;
    const neighbors = new Set();
    if (active) for (const e of edges) {
      if (e.source === active) neighbors.add(e.target);
      if (e.target === active) neighbors.add(e.source);
    }
    for (const [nid, el] of elOf) {
      el.classList.toggle('dim', !!active && nid !== active && !neighbors.has(nid));
      el.classList.toggle('pinned', nid === pinnedId);
    }
    dock.querySelector('.dock-svg').classList.toggle('overlay', !!active);
    drawDockConnectors(dock, edges, elOf, active);
  };
  for (const [nid, el] of elOf) {
    el.addEventListener('mouseenter', () => { hoverId = nid; applyDockHover(); });
    el.addEventListener('mouseleave', () => { hoverId = null; applyDockHover(); });
    el.addEventListener('click', () => { pinnedId = pinnedId === nid ? null : nid; hoverId = null; applyDockHover(); });
  }
  dockDraw = () => drawDockConnectors(dock, edges, elOf, hoverId || pinnedId);
  requestAnimationFrame(dockDraw);
}

// ---- 패널 크기 조절 (하단 독 높이 / 상세 패널 너비) ----
function dragResize(e, handle, onMove, onEnd) {
  e.preventDefault();
  handle.classList.add('active');
  const move = ev => {
    onMove(ev);
    if (currentEdges.length) requestAnimationFrame(drawConnectors);
    if (dockDraw) requestAnimationFrame(dockDraw);
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    handle.classList.remove('active');
    onEnd();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
function startDockResize(e, dock) {
  const startY = e.clientY, startH = dock.getBoundingClientRect().height;
  dragResize(e, e.target,
    ev => {
      const h = Math.max(140, Math.min(window.innerHeight * 0.8, startH + (startY - ev.clientY)));
      dock.style.height = h + 'px';
    },
    () => localStorage.setItem('fm.dockH', Math.round(dock.getBoundingClientRect().height)));
}
function setupDetailResizer() {
  const handle = document.getElementById('detail-resizer');
  const detail = document.getElementById('detail');
  const savedW = parseInt(localStorage.getItem('fm.detailW'), 10);
  if (savedW) detail.style.width = savedW + 'px';
  handle.addEventListener('mousedown', e => {
    const startX = e.clientX, startW = detail.getBoundingClientRect().width;
    dragResize(e, handle,
      ev => {
        const w = Math.max(240, Math.min(window.innerWidth * 0.6, startW + (startX - ev.clientX)));
        detail.style.width = w + 'px';
      },
      () => localStorage.setItem('fm.detailW', Math.round(detail.getBoundingClientRect().width)));
  });
}

// =========================================================================
// 서비스 보기 — 전체보기 → 서비스의 모든 API + 호출/피호출 관계
// =========================================================================
const LAYER_FLOW = ['CONTROLLER', 'SERVICE', 'COMPONENT', 'REPOSITORY', 'CONFIG', 'BATCH', 'EXTERNAL', 'RESOURCE'];
const byNodeName = (a, b) => String(a.endpoint || a.method || a.id).localeCompare(String(b.endpoint || b.method || b.id));

function renderServiceView() {
  const svc = state.service;
  const eps = serviceEndpoints(svc);                 // 1단계 path로 그룹할 기준 API
  // 프론트/백엔드 동일: base·단계 노드를 모두 {path1}/{path2} 그룹 합성노드 하나로 묶고,
  // 단계의 인프라(DB/Redis/Kafka)는 숨긴다(드릴 뷰에서 표시).
  const epsAreScreens = eps.length > 0 && eps.every(n => n.layer === 'SCREEN');
  const hideInfra = true;
  const baseUnit = epsAreScreens ? '화면' : 'API';
  const pgMap = new Map();         // gid → { key, project, layer, members:Set } — 화면/API 경로 그룹
  const pathGroupId = id => {      // 노드 → 그 서비스의 {path1}/{path2} 그룹 합성노드 id
    const n = nodeById.get(id);
    if (!n || !n.project || isInfra(id, n)) return id;
    const key = pathKeyOf(n);
    const gid = 'spath:' + n.project + ':' + key;
    let g = pgMap.get(gid);
    if (!g) {
      g = { key, project: n.project, layer: n.layer, members: new Set() };
      pgMap.set(gid, g);
      nodeById.set(gid, { id: gid, layer: n.layer, project: n.project, method: key,
        endpoint: null, httpMethod: null, fqcn: null, description: null, _synthetic: 'pathgroup' });
      synthNodeIds.push(gid);
    }
    g.members.add(id);
    return gid;
  };
  const epOf = new Map();
  for (const ep of eps) epOf.set(ep.id, pathGroupId(ep.id));
  const epId = id => epOf.get(id) || id;             // base 노드 → 그 path 그룹 id
  const baseGids = [...new Set(epOf.values())];
  const epIds = new Set(baseGids);
  const onActivate = id => setFocus(id, svc);        // 중심 ⟲ 버튼 → 호출관계분석 드릴다운
  const onPick = id => {                             // 카드 클릭 → 활성화된 연결 노드만 단계 필터
    // 3단계(기준 노드 선택 후)에서는 어떤 노드를 클릭해도 기준 유지 — 선택만 이동(하단 흐름도 갱신)
    // 해제는 브레드크럼 서비스명 / Esc / 독 ✕ 로만
    if (state.svcPick) { setSel(id); return; }
    setServicePick(id);
  };

  const bar = document.getElementById('analysis-bar');
  bar.classList.remove('hidden');
  bar.classList.add('svc-mode', 'no-depth');
  document.getElementById('back-to-browse').textContent = '⟵ 전체보기';
  const pickNode = state.svcPick ? nodeById.get(state.svcPick) : null;
  document.getElementById('ab-focus').innerHTML =
    `<span class="ab-focus-label svc">서비스</span> <b>${esc(svc)}</b>`
    + `<span class="ab-proj">${eps.length} APIs</span>`;

  // 브레드크럼: 전체보기 › 서비스 (노드 선택 시 › {METHOD} {API PATH} 3단계)
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-root">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span>`
    + (pickNode
      ? `<a class="bc-link" id="bc-svc">${esc(svc)}</a>`
        + `<span class="bc-sep">›</span><span class="bc-focus">${esc(pickLabelOf(pickNode))}</span>`
      : `<span class="bc-focus">${esc(svc)}</span>`);
  bc.querySelector('#bc-root').addEventListener('click', () => setOverview(true));
  bc.querySelector('#bc-svc')?.addEventListener('click', () => setService(svc));

  // 교차-경계 엣지를 source-서비스(out) / target-서비스(in) 별로 인덱싱
  const crossOut = new Map(), crossIn = new Map();
  for (const e of EDGES) {
    if (e.kind !== 's2s' && e.kind !== 'resource' && e.kind !== 'external' && e.kind !== 'join') continue;
    const sn = nodeById.get(e.source), tn = nodeById.get(e.target);
    if (!sn || !tn) continue;
    if (sn.project && !isInfra(e.source, sn)) { (crossOut.get(sn.project) || crossOut.set(sn.project, []).get(sn.project)).push(e); }
    if (tn.project && !isInfra(e.target, tn)) { (crossIn.get(tn.project) || crossIn.set(tn.project, []).get(tn.project)).push(e); }
  }
  const bucketOf = id => {
    const n = nodeById.get(id);
    if (n && n.project && !isInfra(id, n)) return { key: 'svc:' + n.project, label: n.project, rank: 0, svc: n.project };
    const t = infraGroup(id);
    // 외부 API 는 호출 대상 호스트(externalService) 단위로 묶어 단일 노드로 보여준다
    if (t === 'external') {
      const client = (n && n.externalService) || ((id.split(':')[1] || '').split(/[ #/]/)[1]) || '외부';
      return { key: 'ext:' + client, label: '🌐 ' + client, rank: 4, svc: null };
    }
    return { key: 'infra:' + t, label: INFRA_ICON[t] + ' ' + INFRA_LABEL[t], rank: ({ kafka: 1, redis: 2, db: 3, external: 4, other: 5 })[t] || 5, svc: null };
  };
  const orphan = new Set();          // 기준 컬럼에 보강할 호출부/내부 노드
  const derived = [];
  const seen = new Set();
  const addEdge = (s, t, e) => { const k = s + '|' + t; if (s && t && !seen.has(k)) { seen.add(k); derived.push({ source: s, target: t, kind: e.kind, relation: e.relation, mode: e.mode }); } };

  // 관계(호출/피호출) 노드는 전체보기와 동일하게 "단일 서비스 노드" 로 축약한다.
  //   기준(클릭한) 서비스만 base 컬럼에서 {path1}/{path2} 2-depth 그룹으로 펼치고,
  //   나머지 연결 서비스는 그 서비스의 모든 노드를 svc:<project> 대표 노드 하나로 합친다.
  const displayFar = id => {
    const n = nodeById.get(id);
    if (!n) return [id];
    if (n.project && !isInfra(id, n)) return ['svc:' + n.project];   // 연결 서비스 → 단일 서비스 노드
    return [bucketOf(id).key];   // 외부/인프라 → 호스트/타입 단위 단일 대표 노드
  };

  // 방향별 스텝 BFS (서비스/인프라 단위로 한 단계씩 확장, 노드는 실제 대상)
  function bfsSteps(dir) {
    const adj = dir === 'out' ? crossOut : crossIn;
    const steps = [], rep = new Map(), expanded = new Set([svc]);
    let frontier = [svc];
    for (let step = 1; step <= 6 && frontier.length; step++) {
      const m = new Map();
      for (const S of frontier) {
        for (const e of adj.get(S) || []) {
          const farId = dir === 'out' ? e.target : e.source;   // 상대편 노드
          const fn = nodeById.get(farId);
          if (!fn) continue;
          const b = bucketOf(farId);
          // 같은 서비스 안에 머무는 엣지(원점 복귀 + 프론트 store→ext 같은 서비스-내부 호출)는 단계 확장 대상이 아니다.
          // 이걸 타면 rep(대표 노드) 배선이 서비스 내부에서 엉켜 가짜 엣지가 생기고 hover 강조가 전체를 끈다.
          if (b.svc === S || b.svc === svc) continue;
          if (hideInfra && b.key.startsWith('infra:')) continue;   // 프론트 뷰: DB/Redis/Kafka 인프라 숨김
          const fars = displayFar(farId);                       // 연결 노드 → 서비스/외부 단일 대표
          if (!m.has(b.key)) m.set(b.key, { key: b.key, label: b.label, rank: b.rank, svc: b.svc, members: new Set() });
          m.get(b.key).members.add(farId);                      // 실제 대상 노드(카드 개수 표기용)
          // 연결선 (기준 화면은 path1 그룹 노드로 합쳐 연결)
          if (S === svc) {
            if (dir === 'out') {
              const reps = [...new Set(resolveEndpoints(e.source).map(epId))].filter(x => epIds.has(x));
              if (reps.length) reps.forEach(ep => fars.forEach(f => addEdge(ep, f, e)));
              else { orphan.add(e.source); fars.forEach(f => addEdge(e.source, f, e)); }
            } else {
              const tgt = epId(e.target);
              if (epIds.has(tgt)) fars.forEach(f => addEdge(f, tgt, e));
              else { orphan.add(e.target); fars.forEach(f => addEdge(f, e.target, e)); }
            }
          } else {
            const r = rep.get('svc:' + S);
            if (r) fars.forEach(f => dir === 'out' ? addEdge(r, f, e) : addEdge(f, r, e));
          }
          if (b.svc && !rep.has('svc:' + b.svc)) rep.set('svc:' + b.svc, fars[0]);
        }
      }
      if (!m.size) break;
      steps.push(m);
      const next = [];
      for (const g of m.values()) if (g.svc && !expanded.has(g.svc)) { expanded.add(g.svc); next.push(g.svc); }
      frontier = next;
    }
    return steps;
  }
  const fSteps = bfsSteps('out');   // 호출 단계 (오른쪽)
  const bSteps = bfsSteps('in');    // 피호출 단계 (왼쪽)
  // 경로 그룹 노드의 멤버 수를 카드 설명으로 표기 (화면/API)
  for (const [gid, g] of pgMap) {
    const node = nodeById.get(gid);
    if (node) node.description = `${g.members.size}개 ${g.layer === 'SCREEN' ? '화면' : 'API'}`;
  }

  // 서비스 카드용 통계(전체보기와 동일: endpoints / nodes)
  const stats = {};
  for (const s of META.projects) stats[s] = { eps: 0, nodes: 0 };
  for (const n of NODES) if (n.project && stats[n.project]) {
    stats[n.project].nodes++;
    if (n.layer === 'CONTROLLER' && n.endpoint) stats[n.project].eps++;
  }

  const colsEl = document.getElementById('columns');
  colsEl.className = 'svc-view';     // 노드 카드를 전체보기 카드 외형으로 통일(style.css)
  colsEl.innerHTML = '';

  const renderStep = (stepMap, headLabel) => {
    const col = document.createElement('div');
    col.className = 'column step-col';
    col.appendChild(mkHead(headLabel));
    for (const bkt of [...stepMap.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))) {
      if (bkt.svc) col.appendChild(makeServiceCard(bkt.svc, stats[bkt.svc] || { eps: 0, nodes: 0 }));   // 연결 서비스 = 단일 서비스 카드(전체보기와 동일)
      else col.appendChild(makeStepBucketCard(bkt));   // 외부/인프라 = 단일 축약 카드
    }
    colsEl.appendChild(col);
  };

  // 피호출 단계 (왼쪽, 깊은 단계가 가장 바깥)
  for (let i = bSteps.length - 1; i >= 0; i--) renderStep(bSteps[i], `피호출 ${i + 1}단계`);

  // 기준 컬럼 (중앙): base 를 {path1}/{path2} 그룹 노드 한 장씩 (화면/API 공통). 클릭 → 그 경로 드릴
  const col0 = document.createElement('div');
  col0.className = 'column base svc-base';
  col0.appendChild(mkHead(`${baseUnit} 그룹 · ${baseGids.length}`));
  for (const gid of baseGids.slice().sort((a, b) => {
        const ka = pgMap.get(a).key, kb = pgMap.get(b).key;
        return ka === '/' ? 1 : kb === '/' ? -1 : ka.localeCompare(kb);
      })) {
    const g = pgMap.get(gid);
    const card = makeCard(gid, { onActivate: () => setSvcPath(svc, g.key) });   // 클릭 → 경로 드릴(프로세스 흐름)
    card.dataset.filter = g.key.toLowerCase();
    col0.appendChild(card);
  }
  colsEl.appendChild(col0);

  // 호출 단계 (오른쪽)
  for (let i = 0; i < fSteps.length; i++) renderStep(fSteps[i], `호출 ${i + 1}단계`);

  currentEdges = derived.filter(e => cardEls.has(e.source) && cardEls.has(e.target));
  buildCurrentAdj();
  setupServiceFilter(baseGids.length);
  requestAnimationFrame(() => {
    pruneOrphans(); applyPickFilter(); drawConnectors(); applyHighlight();
    // 어느 서비스를 눌러도 동일하게 — 선택한 서비스의 그룹(base) 컬럼을 먼저 보이도록 가로 스크롤 정렬
    // (백엔드는 왼쪽에 피호출 단계가 있어 base 가 가운데로 밀리므로, 클릭 직후 base 로 스크롤)
    if (!state.svcPick) {
      const flow = document.getElementById('flow'), base = colsEl.querySelector('.svc-base');
      if (flow && base) flow.scrollLeft += base.getBoundingClientRect().left - flow.getBoundingClientRect().left - 24;
    }
  });
}

// 전체보기 → 서비스(프론트) → {path1} 그룹 드릴:
//   그 경로의 화면들과 다운스트림(연관) 노드 전체를, 서비스(segment)별 레이어 컬럼으로 펼친 프로세스 흐름.
//   (기존 하단 독에 있던 프로세스 흐름을 이 단계의 본 화면으로 옮긴 것)
const DRILL_LAYER_ORDER = ['SCREEN', 'STORE', 'HOOK', 'CONTROLLER', 'SERVICE', 'COMPONENT', 'REPOSITORY', 'CONFIG', 'BATCH', 'API', 'EXTERNAL', 'RESOURCE', 'OTHER'];
function renderServicePathDrill() {
  const svc = state.service, key = state.svcPath;
  const baseEps = serviceEndpoints(svc).filter(n => pathKeyOf(n) === key);   // 화면 또는 API 엔드포인트
  const members = baseEps.map(n => n.id);
  const unit = baseEps.length && baseEps[0].layer === 'SCREEN' ? '화면' : 'API';

  const bar = document.getElementById('analysis-bar');
  bar.classList.remove('hidden');
  bar.classList.add('svc-mode', 'no-depth');
  document.getElementById('back-to-browse').textContent = '⟵ 전체보기';
  document.getElementById('ab-focus').innerHTML =
    `<span class="ab-focus-label svc">${unit} 그룹</span> <b>${esc(key)}</b>`
    + `<span class="ab-proj">${members.length}개 ${unit} · 프로세스 흐름</span>`;

  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-root">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span>`
    + `<a class="bc-link" id="bc-svc">${esc(svc)}</a>`
    + `<span class="bc-sep">›</span><span class="bc-focus">${esc(key)}</span>`;
  bc.querySelector('#bc-root').addEventListener('click', () => setOverview(true));
  bc.querySelector('#bc-svc').addEventListener('click', () => setService(svc));

  const colsEl = document.getElementById('columns');
  colsEl.className = 'struct-flow';
  colsEl.innerHTML = '';
  if (!members.length) {
    colsEl.innerHTML = `<div class="browse-empty">이 경로의 노드를 찾을 수 없습니다.</div>`;
    currentEdges = []; buildCurrentAdj();
    requestAnimationFrame(() => { document.getElementById('connectors').innerHTML = ''; });
    return;
  }

  // 실제 그래프 기준 다운스트림 체인(화면 → store/axios → 백엔드 → … → infra)
  const { aOut, aIn } = downstreamChainAdj(members);
  const { nodes, edges, segOf, segLabels } = collectChainFlow(members, aOut, aIn);

  // 다른 프론트(generic vuex id 충돌로 끼어드는) segment 는 제외 — 이 서비스 + 백엔드만 흐름에 남긴다.
  const otherFront = new Set((MANIFEST ? MANIFEST.projects : [])
    .filter(p => p.type === 'frontend' && p.name !== svc).map(p => p.name));

  // 서비스(segment)별 컬럼 → 그 안에서 레이어별 박스 (호출 방향 왼→오)
  for (let s = 0; s < segLabels.length; s++) {
    if (otherFront.has(segLabels[s])) continue;
    const segNodes = nodes.filter(id => segOf.get(id) === s);
    if (!segNodes.length) continue;
    const col = document.createElement('div');
    col.className = 'column';
    col.appendChild(mkHead(segLabels[s]));
    const present = [...new Set(segNodes.map(id => (nodeById.get(id) || {}).layer))]
      .sort((a, b) => (DRILL_LAYER_ORDER.indexOf(a) + 1 || 99) - (DRILL_LAYER_ORDER.indexOf(b) + 1 || 99));
    for (const layer of present) {
      const ids = segNodes.filter(id => (nodeById.get(id) || {}).layer === layer)
        .sort((a, b) => byNodeName(nodeById.get(a), nodeById.get(b)));
      appendGroupBox(col, STRUCT_LAYER_HEAD[layer] || layer, ids.map(id => nodeById.get(id)), null, null);
    }
    colsEl.appendChild(col);
  }

  currentEdges = edges.filter(e => cardEls.has(e.source) && cardEls.has(e.target));
  buildCurrentAdj();
  requestAnimationFrame(() => { drawConnectors(); applyHighlight(); });
}

// 내부 노드를 호출하는 같은 서비스의 진입점(controller 엔드포인트 / 프론트 화면)으로 거슬러 해석 (없으면 자기 자신)
function resolveEndpoints(startId) {
  const start = nodeById.get(startId);
  if (!start) return [startId];
  if (start.layer === 'CONTROLLER' || start.layer === 'SCREEN') return [startId];
  const proj = start.project;
  const seen = new Set([startId]);
  const found = [];
  let frontier = [startId];
  for (let d = 0; d < 8 && found.length < 6; d++) {
    const next = [];
    for (const id of frontier)
      for (const e of inEdges.get(id) || []) {
        const s = e.source, sn = nodeById.get(s);
        // 같은 프로젝트 안에서만 거슬러 올라간다 (s2s/resource 는 다른 프로젝트·인프라라 자동 제외).
        // 프론트는 store→axios 가 internal 이 아니므로 kind 제한 없이 같은-프로젝트 체인을 따른다.
        if (!sn || sn.project !== proj || seen.has(s)) continue;
        seen.add(s);
        if (sn.layer === 'CONTROLLER' || sn.layer === 'SCREEN') { if (!found.includes(s)) found.push(s); }
        else next.push(s);
      }
    frontier = next; if (!next.length) break;
  }
  return found.length ? found : [startId];
}

function mkHead(text) {
  const h = document.createElement('div');
  h.className = 'column-head';
  h.textContent = text;
  return h;
}
// 기준 컬럼 맨 위 "연결된 노드만" 토글
function orphanToggleEl() {
  const wrap = document.createElement('label');
  wrap.className = 'col-orphan-toggle';
  wrap.title = '호출/피호출 관계가 없는 노드를 숨깁니다';
  wrap.innerHTML = `<input type="checkbox" ${state.hideOrphans ? 'checked' : ''}> 연결된 노드만`;
  wrap.querySelector('input').addEventListener('change', e => { state.hideOrphans = e.target.checked; render(); });
  return wrap;
}
// 노드 목록을 테두리 박스로 (label=null 이면 헤더 없이 박스만)
function appendGroupBox(col, label, nodeList, onActivate, onPick) {
  const box = document.createElement('div');
  box.className = 'path-group';
  box.dataset.path = label || '';
  if (label != null) box.innerHTML = `<div class="pg-head"><span class="pg-path">${esc(label)}</span><span class="pg-count">${nodeList.length}</span></div>`;
  const body = document.createElement('div');
  body.className = 'pg-body';
  for (const n of nodeList) {
    const isApi = n.layer === 'CONTROLLER' && n.endpoint;
    const card = makeCard(n.id, { route: isApi, onActivate, onPick });
    card.dataset.filter = [n.endpoint, n.httpMethod, n.method, n.fqcn, n.description, n.externalUrl].filter(Boolean).join(' ').toLowerCase();
    body.appendChild(card);
  }
  box.appendChild(body);
  col.appendChild(box);
}

// 인프라/외부 타입 보기 — 전체보기 → 타입의 모든 노드 + 호출/피호출 관계 (서비스 보기와 동일 레이아웃)
function renderInfraTypeView() {
  const type = state.infraType;
  const bases = NODES.filter(n => isInfra(n.id, n) && infraGroup(n.id) === type).map(n => n.id);

  const bar = document.getElementById('analysis-bar');
  bar.classList.remove('hidden');
  bar.classList.add('svc-mode', 'no-depth');
  document.getElementById('back-to-browse').textContent = '⟵ 전체보기';
  document.getElementById('ab-focus').innerHTML =
    `<span class="ab-focus-label svc">${INFRA_ICON[type]} 인프라</span> <b>${esc(INFRA_LABEL[type])}</b>`
    + `<span class="ab-proj">${bases.length}개</span>`;

  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-overview">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span><span class="bc-focus">${INFRA_ICON[type]} ${esc(INFRA_LABEL[type])}</span>`;
  bc.querySelector('#bc-overview').addEventListener('click', () => setOverview(true));

  renderRelationColumns(bases, c => `${esc(INFRA_LABEL[type])} · ${c}`, id => setFocusFromOverview(id), infraBoxKey);
}

// 인프라/외부 노드의 그룹 박스 키 (외부는 클라이언트 클래스, 그 외는 타입)
function infraBoxKey(n) {
  const id = n.id;
  if (/^ext:/.test(id)) return id.slice(4).split('#')[0] || '외부';
  if (/^kafka:/.test(id)) return '토픽';
  if (/^db:/.test(id)) return '테이블';
  if (/redis/.test(id)) return 'Redis';
  return n.resourceType || '리소스';
}

// 서비스/인프라 공통: 피호출 ← (그룹 박스: 기준 목록) → 호출 열 렌더 + 목록 필터 (깊이 1단계 고정)
function renderRelationColumns(bases, baseHeadLabel, onActivate, keyOf) {
  const { assigned, columns } = computeColumns(bases, false);
  const levels = [...columns.keys()].sort((a, b) => a - b);
  const colsEl = document.getElementById('columns');
  colsEl.className = '';
  colsEl.innerHTML = '';
  for (const lv of levels) {
    const col = document.createElement('div');
    col.className = 'column' + (lv === 0 ? ' base svc-base' : '');
    if (lv === 0) col.appendChild(orphanToggleEl());
    const head = document.createElement('div');
    head.className = 'column-head';
    head.textContent = lv === 0 ? baseHeadLabel(columns.get(0).length) : lv < 0 ? `피호출 ${-lv}` : `호출 ${lv}`;
    col.appendChild(head);
    if (lv === 0) renderGroupedBoxes(col, columns.get(0), onActivate, keyOf);
    else for (const id of columns.get(lv)) col.appendChild(makeCard(id, { onActivate }));
    colsEl.appendChild(col);
  }
  currentEdges = EDGES.filter(e => assigned.has(e.source) && assigned.has(e.target));
  buildCurrentAdj();
  setupServiceFilter(columns.get(0).length);
  requestAnimationFrame(() => { pruneOrphans(); drawConnectors(); applyHighlight(); });
}

// 기준 목록을 그룹 키별 박스로 (col 에 추가)
function renderGroupedBoxes(col, ids, onActivate, keyOf, onPick) {
  const groups = new Map();
  for (const id of ids) {
    const n = nodeById.get(id);
    const key = keyOf(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const order = [...groups.keys()].sort((a, b) => a === '/' ? 1 : b === '/' ? -1 : String(a).localeCompare(String(b)));
  for (const key of order) {
    const list = groups.get(key).slice().sort((a, b) => {
      const c = (a.endpoint || a.method || '').localeCompare(b.endpoint || b.method || '');
      return c !== 0 ? c : methodRank(a.httpMethod) - methodRank(b.httpMethod);
    });
    const box = document.createElement('div');
    box.className = 'path-group';
    box.dataset.path = key;
    box.innerHTML = `<div class="pg-head"><span class="pg-path">${esc(key)}</span><span class="pg-count">${list.length}</span></div>`;
    const body = document.createElement('div');
    body.className = 'pg-body';
    for (const n of list) {
      const isApi = n.layer === 'CONTROLLER' && n.endpoint;
      const card = makeCard(n.id, { route: isApi, onActivate, onPick });
      card.dataset.filter = [n.endpoint, n.httpMethod, n.method, n.fqcn, n.description, n.externalUrl].filter(Boolean).join(' ').toLowerCase();
      body.appendChild(card);
    }
    box.appendChild(body);
    col.appendChild(box);
  }
}

// 서비스 API 목록 좁히기 (중앙 컬럼 카드 필터)
function setupServiceFilter(total) {
  const bar = document.getElementById('analysis-bar');
  let wrap = document.getElementById('svc-filter-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'svc-filter-wrap';
    wrap.innerHTML = `<input id="svc-filter" type="text" autocomplete="off" spellcheck="false" placeholder="목록 좁히기…">`
      + `<span id="svc-filter-count" class="grid-count"></span>`;
    bar.insertBefore(wrap, document.querySelector('.ab-depth'));
  }
  const input = wrap.querySelector('#svc-filter');
  const countEl = wrap.querySelector('#svc-filter-count');
  countEl.textContent = `${total}개`;
  input.value = '';
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('#columns .node-card[data-filter]').forEach(c => {
      const hit = !q || (c.dataset.filter || '').includes(q);
      c.classList.toggle('hidden', !hit);
      if (hit) shown++;
    });
    // 빈 path 그룹 박스 숨김
    document.querySelectorAll('#columns .path-group').forEach(g => {
      const any = [...g.querySelectorAll('.node-card[data-filter]')].some(c => !c.classList.contains('hidden'));
      g.classList.toggle('hidden', !any);
    });
    countEl.textContent = q ? `${shown}/${total}개` : `${total}개`;
    requestAnimationFrame(drawConnectors);
  };
}

// =========================================================================
// 전체보기 — 서비스 레벨 의존 지도 (서비스 간 s2s·이벤트·인프라)
// =========================================================================
function superId(id) {
  const n = nodeById.get(id);
  if (n && n.project && !isInfra(id, n)) return 'svc:' + n.project;
  return 'infra:' + infraGroup(id);   // 인프라/외부는 타입(kafka/redis/db/external) 단위로 합침
}
const INFRA_LABEL = { kafka: 'Kafka 토픽', redis: 'Redis', db: 'DB 테이블', external: '외부 API', other: '기타' };
const INFRA_ICON = { kafka: '📨', redis: '🔴', db: '🗄️', external: '🌐', other: '⬡' };

function buildServiceGraph() {
  const agg = new Map();   // key → { source, target, kc, count, async }
  for (const e of EDGES) {
    if (e.kind !== 's2s' && e.kind !== 'resource' && e.kind !== 'external' && e.kind !== 'join') continue;
    const ss = superId(e.source), st = superId(e.target);
    if (ss === st) continue;
    const kc = e.kind === 's2s' ? 's2s' : e.kind === 'join' ? 'join' : kindClass(e);
    const key = ss + '|' + st + '|' + kc;
    let a = agg.get(key);
    if (!a) { a = { source: ss, target: st, kc, count: 0, async: false }; agg.set(key, a); }
    a.count++; if (e.mode === 'async') a.async = true;
  }
  return [...agg.values()];
}

// 화면 기준 서비스 티어 분류 (전체보기·어플리케이션구조 picker 공용):
//   0 진입(화면)  ·  1 1차(화면이 join 으로 직접 호출)  ·  2 2차(1차가 s2s 호출)  ·  3 제공 서비스(나머지)
const TIER_HEAD = { 0: '진입 / 화면', 1: '1차 · 직접 호출', 2: '2차 · 서버 호출', 3: '제공 서비스' };
function computeServiceTiers() {
  const svcs = META.projects.slice();
  const frontSet = new Set((MANIFEST?.projects || []).filter(p => p.type === 'frontend').map(p => p.name));
  const isScreen = s => frontSet.has(s);
  const tier1 = new Set();   // 화면(SCREEN)이 join 으로 직접 호출하는 백엔드
  for (const e of EDGES) {
    if (e.kind !== 'join') continue;
    const sn = nodeById.get(e.source), tn = nodeById.get(e.target);
    if (sn && tn && isScreen(sn.project) && tn.project && !isScreen(tn.project)) tier1.add(tn.project);
  }
  const tier2 = new Set();   // 1차가 s2s 로 호출하는 백엔드
  for (const e of EDGES) {
    if (e.kind !== 's2s') continue;
    const sn = nodeById.get(e.source), tn = nodeById.get(e.target);
    if (sn && tn && tier1.has(sn.project) && tn.project && !isScreen(tn.project) && !tier1.has(tn.project)) tier2.add(tn.project);
  }
  const level = new Map(svcs.map(s => [s, isScreen(s) ? 0 : tier1.has(s) ? 1 : tier2.has(s) ? 2 : 3]));
  return { level, isScreen, HEAD: TIER_HEAD, maxLevel: Math.max(0, ...svcs.map(s => level.get(s))) };
}

function renderOverview() {
  document.getElementById('analysis-bar').classList.add('hidden');
  document.getElementById('flow-canvas').querySelector('#grid-toolbar')?.remove();

  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<span class="bc-focus">🗺️ 전체 서비스 지도</span>`
    + `<span class="bc-sep">·</span>`
    + `<span class="ov-hint">서비스 간 <b style="color:var(--e-s2s)">s2s 호출</b> · `
    + `<b style="color:var(--e-kafka)">이벤트/인프라</b> 의존 — 카드 클릭 시 해당 서비스로 이동</span>`;

  const edges = buildServiceGraph();

  const svcs = META.projects.slice();
  const { level, HEAD, maxLevel } = computeServiceTiers();

  // 인프라(공유): 타입(kafka/redis/db/external) 단위로 합친 super-id + 멤버 집합
  const infraTypes = new Set();
  const infraMembers = {};
  for (const e of edges) {
    for (const sup of [e.source, e.target]) if (sup.startsWith('infra:')) infraTypes.add(sup.slice(6));
  }
  for (const e of EDGES) {
    if (e.kind !== 's2s' && e.kind !== 'resource' && e.kind !== 'external' && e.kind !== 'join') continue;
    for (const ep of [e.source, e.target]) {
      if (superId(ep).startsWith('infra:')) {
        const t = infraGroup(ep);
        (infraMembers[t] = infraMembers[t] || new Set()).add(ep);
      }
    }
  }

  // 서비스별 통계
  const stats = {};
  for (const s of svcs) stats[s] = { eps: 0, nodes: 0 };
  for (const n of NODES) {
    if (n.project && stats[n.project]) {
      stats[n.project].nodes++;
      if (n.layer === 'CONTROLLER' && n.endpoint) stats[n.project].eps++;
    }
  }

  const colsEl = document.getElementById('columns');
  colsEl.className = 'overview';
  colsEl.innerHTML = '';

  // 외부 API 는 "제공 서비스"(레벨 3) 컬럼에 함께 배치 — 제공 서비스가 비어 있어도 컬럼 생성
  const externalCol = infraTypes.has('external') ? 3 : -1;
  const lastCol = Math.max(maxLevel, externalCol);
  for (let lv = 0; lv <= lastCol; lv++) {
    const inLevel = svcs.filter(s => level.get(s) === lv).sort((a, b) => stats[b].eps - stats[a].eps);
    const withExternal = lv === externalCol;
    if (!inLevel.length && !withExternal) continue;
    const col = document.createElement('div');
    col.className = 'column';
    const head = document.createElement('div');
    head.className = 'column-head';
    head.textContent = HEAD[lv] || `의존 ${lv}`;
    col.appendChild(head);
    for (const s of inLevel) col.appendChild(makeServiceCard(s, stats[s]));
    if (withExternal) col.appendChild(makeInfraTypeCard('external', (infraMembers['external'] || new Set()).size));
    colsEl.appendChild(col);
  }
  // 공유 인프라 (kafka/redis/db/기타) — 외부는 제공 서비스 단계로 분리됨
  const sharedTypes = ['kafka', 'redis', 'db', 'other'].filter(t => infraTypes.has(t));
  if (sharedTypes.length) {
    const col = document.createElement('div');
    col.className = 'column infra-col';
    const head = document.createElement('div');
    head.className = 'column-head infra';
    head.textContent = '공유 인프라';
    col.appendChild(head);
    for (const t of sharedTypes) col.appendChild(makeInfraTypeCard(t, (infraMembers[t] || new Set()).size));
    colsEl.appendChild(col);
  }

  currentEdges = edges;
  buildCurrentAdj();
  requestAnimationFrame(() => { pruneOrphans(); drawConnectors(); applyHighlight(); });
}

// =========================================================================
// 어플리케이션구조 — 3단계 드릴다운
//   ① 프로젝트 유형별 서비스 picker  →  ② {path1}/{path2} 경로 그룹  →  ③ 경로별 레이어 프로세스 흐름
// =========================================================================
function renderStructure() {
  document.getElementById('analysis-bar').classList.add('hidden');
  document.getElementById('flow-canvas').querySelector('#grid-toolbar')?.remove();
  if (!state.structSvc) renderStructurePicker();
  else if (!state.structPath) renderStructPaths();
  else if (!state.structFile) renderStructFiles();   // ③ 파일 단위 그래프
  else renderStructFlow();                            // ④ 파일이 쓰는 메서드 구조
}

// 서비스별 통계 (endpoints / nodes)
function structStats() {
  const stats = {};
  for (const s of META.projects) stats[s] = { eps: 0, nodes: 0 };
  for (const n of NODES) if (n.project && stats[n.project]) {
    stats[n.project].nodes++;
    if (n.layer === 'CONTROLLER' && n.endpoint) stats[n.project].eps++;
  }
  return stats;
}

// endpoint path → {path1}/{path2} 키 (세그먼트 부족 시 가능한 만큼)
function pathKeyOf(node) {
  const segs = segsOf(node);
  if (segs.length >= 2) return '/' + segs[0] + '/' + segs[1];
  if (segs.length === 1) return '/' + segs[0];
  return '/';
}

// ① 프로젝트 유형(프론트엔드/백엔드)별 서비스 picker
const STRUCT_TYPE = { frontend: '🖥 프론트엔드', backend: '⚙️ 백엔드', other: '기타' };
function renderStructurePicker() {
  currentEdges = []; buildCurrentAdj();
  document.getElementById('connectors').innerHTML = '';

  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<span class="bc-focus">🏗️ 어플리케이션구조</span>`
    + `<span class="bc-sep">·</span>`
    + `<span class="ov-hint">프로젝트 유형별 서비스 — 선택하면 <b>endpoint 경로({path1}/{path2})</b>로 나눠 보여줍니다</span>`;

  const stats = structStats();
  const typeOf = {};
  (MANIFEST?.projects || []).forEach(p => { typeOf[p.name] = p.type; });

  const colsEl = document.getElementById('columns');
  colsEl.className = 'structure-picker';
  colsEl.innerHTML = '';
  for (const t of ['frontend', 'backend', 'other']) {
    const inType = META.projects.filter(s => (typeOf[s] || 'other') === t)
      .sort((a, b) => stats[b].eps - stats[a].eps || stats[b].nodes - stats[a].nodes);
    if (!inType.length) continue;
    const col = document.createElement('div');
    col.className = 'column';
    const head = document.createElement('div');
    head.className = 'column-head';
    head.textContent = STRUCT_TYPE[t];
    col.appendChild(head);
    for (const svc of inType)
      col.appendChild(makeServiceCard(svc, stats[svc], () => setStructSvc(svc)));
    colsEl.appendChild(col);
  }
}

// ② 선택 서비스의 endpoint 를 {path1}/{path2} 그룹 카드로
function renderStructPaths() {
  const svc = state.structSvc;
  currentEdges = []; buildCurrentAdj();
  document.getElementById('connectors').innerHTML = '';

  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-struct">🏗️ 어플리케이션구조</a>`
    + `<span class="bc-sep">›</span>`
    + `<span class="bc-focus">${esc(svc)}</span>`
    + `<span class="bc-sep">·</span>`
    + `<span class="ov-hint">경로를 선택하면 그 경로에 관련된 <b>파일 단위</b> 노드·관계를 보여줍니다</span>`;
  bc.querySelector('#bc-struct').addEventListener('click', () => setStructure(true));

  const groups = new Map();   // key → [endpoint node]
  for (const ep of serviceEndpoints(svc)) {
    const key = pathKeyOf(ep);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ep);
  }

  const colsEl = document.getElementById('columns');
  colsEl.className = 'struct-paths';
  colsEl.innerHTML = '';
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const list = groups.get(key);
    const card = document.createElement('div');
    card.className = 'node-card struct-path-card';
    card.innerHTML = `<div class="ov-svc-name"><span class="nc-icon">📁</span> ${esc(key)}</div>`
      + `<div class="ov-svc-sub">${list.length} endpoints</div>`;
    card.addEventListener('click', () => setStructPath(svc, key));
    colsEl.appendChild(card);
  }
  if (!keys.length)
    colsEl.innerHTML = `<div class="browse-empty">이 서비스에는 endpoint 가 없습니다.</div>`;
}

const STRUCT_LAYER_HEAD = {
  CONTROLLER: 'CONTROLLER', SERVICE: 'SERVICE', COMPONENT: 'COMPONENT',
  REPOSITORY: 'REPOSITORY', CONFIG: 'CONFIG', BATCH: 'BATCH', EXTERNAL: 'EXTERNAL', RESOURCE: 'INFRA',
};

// 시작 노드들에서 같은 프로젝트 내부 호출을 따라가며 닿는 노드 수집(인프라/외부는 포함하되 더 진행 안 함)
function collectDownstream(rootIds, svc) {
  const set = new Set(rootIds);
  let frontier = [...set];
  while (frontier.length) {
    const next = [];
    for (const id of frontier)
      for (const e of outEdges.get(id) || []) {
        if (set.has(e.target)) continue;
        const t = nodeById.get(e.target);
        if (!t) continue;
        const infra = isInfra(e.target, t);
        if (t.project === svc || infra) {
          set.add(e.target);
          if (t.project === svc && !infra) next.push(e.target);
        }
      }
    frontier = next;
  }
  return set;
}

// 노드 → 파일 단위 키 (인프라는 타입 단위로, 파일 없으면 노드 단위 폴백)
function fileKeyOf(id) {
  const n = nodeById.get(id);
  if (!n) return id;
  if (isInfra(id, n)) return 'infra:' + infraGroup(id);
  return n.file ? 'file:' + n.file : 'node:' + id;
}

// ③ {path1}/{path2} 경로에 관련된 노드를 "파일 단위" 그래프로 (레이어 컬럼 배치 + 파일 간 관계)
function renderStructFiles() {
  const svc = state.structSvc, key = state.structPath;
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-struct">🏗️ 어플리케이션구조</a>`
    + `<span class="bc-sep">›</span>`
    + `<a class="bc-link" id="bc-svc">${esc(svc)}</a>`
    + `<span class="bc-sep">›</span>`
    + `<span class="bc-focus">📁 ${esc(key)}</span>`
    + `<span class="bc-sep">·</span>`
    + `<span class="ov-hint">파일 단위 노드 — 파일을 누르면 그 파일이 쓰는 <b>Controller·Service·Repository·Infra</b> 구조를 보여줍니다</span>`;
  bc.querySelector('#bc-struct').addEventListener('click', () => setStructure(true));
  bc.querySelector('#bc-svc').addEventListener('click', () => setStructSvc(svc));

  const roots = serviceEndpoints(svc).filter(ep => pathKeyOf(ep) === key).map(r => r.id);
  const nodeSet = collectDownstream(roots, svc);

  // 파일 단위 그룹: key → { layer(대표), members:[id], isInfra, label, dir }
  const files = new Map();
  for (const id of nodeSet) {
    const n = nodeById.get(id); if (!n) continue;
    const fk = fileKeyOf(id);
    let g = files.get(fk);
    if (!g) {
      const infra = isInfra(id, n);
      g = { layer: infra ? (n.layer === 'EXTERNAL' ? 'EXTERNAL' : 'RESOURCE') : n.layer, members: [], isInfra: infra,
            label: infra ? INFRA_LABEL[infraGroup(id)] : (n.file ? n.file.split('/').pop() : (n.method || id)),
            dir: (!infra && n.file) ? n.file.split('/').slice(-3, -1).join('/') : '' };
      files.set(fk, g);
    }
    g.members.push(id);
    if (!g.isInfra && LAYER_FLOW.indexOf(n.layer) >= 0 && LAYER_FLOW.indexOf(n.layer) < LAYER_FLOW.indexOf(g.layer)) g.layer = n.layer;
  }

  const colsEl = document.getElementById('columns');
  colsEl.className = 'struct-flow';
  colsEl.innerHTML = '';
  for (const layer of LAYER_FLOW) {
    const fks = [...files.keys()].filter(fk => files.get(fk).layer === layer)
      .sort((a, b) => files.get(a).label.localeCompare(files.get(b).label));
    if (!fks.length) continue;
    const col = document.createElement('div');
    col.className = 'column';
    col.appendChild(mkHead(`${STRUCT_LAYER_HEAD[layer] || layer} · ${fks.length}`));
    for (const fk of fks) col.appendChild(makeFileCard(fk, files.get(fk), () => setStructFile(svc, key, fk)));
    colsEl.appendChild(col);
  }
  if (!files.size)
    colsEl.innerHTML = `<div class="browse-empty">이 경로에 연결된 노드가 없습니다.</div>`;

  // 파일 간 관계로 엣지 집계
  const agg = new Map();
  for (const e of EDGES) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    const s = fileKeyOf(e.source), t = fileKeyOf(e.target);
    if (s === t || !files.has(s) || !files.has(t)) continue;
    const kc = kindClass(e), k = s + '|' + t + '|' + kc;
    let a = agg.get(k);
    if (!a) { a = { source: s, target: t, kc, count: 0, mode: e.mode }; agg.set(k, a); }
    a.count++;
  }
  currentEdges = [...agg.values()];
  buildCurrentAdj();
  requestAnimationFrame(() => { drawConnectors(); applyHighlight(); });
}

// 파일 단위 노드 카드 (레이어색 보더 + 풀네임 뱃지 + 파일명 + 디렉터리·멤버수)
const INFRA_CLS = { kafka: 'nc-r-kafka-topic', redis: 'nc-r-redis', db: 'nc-r-db-table', external: 'nc-l-external', other: 'nc-l-other' };
function makeFileCard(fk, g, onClick) {
  const card = document.createElement('div');
  const layerCls = g.isInfra ? (INFRA_CLS[infraGroup(g.members[0])] || 'nc-l-other')
                             : ('nc-l-' + (LAYER_CLASS[g.layer] || 'other'));
  card.className = 'node-card struct-file-card ' + layerCls + (fk === state.sel ? ' sel' : '');
  card.dataset.node = fk;
  const badge = `<span class="nc-badge">${esc(STRUCT_LAYER_HEAD[g.layer] || g.layer)}</span>`;
  card.innerHTML = `<div class="nc-top">${badge}<span class="sf-count">${g.members.length}</span></div>`
    + `<div class="nc-method">${g.isInfra ? '🗄 ' : '📄 '}${esc(g.label)}</div>`
    + (g.dir ? `<div class="nc-class">${esc(g.dir)}</div>` : '');
  card.addEventListener('click', onClick);
  card.addEventListener('mouseenter', () => alignNeighbors(fk));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set(fk, card);
  return card;
}

// ④ 선택 파일이 쓰는 메서드 구조 — Controller·Service·Repository·Infra 레이어 컬럼
function renderStructFlow() {
  const svc = state.structSvc, key = state.structPath, fk = state.structFile;
  const file = fk && fk.startsWith('file:') ? fk.slice(5) : null;
  const fileLabel = file ? file.split('/').pop() : (fk || '');
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-struct">🏗️ 어플리케이션구조</a>`
    + `<span class="bc-sep">›</span>`
    + `<a class="bc-link" id="bc-svc">${esc(svc)}</a>`
    + `<span class="bc-sep">›</span>`
    + `<a class="bc-link" id="bc-path">📁 ${esc(key)}</a>`
    + `<span class="bc-sep">›</span>`
    + `<span class="bc-focus">📄 ${esc(fileLabel)}</span>`
    + `<span class="bc-sep">·</span>`
    + `<span class="ov-hint">노드의 📌 를 누르면 강조 상태가 고정됩니다 — 여러 노드를 핀으로 누적할 수 있어요</span>`;
  bc.querySelector('#bc-struct').addEventListener('click', () => setStructure(true));
  bc.querySelector('#bc-svc').addEventListener('click', () => setStructSvc(svc));
  bc.querySelector('#bc-path').addEventListener('click', () => setStructPath(svc, key));

  // 시작점: 그 파일에 정의된 메서드들 → 같은 프로젝트 내부 호출 + 인프라까지
  const roots = file
    ? NODES.filter(n => n.file === file && n.project === svc).map(n => n.id)
    : (fk && fk.startsWith('infra:') ? [fk.slice(6)] : []);
  const nodeSet = collectDownstream(roots, svc);

  const colsEl = document.getElementById('columns');
  colsEl.className = 'struct-flow';
  colsEl.innerHTML = '';
  for (const layer of LAYER_FLOW) {
    const ids = [...nodeSet].filter(id => (nodeById.get(id) || {}).layer === layer);
    if (!ids.length) continue;
    ids.sort((a, b) => byNodeName(nodeById.get(a), nodeById.get(b)));
    const col = document.createElement('div');
    col.className = 'column';
    col.appendChild(mkHead(`${STRUCT_LAYER_HEAD[layer] || layer} · ${ids.length}`));
    // 노드 클릭 → 메서드 상세를 오른쪽 패널에 표시. 📌 핀으로 강조 상태를 고정(누적)할 수 있다.
    for (const id of ids) col.appendChild(makeCard(id, { noCenter: true, pin: true }));
    colsEl.appendChild(col);
  }
  if (!nodeSet.size)
    colsEl.innerHTML = `<div class="browse-empty">이 파일에서 사용되는 노드가 없습니다.</div>`;

  currentEdges = EDGES.filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
  buildCurrentAdj();
  requestAnimationFrame(() => { drawConnectors(); applyHighlight(); });
}

// 서비스명 → 고정 색상(hue). impact.js projectHue 와 동일한 FNV-1a 로 뷰 간 색을 일치시킨다.
function serviceHue(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}

function makeServiceCard(svc, st, onClick) {
  const card = document.createElement('div');
  card.className = 'node-card ov-svc' + (('svc:' + svc) === state.sel ? ' sel' : '');
  card.dataset.node = 'svc:' + svc;
  const hue = serviceHue(svc);
  card.style.borderLeftColor = `hsl(${hue} 60% 50%)`;
  card.innerHTML = `<div class="ov-svc-name"><span class="ov-svc-dot" style="background:hsl(${hue} 60% 50%)"></span>${esc(svc)}</div>`
    + `<div class="ov-svc-sub">${st.eps} endpoints · ${st.nodes} nodes</div>`;
  card.addEventListener('click', onClick || (() => setService(svc)));
  card.addEventListener('mouseenter', () => alignNeighbors('svc:' + svc));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set('svc:' + svc, card);
  return card;
}

// 서비스 보기 단계 컬럼: 외부/인프라 버킷을 전체보기처럼 단일 카드로 축약 (id = 버킷 key, 엣지 타깃과 일치)
function makeStepBucketCard(bkt) {
  const type = bkt.key.startsWith('ext:') ? 'external' : (bkt.key.split(':')[1] || 'other');
  const clsMap = { external: 'nc-l-external', kafka: 'nc-r-kafka-topic', redis: 'nc-r-redis', db: 'nc-r-db-table', other: 'nc-l-other' };
  const card = document.createElement('div');
  card.className = `node-card ov-infra ${clsMap[type] || 'nc-l-other'}` + (bkt.key === state.sel ? ' sel' : '');
  card.dataset.node = bkt.key;
  const n = bkt.members.size;
  card.innerHTML = `<div class="ov-svc-name">${esc(bkt.label)}</div>`
    + `<div class="ov-svc-sub">${n} ${type === 'external' ? 'endpoints' : 'nodes'}</div>`;
  card.addEventListener('mouseenter', () => alignNeighbors(bkt.key));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set(bkt.key, card);
  return card;
}

function infraGroup(id) {
  const n = nodeById.get(id);
  if (n) {
    if (n.layer === 'EXTERNAL') return 'external';
    if (n.resourceType === 'kafka-topic') return 'kafka';
    if (n.resourceType === 'db-table') return 'db';
    if (n.resourceType === 'redis') return 'redis';
  }
  if (/^kafka:/.test(id)) return 'kafka';
  if (/^db:/.test(id)) return 'db';
  if (/redis/.test(id)) return 'redis';
  if (/^ext:/.test(id)) return 'external';
  return 'other';
}

// 전체보기: 인프라/외부 타입을 하나의 노드로 표현
function makeInfraTypeCard(type, count) {
  const sup = 'infra:' + type;
  const clsMap = { kafka: 'nc-r-kafka-topic', redis: 'nc-r-redis', db: 'nc-r-db-table', external: 'nc-l-external', other: 'nc-l-other' };
  const card = document.createElement('div');
  card.className = `node-card ov-infra ${clsMap[type] || 'nc-l-other'}` + (sup === state.sel ? ' sel' : '');
  card.dataset.node = sup;
  card.innerHTML = `<div class="ov-svc-name"><span class="nc-icon">${INFRA_ICON[type]}</span> ${esc(INFRA_LABEL[type])}</div>`
    + `<div class="ov-svc-sub">${count} ${type === 'external' ? 'endpoints' : 'nodes'}</div>`;
  card.addEventListener('click', () => setInfraType(type));
  card.addEventListener('mouseenter', () => alignNeighbors(sup));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set(sup, card);
  return card;
}

// 전체보기 › 노드명 (전체보기 인프라/외부 노드에서 드릴다운한 경우)
function renderFocusFromOverviewCrumb(n) {
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-ov">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span>`
    + `<span class="bc-focus">🎯 ${esc(n.method || n.externalUrl || state.focus)} 호출관계분석</span>`;
  bc.querySelector('#bc-ov').addEventListener('click', () => setOverview(true));
}

// 전체보기 › 서비스 › 노드명 (서비스 보기에서 드릴다운한 경우)
function renderFocusFromServiceCrumb(n) {
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-ov">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span>`
    + `<a class="bc-link" id="bc-svc">${esc(state.fromService)}</a>`
    + `<span class="bc-sep">›</span>`
    + `<span class="bc-focus">🎯 ${esc(n.method || state.focus)} 호출관계분석</span>`;
  bc.querySelector('#bc-ov').addEventListener('click', () => setOverview(true));
  bc.querySelector('#bc-svc').addEventListener('click', () => setService(state.fromService));
}

// =========================================================================
// 호출관계분석 — 기준 노드 중심 열 배치
// =========================================================================
function computeColumns(bases, skipDown) {
  bases = (bases || [state.focus]).filter(id => nodeById.has(id));
  const assigned = new Map();
  const columns = new Map();
  const place = (id, level) => {
    if (assigned.has(id)) return;
    assigned.set(id, level);
    if (!columns.has(level)) columns.set(level, []);
    columns.get(level).push(id);
  };
  bases.forEach(id => place(id, 0));

  // 호출(callee) — 단일 분석 확장 모드에서는 인라인 프로세스 flow가 대신하므로 열 생략
  if (!skipDown) {
    let frontier = bases.slice();
    for (let d = 0; d < state.down; d++) {
      const next = [];
      for (const id of frontier)
        for (const e of (outEdges.get(id) || []).slice().sort(byCallSite)) {
          if (assigned.has(e.target) || !passFilter(e.target)) continue;
          place(e.target, d + 1); next.push(e.target);
        }
      frontier = next; if (!next.length) break;
    }
  }
  // 피호출(caller)
  let frontier = bases.slice();
  for (let d = 0; d < state.up; d++) {
    const next = [];
    for (const id of frontier)
      for (const e of (inEdges.get(id) || []).slice().sort(byCallSite)) {
        if (assigned.has(e.source) || !passFilter(e.source)) continue;
        place(e.source, -(d + 1)); next.push(e.source);
      }
    frontier = next; if (!next.length) break;
  }
  return { assigned, columns };
}

function renderAnalysis() {
  const n = nodeById.get(state.focus);
  const bar = document.getElementById('analysis-bar');
  bar.classList.remove('hidden');
  document.getElementById('back-to-browse').textContent =
    state.fromService ? '⟵ ' + state.fromService : '⟵ 전체보기';
  document.getElementById('ab-focus').innerHTML =
    `<span class="ab-focus-label">기준</span> <b>${esc(n.method || state.focus)}</b>`
    + (n.project ? `<span class="ab-proj">${esc(n.project)}</span>` : '');
  document.getElementById('up-val').textContent = state.up;
  document.getElementById('down-val').textContent = state.down;

  if (state.fromService) renderFocusFromServiceCrumb(n);
  else renderFocusFromOverviewCrumb(n);   // 전체보기·검색 진입 공통 — 전체보기 루트

  const { assigned, columns } = computeColumns([state.focus], state.expanded);
  const levels = [...columns.keys()].sort((a, b) => a - b);
  const colsEl = document.getElementById('columns');
  colsEl.className = '';
  colsEl.innerHTML = '';
  for (const lv of levels) {
    const col = document.createElement('div');
    col.className = 'column' + (lv === 0 ? ' base' : '');
    if (lv === 0) col.appendChild(orphanToggleEl());
    const head = document.createElement('div');
    head.className = 'column-head';
    head.textContent = lv === 0 ? '기준 API' : lv < 0 ? `피호출 ${-lv}` : `호출 ${lv}`;
    col.appendChild(head);
    for (const id of columns.get(lv)) col.appendChild(makeCard(id, { isFocus: lv === 0 }));
    if (lv === 0 && state.expanded) col.appendChild(makeProcessFlow(state.focus));
    colsEl.appendChild(col);
  }
  currentEdges = EDGES.filter(e => assigned.has(e.source) && assigned.has(e.target));
  buildCurrentAdj();
  requestAnimationFrame(() => { pruneOrphans(); drawConnectors(); applyHighlight(); });
}

// =========================================================================
// 프로세스 flow — 기준 노드 내부 실행 흐름(인라인 트리)
// =========================================================================
function makeProcessFlow(rootId) {
  const wrap = document.createElement('div');
  wrap.className = 'flow-tree';
  wrap.innerHTML = `<div class="flow-tree-head">프로세스 상세 — 내부 호출 흐름</div>`;

  const seen = new Set([rootId]);
  let count = 0; const MAX = 120;
  const rows = [];
  (function walk(id, depth) {
    if (count >= MAX || depth > 7) return;
    for (const e of (outEdges.get(id) || []).slice().sort(byCallSite)) {
      if (count >= MAX) break;
      const t = e.target, tn = nodeById.get(t);
      if (!tn) continue;
      if (state.hideOther && tn.layer === 'OTHER') continue;
      const recurse = e.kind === 'internal' && !seen.has(t);
      count++;
      rows.push(flowRowHtml(t, e, depth));
      if (recurse) { seen.add(t); walk(t, depth + 1); }
    }
  })(rootId, 0);

  if (!rows.length) {
    wrap.innerHTML += `<div class="hint" style="padding:6px 2px">내부 호출이 감지되지 않았습니다.</div>`;
  } else {
    wrap.innerHTML += rows.join('');
    if (count >= MAX) wrap.innerHTML += `<div class="hint" style="padding:6px 2px">… 일부만 표시 (상한 ${MAX})</div>`;
  }
  wrap.querySelectorAll('.flow-row').forEach(r => {
    r.addEventListener('click', () => {
      const id = r.dataset.node;
      if (nodeById.has(id)) setSel(id);
    });
  });
  return wrap;
}

function flowRowHtml(id, e, depth) {
  const n = nodeById.get(id);
  const color = layerColor(n);
  const kc = kindClass(e);
  const relLabel = e.kind === 's2s' ? 'S2S'
    : e.kind === 'external' ? 'EXT'
    : e.kind === 'resource' ? (e.relation || 'io')
    : e.kind === 'batch' ? (e.relation || 'batch') : '';
  const asyncTag = e.mode === 'async' ? '<span class="flow-async">async</span>' : '';
  const line = e.callSiteLine != null ? `<span class="flow-line">L${e.callSiteLine}</span>` : '';
  let label;
  if (n.layer === 'CONTROLLER' && n.endpoint) label = `${n.httpMethod || ''} ${n.endpoint}`.trim();
  else if (n.layer === 'RESOURCE') label = (RES_ICON[n.resourceType] || '⬡') + ' ' + (n.method || id);
  else if (n.layer === 'EXTERNAL') label = n.externalUrl || n.method || id;
  else label = n.method || id;
  const cls = shortClass(n.fqcn || '');
  return `<div class="flow-row" data-node="${escAttr(id)}" style="margin-left:${Math.min(depth, 7) * 18}px">`
    + `<span class="flow-dot" style="background:${color}"></span>`
    + `<span class="flow-method">${esc(label)}</span>`
    + (cls && n.layer !== 'RESOURCE' && n.layer !== 'EXTERNAL' ? `<span class="flow-class">${esc(cls)}</span>` : '')
    + (relLabel ? `<span class="flow-rel k-${kc}">${esc(relLabel)}</span>` : '')
    + asyncTag + line
    + `</div>`;
}

// =========================================================================
// 카드 (실제 그래프 노드)
// =========================================================================
function methodClass(m) { return 'm-' + String(m || 'any').toLowerCase(); }

function makeCard(id, opts) {
  opts = opts || {};
  const n = nodeById.get(id);
  const isFocus = !!opts.isFocus;
  const layerCls = n.layer === 'RESOURCE'
    ? 'nc-r-' + (n.resourceType || 'redis')
    : 'nc-l-' + (LAYER_CLASS[n.layer] || 'other');
  const isRoute = opts.route && n.layer === 'CONTROLLER' && n.endpoint;
  const card = document.createElement('div');
  card.className = `node-card ${layerCls}` + (isFocus ? ' base' : '') + (id === state.sel ? ' sel' : '')
    + (isRoute ? ' is-route nc-m-' + String(n.httpMethod || 'any').toLowerCase() : '');
  card.dataset.node = id;

  let badge;
  if (n.layer === 'CONTROLLER' && n.httpMethod) badge = `<span class="nc-badge http ${methodClass(n.httpMethod)}">${esc(n.httpMethod)}</span>`;
  else if (n.layer === 'RESOURCE') badge = `<span class="nc-icon">${RES_ICON[n.resourceType] || '⬡'}</span>`;
  else if (n.layer === 'EXTERNAL') badge = `<span class="nc-badge">EXTERNAL</span>`;
  else if (n.layer === 'SCREEN') badge = `<span class="nc-badge screen">🖥 화면</span>`;
  else badge = `<span class="nc-badge">${esc(n.layer || 'OTHER')}</span>`;   // 레이어 풀네임
  const asyncTag = n.async ? '<span class="nc-async">async</span>' : '';

  let body;
  if (isRoute) {
    const segs = segsOf(n);
    const remaining = '/' + segs.join('/');
    body = `<div class="nc-route">${esc(remaining)}</div>`
      + `<div class="nc-submethod">${esc(n.method || n.id)}${n.fqcn && n.fqcn !== n.id ? ' · ' + esc(shortClass(n.fqcn)) : ''}</div>`;
    if (n.description) body += `<div class="nc-desc">${esc(n.description)}</div>`;
  } else {
    // SCREEN 은 파일경로 id 대신 screens.json 의 화면 이름을, 없으면 method/id 폴백
    const primary = n.layer === 'SCREEN' ? (n.screenName || n.method || n.id) : (n.method || n.id);
    body = `<div class="nc-method">${esc(primary)}</div>`;
    if (n.layer !== 'RESOURCE' && n.fqcn && n.fqcn !== n.id) body += `<div class="nc-class">${esc(shortClass(n.fqcn))}</div>`;
    if (n.endpoint) body += `<div class="nc-endpoint">${esc(n.endpoint)}</div>`;
    if (n.externalUrl) body += `<div class="nc-endpoint">${esc(n.externalUrl)}</div>`;
    if (n.description) body += `<div class="nc-desc">${esc(n.description)}</div>`;
  }
  const proj = (n.project && (state.focus || opts.showProject) && !opts.inBrowser) ? `<span class="nc-proj">${esc(n.project)}</span>` : '';

  // 액션 버튼 (기준 노드 프로세스 펼치기 / 핀 — '중심 ⟲' 재중심 버튼은 제거, 카드 클릭으로 동작)
  let act = '';
  if (!opts.inBrowser && isFocus) {
    act = `<button class="nc-act expand">${state.expanded ? '프로세스 접기 ▲' : '프로세스 상세보기 ▼'}</button>`;
  } else if (opts.pin) {
    act = `<button class="nc-act pin" title="핀 — 강조(연결 노드/엣지)를 고정. 여러 노드 핀 가능">📌</button>`;
  }
  card.innerHTML = `${act}<div class="nc-top">${badge}${asyncTag}</div>${body}${proj}`;
  if (opts.pin && pinned.has(id)) card.classList.add('pinned');
  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('expand')) { toggleExpand(); return; }
    if (e.target.classList.contains('pin')) { e.stopPropagation(); togglePin(id); return; }
    if (opts.onPick) { opts.onPick(id); return; }           // 서비스 보기: 노드 클릭 → 활성화된 연결 노드만 단계 필터
    if (opts.onActivate) { opts.onActivate(id); return; }   // 그룹(서비스/인프라) 보기: 노드 클릭 → 드릴다운
    if (opts.inBrowser) { setFocus(id, null); return; }     // 브라우저 엔드포인트 → 호출관계분석
    setSel(id);
  });
  card.addEventListener('mouseenter', () => alignNeighbors(id));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set(id, card);
  return card;
}

// =========================================================================
// SVG 커넥터
// =========================================================================
function buildCurrentAdj() {
  currentAdjOut.clear(); currentAdjIn.clear();
  for (const e of currentEdges) {
    if (!currentAdjOut.has(e.source)) currentAdjOut.set(e.source, []);
    if (!currentAdjIn.has(e.target)) currentAdjIn.set(e.target, []);
    currentAdjOut.get(e.source).push(e.target);
    currentAdjIn.get(e.target).push(e.source);
  }
}
function drawConnectors() {
  const svg = document.getElementById('connectors');
  const layer = document.getElementById('zoom-layer');
  const z = state.zoom || 1;
  const crect = layer.getBoundingClientRect();
  // crect 은 줌이 적용된 화면 좌표 → 로컬(미줌) 좌표로 환산(/z)
  svg.setAttribute('width', layer.scrollWidth);
  svg.setAttribute('height', layer.scrollHeight);
  const usedKinds = new Set();
  const anchors = anchorSet();   // 핀 ∪ hover — 연결된 엣지는 hot, 나머지는 dim
  let paths = '', labels = '';
  for (const e of currentEdges) {
    const sc = cardEls.get(e.source), tc = cardEls.get(e.target);
    if (!sc || !tc) continue;
    if (!sc.offsetParent || !tc.offsetParent) continue;   // 숨겨진(필터/고아/그룹접힘) 노드 제외
    const sr = sc.getBoundingClientRect(), tr = tc.getBoundingClientRect();
    const y1 = (sr.top + sr.height / 2 - crect.top) / z, y2 = (tr.top + tr.height / 2 - crect.top) / z;
    let x1, x2, c1x, c2x, mx;
    if (tr.left >= sr.right - 1) {            // 타깃이 오른쪽 컬럼 — 정방향 가로 흐름
      x1 = (sr.right - crect.left) / z; x2 = (tr.left - crect.left) / z;
      const dx = Math.max(28, (x2 - x1) * 0.45);
      c1x = x1 + dx; c2x = x2 - dx; mx = (x1 + x2) / 2;
    } else if (tr.right <= sr.left + 1) {     // 타깃이 왼쪽 컬럼 — 역방향 가로 흐름
      x1 = (sr.left - crect.left) / z; x2 = (tr.right - crect.left) / z;
      const dx = Math.max(28, (x1 - x2) * 0.45);
      c1x = x1 - dx; c2x = x2 + dx; mx = (x1 + x2) / 2;
    } else {                                   // 같은 컬럼(세로 호출) — 카드 오른쪽으로 부풀린 호로 분리해 가독성 확보
      x1 = (sr.right - crect.left) / z; x2 = (tr.right - crect.left) / z;
      const bulge = Math.max(46, Math.min(150, Math.abs(y2 - y1) * 0.55));
      c1x = x1 + bulge; c2x = x2 + bulge; mx = Math.max(x1, x2) + bulge * 0.6;
    }
    const kc = e.kc || kindClass(e); usedKinds.add(kc);
    const asyncCls = (e.async || e.mode === 'async') ? ' async' : '';
    const stateCls = anchors.size ? (anchors.has(e.source) || anchors.has(e.target) ? ' hot' : ' dim') : '';
    const wStyle = e.count ? ` style="stroke-width:${Math.min(7, 1.8 + e.count * 0.7).toFixed(1)}"` : '';
    paths += `<path class="edge-path k-${kc}${asyncCls}${stateCls}" data-s="${escAttr(e.source)}" data-t="${escAttr(e.target)}"${wStyle} `
      + `d="M${x1.toFixed(1)},${y1.toFixed(1)} C${c1x.toFixed(1)},${y1.toFixed(1)} ${c2x.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" `
      + `marker-end="url(#arr-${kc})"/>`;
    if (e.count && e.count > 1) {
      const my = (y1 + y2) / 2 - 6;
      labels += `<text class="edge-label" x="${mx.toFixed(1)}" y="${my.toFixed(1)}" fill="${KIND_COLOR[kc] || '#94a3b8'}">×${e.count}</text>`;
    }
  }
  let defs = '<defs>';
  // markerUnits=userSpaceOnUse → 화살촉 크기를 stroke-width 와 무관하게 고정 (굵은 집계 엣지에서 화살표가 거대해지는 문제 방지)
  for (const kc of usedKinds)
    defs += `<marker id="arr-${kc}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${KIND_COLOR[kc] || '#94a3b8'}"/></marker>`;
  svg.innerHTML = defs + '</defs>' + paths + labels;
}
// 강조 기준 집합(anchorSet = 핀 ∪ hover)의 이웃을 살리고 나머지는 dim. (핀이 여럿이면 모든 핀의 이웃을 합집합으로 강조)
function highlightActive() {
  if (!cardEls.size || !currentEdges.length) return;
  const anchors = anchorSet();
  if (!anchors.size) {   // 기준 없음 → 전부 복원
    document.querySelectorAll('#columns .path-group.dim').forEach(b => b.classList.remove('dim'));
    for (const [, el] of cardEls) el.classList.remove('dim');
    return;
  }
  const live = new Set();
  for (const a of anchors) {
    live.add(a);
    (currentAdjOut.get(a) || []).forEach(t => live.add(t));
    (currentAdjIn.get(a) || []).forEach(s => live.add(s));
  }
  // 박스 단위: 관련 노드가 든 박스는 살리고 나머지 박스는 투명
  const liveBoxes = new Set();
  for (const nid of live) { const el = cardEls.get(nid); const box = el && el.closest('.path-group'); if (box) liveBoxes.add(box); }
  document.querySelectorAll('#columns .path-group').forEach(box => box.classList.toggle('dim', !liveBoxes.has(box)));
  // 박스에 안 든 카드(예: 호출관계분석 focus 뷰)는 카드 단위로 처리
  for (const [nid, el] of cardEls) {
    if (el.closest('.path-group')) el.classList.remove('dim');
    else el.classList.toggle('dim', !live.has(nid));
  }
  // 엣지 강조는 drawConnectors 가 anchorSet 기준으로 처리
}
function applyHighlight() {
  for (const [nid, el] of cardEls) { el.classList.remove('dim'); el.classList.toggle('sel', nid === state.sel); }
  document.querySelectorAll('#columns .path-group.dim').forEach(b => b.classList.remove('dim'));
  document.querySelectorAll('.edge-path').forEach(p => { p.classList.remove('dim'); p.classList.remove('hot'); });
  if (pinned.size) { highlightActive(); drawConnectors(); }   // 핀 강조는 sel 변경(상세 패널 클릭) 후에도 유지
}

// 호출/피호출 관계가 없는 고아노드 숨김 (currentEdges 기준)
function pruneOrphans() {
  if (!state.hideOrphans) return;
  const connected = new Set();
  for (const e of currentEdges) { connected.add(e.source); connected.add(e.target); }
  if (state.focus) connected.add(state.focus);
  for (const [id, el] of cardEls) el.classList.toggle('orphan-hidden', !connected.has(id));
  // 비어버린 그룹 박스 숨김
  document.querySelectorAll('#columns .path-group').forEach(g => {
    g.classList.toggle('orphan-hidden', !g.querySelector('.node-card:not(.orphan-hidden):not(.hidden)'));
  });
}

// 서비스 보기: 선택 노드(svcPick) 기준 — 연결된(활성화된) 노드만 단계 표시
function applyPickFilter() {
  if (!state.service) return;
  document.querySelectorAll('#columns .pick-hidden').forEach(el => el.classList.remove('pick-hidden'));
  for (const [, el] of cardEls) el.classList.remove('picked');
  const pick = state.svcPick;
  if (!pick || !cardEls.has(pick)) return;
  // 선택 노드에서 호출(out)·피호출(in) 방향으로 닿는 체인 전체가 활성 집합
  const active = new Set([pick]);
  for (const adj of [currentAdjOut, currentAdjIn]) {
    let frontier = [pick];
    while (frontier.length) {
      const next = [];
      for (const id of frontier)
        for (const o of adj.get(id) || [])
          if (!active.has(o)) { active.add(o); next.push(o); }
      frontier = next;
    }
  }
  for (const [id, el] of cardEls) el.classList.toggle('pick-hidden', !active.has(id));
  cardEls.get(pick).classList.add('picked');
  // 비어버린 그룹 박스 / 단계 컬럼 숨김
  document.querySelectorAll('#columns .path-group').forEach(g => {
    g.classList.toggle('pick-hidden', !g.querySelector('.node-card:not(.pick-hidden):not(.orphan-hidden):not(.hidden)'));
  });
  document.querySelectorAll('#columns .column').forEach(c => {
    c.classList.toggle('pick-hidden', !c.querySelector('.node-card:not(.pick-hidden):not(.orphan-hidden):not(.hidden)'));
  });
}

// hover 시 연결된 노드를 hover 노드와 같은 행(Y)으로 부드럽게 이동
let alignRAF = null, alignFrames = 0;
let hoverId = null;            // 현재 hover한 노드 (커넥터 강조용)
const pinned = new Set();      // 핀 고정된 노드 — hover 가 끝나도 강조 상태를 유지(누적 가능)
// 현재 강조 기준 노드 집합 = 핀 ∪ (hover 중이면 그 노드). 박스·카드·엣지 강조가 모두 이 집합을 기준으로 한다.
function anchorSet() { const s = new Set(pinned); if (hoverId) s.add(hoverId); return s; }
// 핀 토글 — 강조 상태를 고정/해제한다 (structFlow 단계 카드의 📌 버튼)
function togglePin(id) {
  if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
  const el = cardEls.get(id);
  if (el) el.classList.toggle('pinned', pinned.has(id));
  if (hoverId || pinned.size) highlightActive(); else applyHighlight();
  animateConnectors();
}
function animateConnectors() {
  alignFrames = 18;
  if (alignRAF) return;
  const tick = () => { drawConnectors(); if (--alignFrames > 0) alignRAF = requestAnimationFrame(tick); else alignRAF = null; };
  alignRAF = requestAnimationFrame(tick);
}
// 현재 적용된(애니메이션 중 포함) translateY 값(로컬 px)
function currentTy(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  try { return new DOMMatrixReadOnly(t).m42; } catch (e) { return 0; }
}
function resetMovers() {
  document.querySelectorAll('#columns .path-group[style*="transform"]').forEach(b => { b.style.transform = ''; b.classList.remove('aligning-box'); });
  for (const [, el] of cardEls) if (el.style.transform) { el.style.transform = ''; el.classList.remove('aligning', 'card-lift'); }
}
// hover 시 연결된 이웃 "카드"를 hover 행으로 띄워 옆에 정렬한다.
//   그룹 박스(.path-group)는 서비스 단위로 수백 개 카드를 담아 매우 클 수 있어,
//   박스 통째로 옮기면 위치가 붕괴한다. 그래서 박스가 아니라 카드 한 장만 떠올린다(card-lift).
function alignNeighbors(id) {
  hoverId = id;
  highlightActive();
  const hc = cardEls.get(id);
  if (!hc || !currentEdges.length) { animateConnectors(); return; }
  const z = state.zoom || 1;
  // 카드의 "기준(base) 중심 Y" — 자신의 transform 만 역산 (박스는 이동하지 않음)
  const baseCenterOf = card => {
    const r = card.getBoundingClientRect();
    return r.top + r.height / 2 - currentTy(card) * z;
  };
  const neighbors = new Set([...(currentAdjOut.get(id) || []), ...(currentAdjIn.get(id) || [])]);
  const hoverCol = hc.closest('.column');

  // 연결된 이웃 카드를 컬럼별로 모음 (같은 컬럼 이웃은 띄울 필요 없음)
  const byCol = new Map();
  for (const nid of neighbors) {
    const el = cardEls.get(nid);
    if (!el || el === hc || !el.offsetParent) continue;
    const col = el.closest('.column') || el.parentElement;
    if (col === hoverCol) continue;
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push(el);
  }

  // 이번 hover와 무관한 잔상 복귀
  resetMovers();
  const hCenter = baseCenterOf(hc);

  // 같은 컬럼에 이웃이 여럿이면 hover 행 주변으로 카드 한 장 높이씩 분산 (겹침 방지)
  for (const [col, cards] of byCol) {
    cards.sort((a, b) => baseCenterOf(a) - baseCenterOf(b));
    const n = cards.length;
    const row = cards[0].getBoundingClientRect().height + 10;   // 카드 행 간격 (박스 높이가 아니라 카드 높이 기준)
    const plan = cards.map((el, i) => ({ el, anchor: baseCenterOf(el), center: hCenter + (i - (n - 1) / 2) * row }));
    // hover 노드가 상단이면 목표가 컬럼 헤더 위로 벗어남 → 헤더 아래로 전체 보정
    const head = col.querySelector('.column-head');
    const minY = (head ? head.getBoundingClientRect().bottom : col.getBoundingClientRect().top) + 6 * z;
    let push = 0;
    for (const p of plan) push = Math.max(push, minY - (p.center - row / 2));
    for (const p of plan) {
      const delta = (p.center + push - p.anchor) / z;          // 카드를 hover 행에 맞춰 띄움
      p.el.classList.add('aligning', 'card-lift');
      p.el.style.transform = `translateY(${delta.toFixed(1)}px)`;
    }
  }
  animateConnectors();
}
function clearAlign() {
  hoverId = null;
  resetMovers();
  if (pinned.size) highlightActive();   // 핀이 있으면 hover 해제 후에도 핀 강조 유지
  else applyHighlight();
  animateConnectors();
}

// =========================================================================
// 상세 패널
// =========================================================================
// 화면(SCREEN) 노드 → 분석 그래프로 간략한 화면 구성(주소·사용 스토어·호출 API) 도식 생성
function screenComposition(n) {
  const stores = [], seenStore = new Set();
  for (const e of outEdges.get(n.id) || []) {
    const t = nodeById.get(e.target);
    if (!t || t.layer !== 'STORE') continue;
    const mod = (t.method || t.id).split('#')[0];
    if (mod && !seenStore.has(mod)) { seenStore.add(mod); stores.push(mod); }
  }
  // 다운스트림(같은 프로젝트)으로 내려가며 axios(EXTERNAL) 호출을 모으고, join 으로 백엔드 엔드포인트까지 해석
  const apis = [], seenApi = new Set(), visited = new Set([n.id]);
  let frontier = [n.id], guard = 0;
  while (frontier.length && guard++ < 3000) {
    const next = [];
    for (const id of frontier) for (const e of outEdges.get(id) || []) {
      const t = e.target, tn = nodeById.get(t);
      if (!tn || visited.has(t)) continue;
      visited.add(t);
      if (tn.layer === 'EXTERNAL') {
        const join = (outEdges.get(t) || []).find(je => je.kind === 'join');
        const be = join ? nodeById.get(join.target) : null;
        const method = ((be && be.httpMethod) || tn.httpMethod || '').toUpperCase();
        const path = (be && be.endpoint) || tn.externalUrl || tn.method || t;
        const key = method + ' ' + path;
        if (!seenApi.has(key)) { seenApi.add(key); apis.push({ method, path, svc: be && be.project, epId: be && be.id }); }
      } else if (tn.project === n.project) next.push(t);
    }
    frontier = next;
  }
  const chips = stores.length
    ? stores.map(s => `<span class="sm-chip">${esc(s)}</span>`).join('')
    : '<span class="sm-empty">의존 스토어 없음</span>';
  const apiRows = apis.length
    ? apis.map(a => `<div class="sm-api"${a.epId ? ` data-ep="${escAttr(a.epId)}"` : ''}>`
        + `<span class="nc-badge http ${methodClass(a.method || 'any')}">${esc(a.method || 'ANY')}</span>`
        + `<code class="sm-path">${esc(a.path)}</code>`
        + (a.svc ? `<span class="sm-svc">${esc(a.svc)}</span>` : '') + `</div>`).join('')
    : '<span class="sm-empty">호출 API 없음</span>';
  return `
    <div class="screen-mock">
      <div class="sm-chrome"><span class="sm-dot r"></span><span class="sm-dot y"></span><span class="sm-dot g"></span>`
        + `<span class="sm-addr">${esc(n.endpoint || n.method || '')}</span></div>
      <div class="sm-screen">
        <div class="sm-title">🖥 ${esc(n.method || '')}</div>
        <div class="sm-block">
          <div class="sm-block-h">🗃️ 상태 · 스토어 <span class="sm-n">${stores.length}</span></div>
          <div class="sm-chips">${chips}</div>
        </div>
        <div class="sm-block">
          <div class="sm-block-h">🔌 API 호출 <span class="sm-n">${apis.length}</span></div>
          <div class="sm-apis">${apiRows}</div>
        </div>
      </div>
    </div>`;
}

function renderDetail() {
  const el = document.getElementById('detail');
  const id = state.sel;
  const n = id ? nodeById.get(id) : null;
  // 엔드포인트 · 인프라 · 화면(SCREEN) · 코드 메서드(Controller/Service/Repository/Component 등) 노드 선택 시 패널 표시
  const show = !!n && ((n.layer === 'CONTROLLER' && n.endpoint) || isInfra(id, n) || n.layer === 'SCREEN' || !!n.fqcn);
  const toggled = el.classList.contains('hidden') === show;
  el.classList.toggle('hidden', !show);
  document.getElementById('detail-resizer').classList.toggle('hidden', !show);
  if (toggled && currentEdges.length) requestAnimationFrame(drawConnectors);   // 패널 표시 여부 변경 → 캔버스 폭 변동
  if (!show) { el.innerHTML = ''; return; }
  const isFocus = id === state.focus;
  const rows = [];
  const row = (k, v) => { if (v != null && v !== '') rows.push(`<tr><td class="k">${k}</td><td class="v">${esc(String(v))}</td></tr>`); };
  row('layer', n.layer);
  row('project', n.project);
  if (n.httpMethod || n.endpoint) row('endpoint', `${n.httpMethod || ''} ${n.endpoint || ''}`.trim());
  row('externalUrl', n.externalUrl);
  row('resource', n.resourceType);
  row('returnType', n.returnType);
  row('async', n.async ? 'true' : null);
  if (n.file) row('file', `${n.file}${n.line ? ':' + n.line : ''}`);
  row('id', n.id);

  let actions = '';
  if (isFocus) {
    actions = `<button class="btn primary" data-act="expand">${state.expanded ? '▲ 프로세스 접기' : '▼ 프로세스 상세보기'}</button>`;
  } else if (!isInfra(id, n)) {
    actions = `<button class="btn primary" data-act="focus">🎯 이 노드 기준 호출관계분석</button>`;
  }
  // API 문서 모듈 미로드 시: 로드 트리거 버튼 (로드 후엔 확장 훅이 직접 렌더)
  if (n.layer === 'CONTROLLER' && n.endpoint && !featureLoaded.has('apidoc')) {
    actions += `<button class="btn" data-act="apidoc">📄 API 문서</button>`;
  }
  // Kafka 토픽 → 토픽 영향도 분석 (features/topic.js lazy load)
  if (n.resourceType === 'kafka-topic') {
    actions += `<button class="btn primary" data-act="topicview">📡 토픽 영향도 분석</button>`;
  }

  el.innerHTML = `
    <div class="detail-head">
      <div class="detail-method">${esc(n.method || n.id)}</div>
      <div class="detail-class">${esc(n.fqcn || '')}</div>
      <div class="detail-tags">
        <span class="tag">${esc(n.layer)}</span>
        ${n.project ? `<span class="tag">${esc(n.project)}</span>` : ''}
        ${n.httpMethod ? `<span class="tag ${methodClass(n.httpMethod)}">${esc(n.httpMethod)}</span>` : ''}
        ${n.async ? '<span class="tag">async</span>' : ''}
      </div>
    </div>
    ${n.description ? `<div class="nc-desc" style="color:var(--text-dim);margin-bottom:8px">${esc(n.description)}</div>` : ''}
    ${n.layer === 'SCREEN' ? screenComposition(n) : ''}
    <div class="detail-actions">${actions}<button class="btn" data-act="share">🔗 이 화면 공유 링크 복사</button></div>
    <table class="detail-table">${rows.join('')}</table>`;

  el.querySelector('[data-act="focus"]')?.addEventListener('click', () => setFocus(id));
  el.querySelector('[data-act="expand"]')?.addEventListener('click', () => toggleExpand());
  el.querySelector('[data-act="share"]')?.addEventListener('click', (e) => copyToClipboard(shareUrl(), e.target));
  el.querySelector('[data-act="apidoc"]')?.addEventListener('click', () => loadFeature('apidoc').then(() => renderDetail()).catch(() => {}));
  el.querySelector('[data-act="topicview"]')?.addEventListener('click', () => openView('topic', { topic: id }));
  // 화면 구성도의 API 행 클릭 → 해당 백엔드 엔드포인트 선택
  el.querySelectorAll('.sm-api[data-ep]').forEach(rowEl =>
    rowEl.addEventListener('click', () => { const ep = rowEl.dataset.ep; if (nodeById.has(ep)) setSel(ep); }));
  // 기능 모듈의 상세 패널 확장 (영향 커밋 / API 문서 등)
  for (const fn of detailExtensions) { try { fn(n, el); } catch (err) { console.error('detail extension 오류', err); } }
}

// =========================================================================
// 검색
// =========================================================================
function runSearch(q) {
  const box = document.getElementById('search-results');
  q = q.trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); return; }
  const hits = [];
  for (const n of NODES) {
    if (matches(q, n.method, n.fqcn, n.id, n.endpoint, n.description)) { hits.push(n); if (hits.length >= 40) break; }
  }
  if (!hits.length) { box.innerHTML = '<div class="search-empty">결과 없음</div>'; box.classList.remove('hidden'); return; }
  box.innerHTML = hits.map(n => {
    const sub = n.layer === 'CONTROLLER' && n.endpoint ? esc(n.endpoint) : esc(shortClass(n.fqcn || n.id));
    const mb = (n.layer === 'CONTROLLER' && n.httpMethod)
      ? `<span class="nc-badge http ${methodClass(n.httpMethod)} si-mb">${esc(n.httpMethod)}</span>`
      : `<span class="legend-swatch" style="background:${layerColor(n)}"></span>`;
    return `<div class="search-item" data-id="${escAttr(n.id)}" tabindex="-1">
      ${mb}
      <span class="si-text"><span class="si-method">${markHit(n.method || n.id, q)}</span>
      <span class="si-sub">  ${markHit(sub, q)}${n.project ? ' · ' + esc(n.project) : ''}</span></span>
      <button class="si-go" title="이 노드 기준 호출관계분석">↗</button></div>`;
  }).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.search-item').forEach(it => {
    it.addEventListener('click', () => {
      setFocus(it.dataset.id, null);
      document.getElementById('search').value = '';
      box.classList.add('hidden');
    });
  });
}
function markHit(text, q) {
  const s = String(text == null ? '' : text);
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
}
function matches(q, ...vals) { return vals.some(v => v && String(v).toLowerCase().includes(q)); }

// =========================================================================
// 핸들러
// =========================================================================
function attachHandlers() {
  const search = document.getElementById('search');
  search.addEventListener('input', e => runSearch(e.target.value));
  search.addEventListener('focus', e => { if (e.target.value) runSearch(e.target.value); });
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) document.getElementById('search-results').classList.add('hidden'); });
  document.querySelectorAll('.stepper button').forEach(b => b.addEventListener('click', () => setDepth(b.dataset.depth, parseInt(b.dataset.dir, 10))));
  document.getElementById('back-to-browse').addEventListener('click', () => {
    if (state.service || state.infraType) setOverview(true);
    else if (state.fromOverview) setOverview(true);
    else if (state.fromService) setService(state.fromService);
    else clearFocus();
  });
  // 좌측 메뉴 = 해당 페이지로 이동 (토글 OFF 없음 — 다시 눌러도 그 페이지 유지)
  document.getElementById('overview-btn').addEventListener('click', () => setOverview(true));
  document.getElementById('structure-btn').addEventListener('click', () => setStructure(true));
  document.querySelectorAll('#nav .nav-btn[data-view]').forEach(b =>
    b.addEventListener('click', () => openView(b.dataset.view)));
  setupDetailResizer();
  document.getElementById('share-btn').addEventListener('click', e => copyToClipboard(shareUrl(), e.target));
  window.addEventListener('resize', () => {
    if (currentEdges.length) requestAnimationFrame(drawConnectors);
    if (dockDraw) requestAnimationFrame(dockDraw);
  });
  // 숨김 상태(백그라운드 탭/패널)에서는 rAF가 실행되지 않음 → 다시 보일 때 연결선 재드로우
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (currentEdges.length) requestAnimationFrame(drawConnectors);
    if (dockDraw) requestAnimationFrame(dockDraw);
  });
  document.addEventListener('keydown', onKeydown);

  // 트랙패드 핀치(ctrlKey wheel) → 확대/축소. 일반 휠/투핑거 스크롤은 패닝(기본 동작 유지)
  const flow = document.getElementById('flow');
  flow.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;                 // 핀치 제스처만 가로챔
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.0125), e.clientX, e.clientY);
  }, { passive: false });
  // 줌 컨트롤 버튼
  document.getElementById('zoom-ctl').addEventListener('click', e => {
    const k = e.target.closest('button')?.dataset.zoom;
    if (k === 'in') zoomBy(1.2);
    else if (k === 'out') zoomBy(1 / 1.2);
    else if (k === 'reset') resetZoom();
  });
}

function searchActiveIndex(items) { return items.findIndex(it => it.classList.contains('kb-active')); }
function onKeydown(e) {
  const search = document.getElementById('search');
  const box = document.getElementById('search-results');
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  const resultsOpen = !box.classList.contains('hidden');

  if (resultsOpen && e.target === search) {
    const items = [...box.querySelectorAll('.search-item')];
    if (items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        let i = searchActiveIndex(items);
        items.forEach(it => it.classList.remove('kb-active'));
        i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
        items[i].classList.add('kb-active');
        items[i].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const i = searchActiveIndex(items);
        const it = items[i >= 0 ? i : 0];
        if (it) { setFocus(it.dataset.id, null); search.value = ''; box.classList.add('hidden'); }
        return;
      }
    }
    if (e.key === 'Escape') { box.classList.add('hidden'); search.blur(); return; }
  }

  if (typing) return;

  if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.2); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.2); return; }
  if (e.key === '0') { e.preventDefault(); resetZoom(); return; }
  if (e.key === 'Escape') {
    if (state.view) { const m = featureViews.get(state.view); (m && m.escape) ? m.escape() : setOverview(true); return; }
    if (state.overview) return;   // 전체보기는 홈 — Esc 로 빠져나가지 않음
    if (state.service && state.svcPick) { setServicePick(state.svcPick); return; }
    if (state.structFile) { setStructPath(state.structSvc, state.structPath); return; }
    if (state.structPath) { setStructSvc(state.structSvc); return; }   // 흐름 → 경로 그룹
    if (state.structSvc) { setStructure(true); return; }               // 경로 그룹 → picker
    if (state.service || state.infraType) { setOverview(true); return; }
    if (state.structure) { setStructure(false); return; }
    if (state.focus && state.fromOverview) { setOverview(true); return; }
    if (state.focus && state.fromService) { setService(state.fromService); return; }
    if (state.focus) { clearFocus(); return; }
    return;
  }
  if (e.key === 'Backspace') {
    if (state.view) { e.preventDefault(); const m = featureViews.get(state.view); (m && m.escape) ? m.escape() : setOverview(true); return; }
    if (state.overview) return;   // 전체보기는 홈 — Backspace 로 빠져나가지 않음
    if (state.service && state.svcPick) { e.preventDefault(); setServicePick(state.svcPick); return; }
    if (state.structFile) { e.preventDefault(); setStructPath(state.structSvc, state.structPath); return; }
    if (state.structPath) { e.preventDefault(); setStructSvc(state.structSvc); return; }
    if (state.structSvc) { e.preventDefault(); setStructure(true); return; }
    if (state.service || state.infraType) { e.preventDefault(); setOverview(true); return; }
    if (state.structure) { e.preventDefault(); setStructure(false); return; }
    if (state.focus && state.fromOverview) { e.preventDefault(); setOverview(true); return; }
    if (state.focus && state.fromService) { e.preventDefault(); setService(state.fromService); return; }
    if (state.focus) { e.preventDefault(); clearFocus(); return; }
    return;
  }
}

// =========================================================================
// 유틸
// =========================================================================
async function copyToClipboard(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  if (btn) { const t = btn.textContent; btn.textContent = '✓ 복사됨'; btn.classList.add('ok'); setTimeout(() => { btn.textContent = t; btn.classList.remove('ok'); }, 1400); }
}
function layerColor(n) {
  const cs = getComputedStyle(document.documentElement);
  if (n.layer === 'RESOURCE') return cs.getPropertyValue(n.resourceType === 'kafka-topic' ? '--c-kafka' : n.resourceType === 'db-table' ? '--c-db' : '--c-redis');
  return cs.getPropertyValue('--c-' + (LAYER_CLASS[n.layer] || 'other'));
}
function shortClass(fqcn) {
  if (!fqcn) return '';
  const p = fqcn.split('.');
  return p.length > 2 ? '…' + p.slice(-2).join('.') : fqcn;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escAttr(s) { return esc(s).replace(/'/g, '&#39;'); }

// =========================================================================
// 기능 모듈 호스트 — features/*.js lazy load
//   메뉴 진입 시에만 코드(js/css)와 데이터(impact.json/openapi.json)를 로드한다.
//   각 모듈은 IIFE 로 window.Flowmap.registerView()/registerDetailExtension() 호출.
//   계약 문서: docs/FEATURE-API.md
// =========================================================================
const FEATURE_VER = '24';                      // 기능 모듈 캐시 버스팅
const FEATURE_OF_VIEW = { commits: 'impact', topic: 'topic', api: 'apidoc' };
const featureLoaded = new Map();               // 모듈명 → Promise (js+css 1회 로드)
const featureViews = new Map();                // 뷰명 → { render(), escape()? }
const detailExtensions = [];                   // fn(node, panelEl)
const dataCache = new Map();                   // 경로 → Promise<json|null>

function loadFeature(name) {
  if (featureLoaded.has(name)) return featureLoaded.get(name);
  const p = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `features/${name}.css?v=${FEATURE_VER}`;
    document.head.appendChild(link);
    const s = document.createElement('script');
    s.src = `features/${name}.js?v=${FEATURE_VER}`;
    s.onload = () => resolve();
    s.onerror = () => { featureLoaded.delete(name); reject(new Error('기능 모듈 로드 실패: ' + name)); };
    document.body.appendChild(s);
  });
  featureLoaded.set(name, p);
  return p;
}

// 404 도 정상 상태(null)로 취급 — 데이터 부재는 각 모듈이 빈 상태로 안내
function fetchData(path) {
  if (!dataCache.has(path)) dataCache.set(path, jsonFetch(path));   // COMPRESSED 시 .gz 자동 사용
  return dataCache.get(path);
}

function urlParamOf(name) {
  const v = rawParam(name);
  return v == null ? null : decodeURIComponent(v);
}

// 기능 뷰 진입 (코어 상태 정리 + URL 동기화 + 렌더)
function openView(view, params) {
  if (!FEATURE_OF_VIEW[view]) return;
  state.view = view;
  state.overview = false; state.structure = false; state.structSvc = null; state.structPath = null; state.structFile = null; state.service = null; state.infraType = null; state.svcPick = null;
  state.focus = null; state.fromService = null; state.fromOverview = false; state.expanded = false;
  state.sel = null;
  pushViewUrl(view, params || {});
  render(); renderDetail();
}
// 기능 뷰 내부 상태 변경 시 URL 갱신 (view= 는 자동 포함)
function pushViewUrl(view, params) {
  const parts = ['view=' + encodeURIComponent(view)];
  for (const [k, v] of Object.entries(params || {}))
    if (v != null && v !== '') parts.push(k + '=' + encodeURIComponent(v));
  history.pushState({}, '', location.pathname + '?' + parts.join('&'));
}

function renderFeatureView() {
  const view = state.view;
  const feat = FEATURE_OF_VIEW[view];
  document.getElementById('analysis-bar').classList.add('hidden');
  document.getElementById('svc-filter-wrap')?.remove();
  document.getElementById('process-dock').classList.add('hidden');
  dockFeature = false;   // 기능 전환 시 독 요청 초기화 — 해당 모듈이 다시 켠다
  currentEdges = []; buildCurrentAdj();
  document.getElementById('connectors').innerHTML = '';
  const cols = document.getElementById('columns');
  const loaded = featureLoaded.has(feat);
  if (!loaded) { cols.className = ''; cols.innerHTML = '<div class="feature-loading">기능 모듈 불러오는 중…</div>'; }
  loadFeature(feat).then(() => {
    if (state.view !== view) return;           // 로드 중 다른 화면으로 이동
    const mod = featureViews.get(view);
    if (mod) mod.render();
    else cols.innerHTML = '<div class="feature-loading">⚠ 모듈이 뷰를 등록하지 않았습니다: ' + esc(view) + '</div>';
  }).catch(err => {
    if (state.view !== view) return;
    cols.className = '';
    cols.innerHTML = '<div class="feature-loading">⚠ ' + esc(err.message) + '</div>';
  });
}

// 기능 모듈 공개 API — 모듈은 이 표면만 사용한다 (코어 내부 직접 접근 금지)
window.Flowmap = {
  // 데이터 (읽기 전용으로 취급)
  get NODES() { return NODES; },
  get EDGES() { return EDGES; },
  get META() { return META; },
  get MANIFEST() { return MANIFEST; },
  nodeById, inEdges, outEdges, state, cardEls,
  // 상수
  LAYER_CLASS, RES_ICON, KIND_COLOR, INFRA_LABEL, INFRA_ICON,
  // 유틸
  esc, escAttr, shortClass, methodClass, layerColor, kindClass, isInfra, infraGroup, byCallSite, pickLabelOf,
  copyToClipboard, shareUrl, matches, markHit,
  // 렌더 빌딩블록 (카드/컬럼/그룹박스/BFS)
  makeCard, mkHead, appendGroupBox, renderGroupedBoxes, computeColumns,
  // 캔버스 — setCanvasEdges(edges) 후 requestAnimationFrame(drawConnectors)
  setCanvasEdges(edges) { currentEdges = edges; buildCurrentAdj(); },
  drawConnectors, pruneOrphans, applyHighlight,
  // 네비게이션 / 상태
  setFocus, setService, setOverview, setStructure, setStructSvc, setStructPath, setStructFile, setSel, setInfraType, clearFocus,
  // 하단 프로세스 독 — 기능 뷰에서 state.sel 기준으로 표시 (on=true 후 setSel 로 base 지정)
  setProcessDockEnabled(on) { dockFeature = !!on; renderProcessDock(); },
  openView, pushViewUrl, param: urlParamOf, renderDetail,
  // 모듈 등록 / 데이터 로드
  registerView(view, mod) { featureViews.set(view, mod); },
  registerDetailExtension(fn) { detailExtensions.push(fn); },
  loadFeature, fetchData,
};

boot();
