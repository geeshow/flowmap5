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
// 서비스 보기 정적 세로 정렬: 카드 id → 적용한 translateY(로컬 px). hover 정렬이 끝나도 이 값으로 복원.
let svcAlignBy = new Map();
// 뷰 전용 합성(aggregate) 노드 — 프론트 화면을 {path1} 그룹 노드로 묶을 때 nodeById 에 임시 등록한다.
// 다음 render 에서 정리(cleanSynthNodes)해 다른 뷰를 오염시키지 않는다.
let synthNodeIds = [];
function cleanSynthNodes() { for (const id of synthNodeIds) nodeById.delete(id); synthNodeIds = []; }

const state = {
  view: null,                // 기능 모듈 뷰 (commits/topic/api — features/*.js lazy load)
  overview: false,           // 전체 서비스 지도 모드 (화면 진입 기준)
  overviewRepo: null,        // 전체보기 repo(저장소) 한정 — 그 repo sub-project + 직접 연관 서비스만
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
  zoom: 0.9,                 // 트랙패드 핀치 확대/축소 배율 (기본 살짝 축소)
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

  parseUrl();
  attachHandlers();
  applyZoom();                 // 기본 줌(축소) 반영 — render 전에 적용해 커넥터 좌표 정합
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
  // graph 가 null 인 항목(예: repo 단위 impact 전용 프로젝트 — 모노레포 PR 영향도)은 그래프가 없다.
  // 페치하지 않고 g:null 로 둬 전체보기/구조 뷰에선 제외하고, commit/PR 뷰만 impact 를 읽게 한다.
  const results = await Promise.all(manifest.projects.map(p =>
    p.graph ? jsonFetch('data/' + p.graph).then(g => ({ p, g })) : Promise.resolve({ p, g: null })));

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
    if (!g || !Array.isArray(g.nodes)) {
      if (p.graph) console.warn('[flowmap] 프로젝트 그래프 로드 실패, 건너뜀:', p.name, p.graph);  // graph:null 은 의도된 impact-전용 항목
      continue;
    }
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
  const ctrlByAlias = new Map();   // alias(예: nexcore .jmd 트랜잭션 Tid) → 노드. alias 없는 백엔드는 비어 무영향
  const ctrlAll = [];              // suffix(trailing-segment) 매칭용 전체 CONTROLLER 후보
  const nodeIndex = new Map();
  for (const n of NODES) {
    nodeIndex.set(n.id, n);
    if (n.layer === 'CONTROLLER' && n.endpoint) {
      const k = normPath(n.endpoint);
      if (!ctrlByPath.has(k)) ctrlByPath.set(k, []);
      ctrlByPath.get(k).push(n);
      ctrlAll.push(n);
    }
    if (Array.isArray(n.aliases)) {
      for (const a of n.aliases) {
        if (!a) continue;
        if (!ctrlByAlias.has(a)) ctrlByAlias.set(a, []);
        ctrlByAlias.get(a).push(n);
      }
    }
  }
  const absorbed = new Set();
  for (const e of EDGES) {
    if (e.kind !== 'external') continue;
    const src = nodeIndex.get(e.source);
    if (src && frontProjects.has(src.project)) continue;   // 프론트 외부호출은 join 으로 처리
    const ext = nodeIndex.get(e.target);
    if (!ext || !ext.endpoint) continue;        // endpoint 없는 서드파티(외부 URL만)는 external 유지
    const callerProject = src && src.project;
    const callerModule = src && src.module;
    const diffSvc = c => (c.project !== callerProject || c.module !== callerModule);  // 호출자와 다른 서비스여야 S2S
    const np = normPath(ext.endpoint);
    const hints = hintTokens(ext);
    const s2s = ext.s2sService || null;
    // Tier 1: 정확한 경로 완전일치.
    const exact = (ctrlByPath.get(np) || [])
      .filter(c => verbCompatible(ext.httpMethod, c.httpMethod) && diffSvc(c));
    let pick = pickByHint(exact, s2s, hints, callerProject);
    // Tier 2: trailing-segment suffix 매칭 (base-path/context-path/gateway prefix 흡수).
    if (!pick) {
      const cands = ctrlAll.filter(c => verbCompatible(ext.httpMethod, c.httpMethod) && diffSvc(c));
      const sfx = [];
      for (const c of cands) {
        const drop = suffixDrop(np, normPath(c.endpoint));
        if (drop != null) sfx.push({ node: c, drop });
      }
      if (sfx.length) {
        const bestDrop = sfx.reduce((m, x) => x.drop < m ? x.drop : m, Infinity);
        const tied = sfx.filter(x => x.drop === bestDrop).map(x => x.node);
        const signal = tied.filter(c => c.project === s2s ||
          projectMatchesHint(c.project, hints) || moduleMatchesHint(c.module, hints));
        if (signal.length) {
          pick = pickByHint(signal, s2s, hints, callerProject);
        } else if (sfx.length === 1) {
          // 유일 + concrete verb 면 host 정보 없이도 흡수.
          const only = sfx[0].node;
          const verb = (ext.httpMethod || 'ANY').toUpperCase();
          const ov = (only.httpMethod || 'ANY').toUpperCase();
          if (verb !== 'ANY' && ov !== 'ANY') pick = only;
        }
      }
    }
    // Tier 3: alias 매칭 (nexcore .jmd 트랜잭션을 /std·/lng 프리픽스로 호출하는 경우).
    if (!pick) {
      const aliasId = aliasMatch(ext.endpoint, ext.httpMethod, ctrlByAlias);
      const t = aliasId && nodeIndex.get(aliasId);
      if (t && diffSvc(t)) pick = t;
    }
    if (!pick) continue;                          // 매칭 실패 — external 유지
    e.kind = 's2s'; e.relation = 'call'; e.target = pick.id;
    absorbed.add(ext.id);
  }
  if (absorbed.size) {
    const refed = new Set();
    for (const e of EDGES) { refed.add(e.source); refed.add(e.target); }
    NODES = NODES.filter(n => !(absorbed.has(n.id) && !refed.has(n.id)));
  }
}

// 충돌 시 picking: s2s-host 해석값 > Feign이름/placeholder hint > cross-project > 첫 후보.
function pickByHint(cands, s2s, hints, callerProject) {
  if (!cands || !cands.length) return null;
  if (s2s) { const a = cands.find(c => c.project === s2s); if (a) return a; }
  const b = cands.find(c => projectMatchesHint(c.project, hints) || moduleMatchesHint(c.module, hints));
  if (b) return b;
  const c = cands.find(x => x.project !== callerProject);
  return c || cands[0];
}
// 충돌 hint 토큰: externalService(Feign 이름) + ${...} placeholder leaf — 우선 후보 가늠용 추출.
function hintTokens(ext) {
  const out = [];
  if (ext.externalService) out.push(ext.externalService);
  for (const raw of [ext.externalUrl, ext.urlPlaceholder]) {
    if (!raw) continue;
    const re = /\$\{([^}]*)\}/g; let m;
    while ((m = re.exec(raw))) {
      const leaf = m[1].split('.').pop();
      if (leaf) out.push(leaf);
    }
  }
  return out.map(t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
}
function projectMatchesHint(project, tokens) {
  if (!project || !tokens.length) return false;
  const p = project.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tokens.some(t => t === p || p.includes(t) || t.includes(p));
}
function moduleMatchesHint(module, tokens) {
  if (!module || !tokens.length) return false;
  const m = module.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tokens.some(t => t === m || m.includes(t) || t.includes(m));
}
// 짧은 path 가 긴 path 의 trailing-segment suffix (둘 다 2 세그 이상) 일 때, 긴 쪽에서 떨어진 leading segment 개수.
// null 이면 suffix 관계 아님. 원본일치는 호출자가 Tier 1 에서 처리.
function suffixDrop(a, b) {
  const sa = (a || '').split('/').filter(Boolean);
  const sb = (b || '').split('/').filter(Boolean);
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length < 2 || short.length === long.length) return null;
  const tail = long.slice(long.length - short.length);
  for (let i = 0; i < short.length; i++) if (tail[i] !== short[i]) return null;
  return long.length - short.length;
}

// 게이트웨이를 경유한 프론트→백엔드 매칭.
//   프론트는 게이트웨이 public 경로(/user/v3/rsa)로 호출하지만 백엔드는 프리픽스가 (라우트 필터로)
//   벗겨진 실제 경로(/v3/rsa)를 기록하므로 직접매칭이 실패한다.
//   ① 발견된 라우트 테이블(<gw>.gateway.json)이 있으면: publicPrefix 가 맞는 라우트를 찾아 그 라우트의
//      backendPrefix 로 치환(StripPrefix/RewritePath/PrefixPath 결과)해 백엔드 경로를 만들고 매칭 →
//      "/oauth"(미변환)와 "/user"(프리픽스 제거)처럼 라우트마다 다른 변환을 정확히 반영한다.
//   ② 라우트 테이블이 없거나 맞는 라우트가 없으면: 첫 세그먼트만 떼는 휴리스틱으로 폴백.
//   두 경우 모두 후보가 유일할 때만 연결한다.
function gatewayMatch(path, method, ctrlByPath, routes) {
  if (!path) return null;
  const np = normPath(path);
  const tryPath = (p) => {
    const cands = (ctrlByPath.get(normPath(p || '/')) || []).filter(c => verbCompatible(method, c.httpMethod));
    return cands.length === 1 ? cands[0].id : null;
  };
  if (routes && routes.length) {                          // ① 라우트 테이블 기반 (publicPrefix 긴 것부터)
    let prefixOwned = false;
    for (const r of routes) {
      const pp = normPath(r.publicPrefix || '');
      if (!pp || pp === '/') continue;
      if (np === pp || np.startsWith(pp + '/')) {
        prefixOwned = true;                               // 이 경로는 게이트웨이 라우트가 소유
        const rest = np.slice(pp.length);                 // '' 또는 '/...'
        const bp = (r.backendPrefix || '').replace(/\/+$/, '');
        const hit = tryPath(bp + rest);
        if (hit) return hit;
      }
    }
    if (prefixOwned) return null;                         // 라우트가 소유한 경로는 그 변환을 신뢰 → 휴리스틱 폴백 금지
  }
  const segs = np.split('/').filter(Boolean);             // ② 폴백: 라우트 테이블이 없거나 소유 라우트가 없을 때만 첫 세그먼트 제거
  if (segs.length < 2) return null;
  return tryPath('/' + segs.slice(1).join('/'));
}

// 별칭(alias) 매칭: 백엔드가 선언한 대체 키(예: nexcore .jmd 트랜잭션 Tid)를 경로 세그먼트로 조회.
//   프론트가 /std/TACU0001 · /lng/TACU0001 · /TACU0001 (±.jmd) 처럼 컨텍스트 프리픽스를 붙여 호출해도
//   토큰 세그먼트만 alias 인덱스에 맞으면 연결한다(프리픽스 열거 불필요). join.ts matchAlias 의 화면측 미러.
function aliasMatch(path, method, ctrlByAlias) {
  if (!path || !ctrlByAlias.size) return null;
  const segs = normPath(path).split('/').filter(Boolean);
  for (const s of segs) {
    const key = s.replace(/\.jmd$/i, '');
    const cands = (ctrlByAlias.get(key) || []).filter(c => verbCompatible(method, c.httpMethod));
    if (cands.length === 1) return cands[0].id;           // Tid 는 전역 유일 → 항상 단일 후보
  }
  return null;
}

// 프론트→백엔드 연결: <project>.join.json 의 matched 링크 + 게이트웨이 프리픽스 매칭을 kind:'join' 엣지로 추가
async function loadAndApplyJoins() {
  if (!MANIFEST) return;
  const joinFiles = MANIFEST.projects.filter(p => p.join).map(p => p.join);
  if (!joinFiles.length) return;
  const idSet = new Set(NODES.map(n => n.id));
  // 백엔드 CONTROLLER 인덱스 (게이트웨이 프리픽스 제거 매칭용)
  const ctrlByPath = new Map();
  // 백엔드 alias 인덱스 (alias 선언 노드만; 예 nexcore .jmd 트랜잭션 Tid). alias 없는 백엔드는 비어 무영향.
  const ctrlByAlias = new Map();
  for (const n of NODES) {
    if (n.layer === 'CONTROLLER' && n.endpoint) {
      const k = normPath(n.endpoint);
      if (!ctrlByPath.has(k)) ctrlByPath.set(k, []);
      ctrlByPath.get(k).push(n);
    }
    if (Array.isArray(n.aliases)) {
      for (const a of n.aliases) {
        if (!a) continue;
        if (!ctrlByAlias.has(a)) ctrlByAlias.set(a, []);
        ctrlByAlias.get(a).push(n);
      }
    }
  }
  // 게이트웨이 라우트 테이블(<gw>.gateway.json) 로드 → publicPrefix 긴(구체적인) 순으로 정렬해
  //   gatewayMatch 가 가장 구체적인 라우트부터 시도하게 한다(예: /open-api/v1/users 가 /open-api 보다 먼저).
  const gatewayFiles = MANIFEST.projects.filter(p => p.gateway).map(p => p.gateway);
  const gwDocs = await Promise.all(gatewayFiles.map(f => jsonFetch('data/' + f)));
  const gwRoutes = gwDocs.flatMap(d => (d && Array.isArray(d.routes)) ? d.routes : [])
    .filter(r => r && r.publicPrefix)
    .sort((a, b) => (b.publicPrefix || '').length - (a.publicPrefix || '').length);

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
          // alias(.jmd 트랜잭션 등) → 게이트웨이 프리픽스 순으로 폴백 (join.ts tier 순서와 동일)
          const a = aliasMatch(link.normalizedPath, link.httpMethod, ctrlByAlias);
          if (a) { target = a; conf = conf || 'alias'; }
          else {
            const t = gatewayMatch(link.normalizedPath, link.httpMethod, ctrlByPath, gwRoutes);
            if (t) { target = t; conf = conf || 'gateway'; } // 게이트웨이 라우트 테이블/프리픽스 매칭
          }
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
    if (isExtCallNode(n.id, n) && n.project && !joined.has(n.id)) n.project = null;
  }
}

// 좌측 사이드바 하단 통계 — 로드된 그래프에서 집계
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
  const repoRaw = rawParam('repo');                                       // 전체보기 repo 한정
  const repoVal = repoRaw ? decodeURIComponent(repoRaw) : null;
  state.overviewRepo = state.overview && repoVal && repoList().includes(repoVal) ? repoVal : null;
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
    if (state.overviewRepo) parts.push('repo=' + encodeURIComponent(state.overviewRepo));
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
function setOverview(on, repo) {
  state.view = null;
  state.overview = !!on;
  state.overviewRepo = on ? (repo || null) : null;
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
  window.dispatchEvent(new Event('fm:zoom'));   // 기능 모듈(예: deploy PR 커넥터)이 줌 변경 시 좌표 재계산하도록 알림
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
// 외부 API 호출 노드 판별 — 백엔드는 layer 'EXTERNAL', 프론트 모노레포는 layer 'API' + ext:/externalUrl.
//   layer 만으로 구분하면 프론트(API 레이어) 외부호출을 놓쳐 화면↔화면 가짜 연결이 생긴다.
function isExtCallNode(id, n) {
  n = n || nodeById.get(id);
  if (!n) return /^ext:/.test(String(id));
  return n.layer === 'EXTERNAL' || /^ext:/.test(String(n.id || id)) || !!n.externalUrl;
}
function isInfra(id, n) {
  n = n || nodeById.get(id);
  if (!n) return /^(kafka:|db:|redis$|ext:)/.test(id);
  // RESOURCE 는 공유 인프라. 외부호출은 project 가 없을 때(미연결)만 공유 인프라;
  // project 가 붙은(백엔드 join 으로 흡수된) 프론트 외부호출 노드는 그 프론트 서비스의 노드로 취급한다.
  return n.layer === 'RESOURCE' || (isExtCallNode(id, n) && !n.project);
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
  document.querySelectorAll('#repo-subs .nav-sub-repo').forEach(b =>
    b.classList.toggle('active', state.overview && state.overviewRepo === b.dataset.repo));
  document.getElementById('structure-btn').classList.toggle('active', state.structure);
  const navSt = rawParam('st');
  document.querySelectorAll('#nav .nav-btn[data-view]').forEach(b => {
    if (b.dataset.st) b.classList.toggle('active', state.view === b.dataset.view && navSt === b.dataset.st);
    else b.classList.toggle('active', state.view === b.dataset.view && !(b.dataset.view === 'deploy' && navSt));
  });
  // 배포 영향도는 좌(레일)·우(영향도) 패널이 각자 내부 스크롤하는 고정 높이 레이아웃.
  // → #flow 의 페이지 스크롤을 끄고 자식 체인이 높이를 채우게 한다(다른 뷰로 가면 해제).
  document.getElementById('flow').classList.toggle('flow-panel', state.view === 'deploy');
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

// 기능 뷰 프로세스 독용 — base 의 양방향(피호출∪호출) 연결 폐포. 어떤 노드를 눌러도 그 노드가 속한
// 전체 프로세스 흐름(누가 부르는지 + 무엇을 부르는지)을 한 번에 보여준다.
//   변경 엔드포인트를 누르면 유출 단계까지, 유출 단계를 누르면 피호출 단계까지 같은 체인으로 묶인다.
function fullChainAdj(base) {
  const bases = Array.isArray(base) ? base : [base];
  const seen = new Set(bases);
  let frontier = [...bases];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const e of (outEdges.get(id) || []))
        if (nodeById.has(e.target) && !seen.has(e.target)) { seen.add(e.target); next.push(e.target); }
      for (const e of (inEdges.get(id) || []))
        if (nodeById.has(e.source) && !seen.has(e.source)) { seen.add(e.source); next.push(e.source); }
    }
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
  const changed = dockFeature && dockChangedNodes.has(id);   // 이 커밋에서 실제 수정된 (public) 메서드
  el.className = 'dock-node' + (id === rootId ? ' root' : '') + (changed ? ' dock-changed' : '');
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

// 독 내부 SVG 연결선 — kind 색/화살표/sync·async 구분/relation 라벨
//   bright: 강조(밝게 표시)된 노드 집합. 이 집합에 한쪽이라도 닿는 엣지만 선명(hot), 나머지는 흐리게(dim).
function drawDockConnectors(dock, edges, elOf, bright) {
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
    // 강조된 노드에 닿는 엣지만 선명(hot), 나머지는 흐리게(dim). 강조 노드가 없으면 평상(흐림) 상태.
    const hl = bright && bright.size > 0;
    const stateCls = hl ? ((bright.has(e.source) || bright.has(e.target)) ? ' hot' : ' dim') : '';
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
let dockChangedNodes = new Set();  // 기능 뷰가 지정한 "실제 수정된 메서드" id — 독 카드에서 강조
function renderProcessDock() {
  const dock = document.getElementById('process-dock');
  // 서비스 보기 = svcPick 기준(현재 컬럼 엣지), 기능 뷰 = 선택 노드(state.sel) 기준(실제 그래프 체인)
  const svcMode = !!state.service;
  const base = svcMode ? state.svcPick : (dockFeature ? state.sel : null);
  if (!base || !nodeById.has(base)) { dock.classList.add('hidden'); dock.innerHTML = ''; dockDraw = null; return; }
  const n = nodeById.get(base);
  const { nodes, edges, segOf, segLabels, truncated } = svcMode
    ? collectChainFlow(base)
    : (() => { const { aOut, aIn } = fullChainAdj(base); return collectChainFlow(base, aOut, aIn); })();

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

  // hover/클릭 강조: active 노드가 속한 연결 체인 전체(전이적 피호출∪호출, 중간 단계 포함)를 강조.
  // 노드를 클릭하면 그 강조를 고정(pin). 기능 뷰(커밋 영향도)는 기준 노드의 체인을 기본으로 펼쳐둔다.
  const chainOf = (active) => {
    const chain = new Set();
    if (!active) return chain;
    chain.add(active);
    // 하류(호출) + 상류(피호출) 양방향 전이 폐포 — 같은 흐름에 속한 노드를 모두 모은다
    for (const up of [false, true]) {
      let f = [active];
      while (f.length) {
        const nx = [];
        for (const cur of f) for (const e of edges) {
          const nb = up ? (e.target === cur ? e.source : null) : (e.source === cur ? e.target : null);
          if (nb && !chain.has(nb)) { chain.add(nb); nx.push(nb); }
        }
        f = nx;
      }
    }
    return chain;
  };
  // 경계 노드 = 흐름의 시작/끝 의미 단위(엔드포인트/화면/외부/인프라). 그 사이의 SERVICE/REPOSITORY 등
  // 중간 plumbing 단계는 강조 대상에서 빼서 투명 처리한다.
  const isBoundaryNode = (id) => {
    const nn = nodeById.get(id);
    if (!nn) return false;
    return nn.layer === 'CONTROLLER' || nn.layer === 'SCREEN' || nn.layer === 'EXTERNAL' || isInfra(id, nn);
  };
  // 기능 뷰: 기준(선택) 노드 + 이 커밋/PR 에서 수정된 노드는 hover 와 무관하게 항상 강조.
  const alwaysBright = new Set();
  if (dockFeature) {
    if (elOf.has(base)) alwaysBright.add(base);
    for (const id of dockChangedNodes) if (elOf.has(id)) alwaysBright.add(id);
  }
  // 강조(밝게) 집합 = 항상강조(기준·수정) ∪ active 가 속한 체인의 경계 노드. 중간 plumbing 단계는 제외(흐림).
  const brightOf = (active) => {
    const bright = new Set(alwaysBright);
    if (active) { bright.add(active); for (const id of chainOf(active)) if (isBoundaryNode(id)) bright.add(id); }
    return bright;
  };
  let hoverId = null, pinnedId = (!svcMode && elOf.has(base)) ? base : null;
  const applyDockHover = () => {
    const bright = brightOf(hoverId || pinnedId);
    const hl = bright.size > 0;
    for (const [nid, el] of elOf) {
      el.classList.toggle('dim', hl && !bright.has(nid));
      el.classList.toggle('pinned', nid === pinnedId);
    }
    dock.querySelector('.dock-svg').classList.toggle('overlay', hl);
    drawDockConnectors(dock, edges, elOf, bright);   // 강조 노드에 닿는 엣지만 선명(hot), 나머지 dim
  };
  for (const [nid, el] of elOf) {
    el.addEventListener('mouseenter', () => { hoverId = nid; applyDockHover(); });
    el.addEventListener('mouseleave', () => { hoverId = null; applyDockHover(); });
    el.addEventListener('click', () => { pinnedId = pinnedId === nid ? null : nid; hoverId = null; applyDockHover(); });
  }
  dockDraw = () => drawDockConnectors(dock, edges, elOf, brightOf(hoverId || pinnedId));
  requestAnimationFrame(applyDockHover);

  // 노드를 눌러 프로세스 흐름을 열면 선택한(기준) 노드가 보이도록 독을 스크롤하고 살짝 바운스시킨다.
  const rootCard = elOf.get(base);
  if (rootCard) requestAnimationFrame(() => {
    rootCard.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
    rootCard.classList.remove('dock-bounce');
    void rootCard.offsetWidth;            // 리플로우 — 같은 노드 재선택 시에도 애니메이션 재시작
    rootCard.classList.add('dock-bounce');
  });
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
        document.getElementById('layout').style.setProperty('--detail-w', w + 'px');   // 줌 컨트롤 위치 동기화
      },
      () => localStorage.setItem('fm.detailW', Math.round(detail.getBoundingClientRect().width)));
  });
}

// ---- 좌측 사이드바 너비 조절 + 접기/열기 ----
function setSidebarCollapsed(on) {
  document.body.classList.toggle('sidebar-collapsed', on);
  document.getElementById('sidebar-reopen').classList.toggle('hidden', !on);
  localStorage.setItem('fm.sbCollapsed', on ? '1' : '0');
  if (currentEdges.length) requestAnimationFrame(drawConnectors);
  if (dockDraw) requestAnimationFrame(dockDraw);
}
function setupSidebar() {
  const sb = document.getElementById('sidebar');
  const savedW = parseInt(localStorage.getItem('fm.sbW'), 10);
  if (savedW) sb.style.width = savedW + 'px';
  if (localStorage.getItem('fm.sbCollapsed') === '1') setSidebarCollapsed(true);
  document.getElementById('sidebar-collapse').addEventListener('click', () => setSidebarCollapsed(true));
  document.getElementById('sidebar-reopen').addEventListener('click', () => setSidebarCollapsed(false));
  const handle = document.getElementById('sidebar-resizer');
  handle.addEventListener('mousedown', e => {
    const startX = e.clientX, startW = sb.getBoundingClientRect().width;
    dragResize(e, handle,
      ev => { sb.style.width = Math.max(150, Math.min(420, startW + (ev.clientX - startX))) + 'px'; },
      () => localStorage.setItem('fm.sbW', Math.round(sb.getBoundingClientRect().width)));
  });
}

// ---- 우측 상세 패널 접기/열기 (너비 조절은 setupDetailResizer) ----
function setDetailCollapsed(on) {
  document.body.classList.toggle('detail-collapsed', on);
  localStorage.setItem('fm.detailCollapsed', on ? '1' : '0');
  renderDetail();   // 표시·리오픈 탭·--detail-w 재계산
}
function setupDetailCollapse() {
  if (localStorage.getItem('fm.detailCollapsed') === '1') document.body.classList.add('detail-collapsed');
  document.getElementById('detail-collapse').addEventListener('click', () => setDetailCollapsed(true));
  document.getElementById('detail-reopen').addEventListener('click', () => setDetailCollapsed(false));
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
    `<span class="ab-focus-label svc">서비스</span> ${svcBadge(svc, 'lg')}`
    + `<span class="ab-proj">${eps.length} APIs</span>`;

  // 브레드크럼: 전체보기 › 서비스 (노드 선택 시 › {METHOD} {API PATH} 3단계)
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-root">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span>`
    + (pickNode
      ? `<a class="bc-link" id="bc-svc">${svcBadge(svc)}</a>`
        + `<span class="bc-sep">›</span><span class="bc-focus">${esc(pickLabelOf(pickNode))}</span>`
      : svcBadge(svc, 'lg'));
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
    return { key: 'infra:' + t, label: INFRA_ICON[t] + ' ' + INFRA_LABEL[t], rank: ({ kafka: 1, redis: 2, db: 3, fep: 4, edw: 4, external: 4, other: 5 })[t] || 5, svc: null };
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

  // 같은 서비스 안 컴포넌트(예: acgoXXXX) 간 내부 호출을 base 그룹 노드 사이 엣지로 추가
  //   → base 컬럼에서 컴포넌트들이 개별 노드로 분리되면서 서로의 연결관계(내부 호출)까지 표현된다.
  const groupKeyOf = id => {
    const n = nodeById.get(id);
    if (!n || !n.project || isInfra(id, n)) return null;
    return 'spath:' + n.project + ':' + pathKeyOf(n);
  };
  for (const e of EDGES) {
    if (e.kind !== 'internal') continue;
    const sn = nodeById.get(e.source), tn = nodeById.get(e.target);
    if (!sn || !tn || sn.project !== svc || tn.project !== svc) continue;
    const sg = groupKeyOf(e.source), tg = groupKeyOf(e.target);
    if (sg && tg && sg !== tg && epIds.has(sg) && epIds.has(tg)) addEdge(sg, tg, e);
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
    pruneOrphans(); applyPickFilter(); alignServiceColumns(); drawConnectors(); applyHighlight();
    // 어느 서비스를 눌러도 동일하게 — 선택한 서비스의 그룹(base) 컬럼을 먼저 보이도록 가로 스크롤 정렬
    // (백엔드는 왼쪽에 피호출 단계가 있어 base 가 가운데로 밀리므로, 클릭 직후 base 로 스크롤)
    if (!state.svcPick) {
      const flow = document.getElementById('flow'), base = colsEl.querySelector('.svc-base');
      if (flow && base) flow.scrollLeft += base.getBoundingClientRect().left - flow.getBoundingClientRect().left - 24;
    }
  });
}

// 전체보기 → 서비스 → {path1} 그룹 드릴:
//   이 단계는 경계 레이어(화면 / endpoint / infra / 외부 api)만 서비스별 컬럼으로 보여준다.
//   내부 실행 체인(service/repository/component…)은 노드를 클릭하면 하단 프로세스 독에 펼쳐진다.
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
    + `<span class="ab-proj">${members.length}개 ${unit} · 노드 클릭 시 프로세스 흐름</span>`;

  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  bc.innerHTML = `<a class="bc-link" id="bc-root">🗺️ 전체보기</a>`
    + `<span class="bc-sep">›</span>`
    + `<a class="bc-link" id="bc-svc">${svcBadge(svc)}</a>`
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

  // 연관 폐포: 다운스트림(실행 흐름 전체) + 업스트림(이 엔드포인트를 부르는 화면/타서비스 엔드포인트까지만).
  //   업스트림은 경계(화면 / 다른 서비스의 엔드포인트)에 닿으면 멈춰 무관한 전역 확장을 막는다.
  const reach = new Set(members);
  { let f = [...members]; while (f.length) { const nx = [];   // 다운스트림: 서비스→repo→infra→외부→s2s
      for (const id of f) for (const e of outEdges.get(id) || []) { const t = e.target;
        if (nodeById.has(t) && !reach.has(t)) { reach.add(t); nx.push(t); } } f = nx; } }
  { let f = [...members]; while (f.length) { const nx = [];   // 업스트림: 호출자(화면/타서비스 엔드포인트)에서 정지
      for (const id of f) for (const e of inEdges.get(id) || []) { const s = e.source, sn = nodeById.get(s);
        if (!sn || reach.has(s)) continue; reach.add(s);
        const stop = sn.layer === 'SCREEN' || (sn.layer === 'CONTROLLER' && sn.endpoint && sn.project !== svc);
        if (!stop) nx.push(s); } f = nx; } }
  const aOut = new Map(), aIn = new Map();
  for (const e of EDGES) {
    if (!reach.has(e.source) || !reach.has(e.target)) continue;
    (aOut.get(e.source) || aOut.set(e.source, []).get(e.source)).push(e.target);
    (aIn.get(e.target) || aIn.set(e.target, []).get(e.target)).push(e.source);
  }
  const { nodes, edges, segOf, segLabels } = collectChainFlow(members, aOut, aIn);

  // 경계 노드 간 파생 엣지 — 내부(service/repo/hook/store…) 노드를 건너뛰고 경계끼리 잇는다.
  //   도달 시점의 엣지 kind(resource/external/s2s/join)를 써서 연결선 색이 의미를 갖게 한다.
  //   외부(EXTERNAL)는 join 으로 백엔드에 흡수되지 않은 "진짜 외부 api"(project 없음, isInfra)만 경계로 본다.
  //   join 으로 흡수된 프론트 ext 노드는 내부 취급해 화면→백엔드 엔드포인트로 곧장 잇는다.
  // 이 드릴 단계는 DB(테이블) 노드를 제외한다 — 화면/엔드포인트/외부·기타 인프라 경계만 표시.
  const isB = id => { const n = nodeById.get(id); return !!n && (n.layer === 'SCREEN' || n.layer === 'CONTROLLER' || (isInfra(id, n) && infraGroup(id) !== 'db')); };
  const renderable = id => segOf.has(id) && reach.has(id) && isB(id);   // 컬럼에 실제로 그려지는 경계 노드
  // reach 로 제한한 전역 그래프에서 직접 축약 (collectChainFlow 의 MAX=200 엣지 절단을 피한다)
  const cAdj = new Map();
  for (const e of EDGES) { if (!reach.has(e.source) || !reach.has(e.target)) continue;
    (cAdj.get(e.source) || cAdj.set(e.source, []).get(e.source)).push(e); }
  const boundaryEdges = [], beSeen = new Set();
  for (const b of nodes) {
    if (!renderable(b)) continue;
    const visited = new Set([b]), stack = [...(cAdj.get(b) || [])];
    while (stack.length) {
      const e = stack.pop(), t = e.target;
      if (visited.has(t)) continue; visited.add(t);
      if (renderable(t)) { const k = b + '|' + t; if (!beSeen.has(k)) { beSeen.add(k); boundaryEdges.push({ source: b, target: t, kind: e.kind, relation: e.relation, mode: e.mode }); } }
      else for (const e2 of cAdj.get(t) || []) stack.push(e2);   // 내부·미표시 노드는 통과
    }
  }

  // 프론트 드릴일 때만 다른 프론트(generic vuex id 충돌로 끼어드는) segment 를 제외한다.
  //   백엔드 드릴이면 이 엔드포인트를 호출하는 화면(프론트)이 정당한 업스트림이므로 남긴다.
  const svcIsFront = (MANIFEST?.projects || []).some(p => p.type === 'frontend' && p.name === svc);
  const otherFront = new Set(svcIsFront
    ? (MANIFEST?.projects || []).filter(p => p.type === 'frontend' && p.name !== svc).map(p => p.name)
    : []);
  const onPick = id => setServicePick(id);   // 노드 클릭 → 하단 프로세스 흐름(독)

  // 서비스(segment)별 컬럼 → 경계 레이어 박스만. 레이어 라벨(Controller 등)은 표시 안 함, 핀 활성.
  //   EXTERNAL(진짜 외부 api)은 segment 에서 빼서 맨 오른쪽 단일 컬럼으로 모은다.
  const externalIds = [];
  for (let s = 0; s < segLabels.length; s++) {
    if (otherFront.has(segLabels[s])) continue;
    // reach(이 경로의 연관 폐포)로 제한 — collectChainFlow 의 전역 walk 가 끌어온 무관 노드(화면의 다른 외부호출 등) 제외
    const segNodes = nodes.filter(id => segOf.get(id) === s && isB(id) && reach.has(id));
    externalIds.push(...segNodes.filter(id => nodeById.get(id).layer === 'EXTERNAL'));
    const svcNodes = segNodes.filter(id => nodeById.get(id).layer !== 'EXTERNAL');
    if (!svcNodes.length) continue;
    const col = document.createElement('div');
    col.className = 'column';
    col.appendChild(mkBadgeHead(segLabels[s], serviceHue(segLabels[s])));   // 서비스명 = 고유색 뱃지
    const present = [...new Set(svcNodes.map(id => nodeById.get(id).layer))]
      .sort((a, b) => (DRILL_LAYER_ORDER.indexOf(a) + 1 || 99) - (DRILL_LAYER_ORDER.indexOf(b) + 1 || 99));
    for (const layer of present) {
      const ids = svcNodes.filter(id => nodeById.get(id).layer === layer)
        .sort((a, b) => byNodeName(nodeById.get(a), nodeById.get(b)));
      appendGroupBox(col, null, ids.map(id => nodeById.get(id)), null, onPick, true);   // 라벨 제거, 핀 활성
    }
    colsEl.appendChild(col);
  }
  // EXTERNAL — 맨 오른쪽 단일 컬럼 (외부 api)
  if (externalIds.length) {
    const col = document.createElement('div');
    col.className = 'column ext-col';
    col.appendChild(mkBadgeHead('🌐 외부 API', 22));
    appendGroupBox(col, null, externalIds.map(id => nodeById.get(id)).sort(byNodeName), null, onPick, true);
    colsEl.appendChild(col);
  }

  currentEdges = boundaryEdges.filter(e => cardEls.has(e.source) && cardEls.has(e.target));
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
// 색상 뱃지형 컬럼 헤드 (hue = 서비스 고유색 / 외부 api 색). 서비스 보기·경로 드릴 공용.
function mkBadgeHead(label, hue) {
  const head = document.createElement('div');
  head.className = 'column-head svc-badge';
  head.style.setProperty('--bh', hue);
  head.innerHTML = `<span class="svc-badge-dot"></span>${esc(label)}`;
  return head;
}
function appendGroupBox(col, label, nodeList, onActivate, onPick, pin) {
  const box = document.createElement('div');
  box.className = 'path-group';
  box.dataset.path = label || '';
  if (label != null) box.innerHTML = `<div class="pg-head"><span class="pg-path">${esc(label)}</span><span class="pg-count">${nodeList.length}</span></div>`;
  const body = document.createElement('div');
  body.className = 'pg-body';
  for (const n of nodeList) {
    const isApi = n.layer === 'CONTROLLER' && n.endpoint;
    const card = makeCard(n.id, { route: isApi, onActivate, onPick, pin });
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
  if (n) {
    // 배치는 진입점 — 서비스(project) 단위로 묶어 진입/화면 컬럼에 '{service}-batch' 카드로 배치한다.
    if (n.layer === 'BATCH') return 'batch:' + (n.project || n.fqcn || id);
    // 외부호출이 yml host 매칭으로 다른 백엔드 서비스(s2sService)로 해석되면 그 서비스로 귀속 → server-to-server.
    if (isExtCallNode(id, n) && n.s2sService && (META.projects || []).includes(n.s2sService)) return 'svc:' + n.s2sService;
    // 외부 API 호출 노드는 기본적으로 공유 '외부 API' 로 묶는다 (project 태그 무시).
    //   같은 외부 URL 을 여러 프론트가 호출하면 id 충돌로 한 프론트 소속이 되어 화면↔화면 가짜 연결이 생기기 때문.
    //   (단, buildServiceGraph 가 join 엣지의 ext source 만 예외로 그 프론트 svc 에 귀속시켜 front→backend 흐름은 유지)
    if (isExtCallNode(id, n)) return 'infra:' + infraGroup(id);   // FEP·EDW 는 공유 인프라처럼 별도 그룹으로 분리 (infra:fep / infra:edw)
    if (n.project && !isInfra(id, n)) return 'svc:' + n.project;
  }
  return 'infra:' + infraGroup(id);   // 인프라/외부는 타입(kafka/redis/db/external/fep/edw) 단위로 합침
}
// 외부호출(externalService) 중 공유 인프라처럼 별도 노드 그룹으로 분리할 대상. 확장: 여기에 한 줄 추가하면 됨.
const EXT_GROUP = { FEP: 'fep', EDW: 'edw' };               // externalService 값 → 전용 그룹 타입
const EXT_TYPES = new Set(['external', ...Object.values(EXT_GROUP)]);   // ext 계열 타입(제공 서비스 컬럼에 배치)
const INFRA_LABEL = { kafka: 'Kafka 토픽', redis: 'Redis', db: 'DB 테이블', external: '외부 API', fep: 'FEP', edw: 'EDW', other: '기타' };
const INFRA_ICON = { kafka: '📨', redis: '🔴', db: '🗄️', external: '🌐', fep: '🏦', edw: '📊', other: '⬡' };

function buildServiceGraph() {
  const agg = new Map();   // key → { source, target, kc, count, async }
  for (const e of EDGES) {
    if (e.kind !== 's2s' && e.kind !== 'resource' && e.kind !== 'external' && e.kind !== 'join') continue;
    let ss = superId(e.source);
    const st = superId(e.target);
    // join 엣지: 외부호출 source 를 그 프론트 서비스로 귀속 (superId 는 ext 를 infra:external 로 보내므로 여기서 보정)
    //   → 화면→백엔드 엔드포인트 흐름은 유지하면서, 그 외 external 호출은 공유 '외부 API' 로 모아 가짜 연결을 막는다.
    if (e.kind === 'join') {
      const sn = nodeById.get(e.source);
      if (sn && sn.project && isExtCallNode(e.source, sn)) ss = 'svc:' + sn.project;
    }
    if (ss === st) continue;
    // 외부호출이 s2sService 로 해석돼 백엔드 서비스로 귀속된 경우(svc:… 타깃) server-to-server 로 표기.
    const tn = nodeById.get(e.target);
    const extResolved = e.kind === 'external' && tn && tn.s2sService && st.startsWith('svc:');
    const kc = e.kind === 's2s' || extResolved ? 's2s' : e.kind === 'join' ? 'join' : kindClass(e);
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

  const repo = state.overviewRepo;
  const bc = document.getElementById('breadcrumb');
  bc.style.display = 'flex';
  if (repo) {
    const n = repoServices(repo).length;
    bc.innerHTML = `<span class="bc-focus bc-link" id="ov-all-link" title="repo 한정 해제 — 전체 지도로">전체 서비스 지도</span>`
      + `<span class="bc-sep">›</span>`
      + `<span class="bc-focus">${svcBadge(repo, 'lg')}</span>`
      + `<span class="bc-sep">·</span>`
      + `<span class="ov-hint">sub-project <b>${n}</b>개(가운데) · 왼쪽 = 이 저장소를 `
      + `<b style="color:var(--e-s2s)">호출</b> · 오른쪽 = 이 저장소가 `
      + `<b style="color:var(--e-s2s)">호출</b></span>`;
    bc.querySelector('#ov-all-link').addEventListener('click', () => setOverview(true));
  } else {
    bc.innerHTML = `<span class="bc-focus">전체 서비스 지도</span>`
      + `<span class="bc-sep">·</span>`
      + `<span class="ov-hint"><b>화면</b> 진입 기준 — `
      + `<b style="color:var(--e-s2s)">s2s 호출</b> · <b style="color:var(--e-kafka)">이벤트/인프라</b> 의존, 카드 클릭 시 이동</span>`;
  }

  const edges = buildServiceGraph();

  // repo 한정 모드: 그 repo 의 sub-project(svc:*) + 직접 호출/피호출로 닿는 서비스/인프라만 노출.
  const repoOwn = repo ? new Set(repoServices(repo).map(s => 'svc:' + s)) : null;
  let repoVisible = null;
  if (repoOwn) {
    repoVisible = new Set(repoOwn);
    for (const e of edges) {
      if (repoOwn.has(e.source)) repoVisible.add(e.target);
      if (repoOwn.has(e.target)) repoVisible.add(e.source);
    }
  }

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
  colsEl.className = 'overview' + (repo ? ' repo-focus' : '');
  colsEl.innerHTML = '';

  // repo 한정은 그 저장소를 가운데(컴포넌트 단위로 분해) 두고 호출(좌)·피호출(우) 로 좌우 팬아웃.
  if (repo) {
    const { el: centerCol, shown, edges: cedges } = renderRepoFocus(repo, repoOwn, stats, infraMembers, colsEl);
    currentEdges = cedges.filter(e =>
      !e.source.startsWith('batch:') && shown.has(e.source) && shown.has(e.target));
    buildCurrentAdj();
    requestAnimationFrame(() => {
      pruneOrphans(); drawConnectors(); applyHighlight();
      centerCol?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
    });
    return;
  }

  // 화면(프론트) 진입 기준 전체 맵 — repo 한정 시 그 repo 연관 서비스/인프라만 노출.
  const shown = sup => (!repoVisible || repoVisible.has(sup));
  const head0 = '진입 / 화면';

  // 외부 API(+FEP·EDW) 는 "제공 서비스"(레벨 3) 컬럼에 함께 배치 — 제공 서비스가 비어 있어도 컬럼 생성
  //   ext 계열은 FEP·EDW 를 먼저, 일반 외부 API 를 마지막에 둔다.
  const extPresent = [...infraTypes].filter(t => EXT_TYPES.has(t))
    .sort((a, b) => (a === 'external' ? 1 : 0) - (b === 'external' ? 1 : 0) || a.localeCompare(b));
  const externalCol = extPresent.length ? 3 : -1;
  const lastCol = Math.max(maxLevel, externalCol);
  for (let lv = 0; lv <= lastCol; lv++) {
    const inLevel = svcs.filter(s => level.get(s) === lv && shown('svc:' + s)).sort((a, b) => stats[b].eps - stats[a].eps);
    const extHere = lv === externalCol ? extPresent.filter(t => shown('infra:' + t)) : [];
    if (!inLevel.length && !extHere.length) continue;
    const col = document.createElement('div');
    col.className = 'column';
    const head = document.createElement('div');
    head.className = 'column-head';
    head.textContent = lv === 0 ? head0 : (HEAD[lv] || `의존 ${lv}`);
    col.appendChild(head);
    // 전체보기 지도에서 서비스 카드 클릭 → 그 서비스(저장소)의 repo-focus 지도("전체 서비스 지도 › svc")로 진입
    for (const s of inLevel) { const mods = decomposeModulesOf(s); col.appendChild(mods ? makeServiceGroupCard(s, mods) : makeServiceCard(s, stats[s], () => setOverview(true, repoOf(s)))); }
    for (const t of extHere) col.appendChild(makeInfraTypeCard(t, (infraMembers[t] || new Set()).size));
    colsEl.appendChild(col);
  }
  // 공유 인프라 (kafka/redis/db/기타) — 외부는 제공 서비스 단계로 분리됨
  const sharedTypes = ['kafka', 'redis', 'db', 'other'].filter(t => infraTypes.has(t) && shown('infra:' + t));
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
  if (!colsEl.children.length) {
    colsEl.innerHTML = repo
      ? `<div class="browse-empty"><b>${esc(repo)}</b> 의 표시할 서비스가 없습니다.</div>`
      : `<div class="browse-empty">화면 진입점이 없습니다.</div>`;
  }

  // repo 한정: 그 repo 소유 서비스 카드를 테두리(저장소 색)로 묶어 표시.
  if (repoOwn) {
    const rh = serviceHue(repo);
    for (const sup of repoOwn) {
      const el = cardEls.get(sup);
      if (el) { el.classList.add('ov-repo-own'); el.style.setProperty('--repo-hue', rh); }
    }
  }

  // 화면 보기는 배치 진입 엣지를 숨긴다.
  //   repo 한정은 그 repo 를 한쪽 끝으로 갖는(호출/피호출) 엣지만 그린다.
  currentEdges = edges.filter(e => {
    if (e.source.startsWith('batch:')) return false;
    if (repoOwn) return (repoOwn.has(e.source) || repoOwn.has(e.target)) && repoVisible.has(e.source) && repoVisible.has(e.target);
    return true;
  });
  buildCurrentAdj();
  requestAnimationFrame(() => { pruneOrphans(); drawConnectors(); applyHighlight(); });
}

// 노드 → 컴포넌트 키 (백엔드 acgoXXXX 등). fqcn 의 .biz. 컴포넌트 우선, 없으면 Gradle module.
function compKeyOfNode(n) { return componentKeyOf(n) || (n.module && n.module !== 'src' ? n.module : null); }

// repo 포커스 레이아웃: 선택 저장소를 가운데 열에 "컴포넌트(예: acgo0001~acgoXXXX) 개별 노드"로 펼치고,
//   그 저장소를 호출하는 서비스는 왼쪽, 저장소가 호출하는 서비스/인프라는 오른쪽으로 좌우 팬아웃.
//   컴포넌트 사이 내부 호출(internal)·컴포넌트↔외부 서비스/인프라 호출을 모두 컴포넌트 단위 엣지로 그린다.
function renderRepoFocus(repo, repoOwn, stats, infraMembers, colsEl) {
  const centerSvcs = new Set(repoServices(repo));   // 가운데에 펼칠 서비스(보통 1개, 모노레포면 여러 개)
  // 가운데 서비스 노드는 컴포넌트 단위 super-id(comp:<svc>:<comp>), 그 외엔 일반 super-id.
  //   컴포넌트를 못 정하는(배치 진입 등) 노드는 서비스 단위(svc:<svc>)로 폴백.
  const csuper = id => {
    const n = nodeById.get(id);
    if (n && n.project && centerSvcs.has(n.project) && !isInfra(id, n) && !isExtCallNode(id, n) && n.layer !== 'BATCH') {
      const ck = compKeyOfNode(n);
      return ck ? 'comp:' + n.project + ':' + ck : 'svc:' + n.project;
    }
    return superId(id);
  };

  // 가운데 컴포넌트 노드 목록 + 통계 (endpoints / nodes)
  const compStat = new Map();   // sup → { svc, ck, eps, nodes }
  for (const n of NODES) {
    if (!centerSvcs.has(n.project) || isInfra(n.id, n) || isExtCallNode(n.id, n) || n.layer === 'BATCH') continue;
    const ck = compKeyOfNode(n);
    const sup = ck ? 'comp:' + n.project + ':' + ck : 'svc:' + n.project;
    const t = compStat.get(sup) || compStat.set(sup, { svc: n.project, ck: ck || n.project, eps: 0, nodes: 0 }).get(sup);
    t.nodes++; if (n.layer === 'CONTROLLER' && n.endpoint) t.eps++;
  }
  const centerSet = new Set(compStat.keys());

  // 컴포넌트 단위 엣지 집계 — 가운데에 닿는 엣지만(내부 호출은 컴포넌트↔컴포넌트만).
  const agg = new Map();
  for (const e of EDGES) {
    if (e.kind !== 's2s' && e.kind !== 'resource' && e.kind !== 'external' && e.kind !== 'join' && e.kind !== 'internal') continue;
    let ss = csuper(e.source); const st = csuper(e.target);
    if (e.kind === 'join') {                          // 프론트 외부호출 source 를 그 프론트 서비스로 귀속
      const sn = nodeById.get(e.source);
      if (sn && sn.project && isExtCallNode(e.source, sn)) ss = 'svc:' + sn.project;
    }
    if (ss === st || ss.startsWith('batch:')) continue;
    const sC = ss.startsWith('comp:'), tC = st.startsWith('comp:');
    if (!sC && !tC) continue;                         // 가운데와 무관한 엣지 제외
    if (e.kind === 'internal' && !(sC && tC)) continue;   // 내부 호출은 컴포넌트↔컴포넌트만
    const tn = nodeById.get(e.target);
    const extResolved = e.kind === 'external' && tn && tn.s2sService && st.startsWith('svc:');
    const kc = e.kind === 's2s' || extResolved ? 's2s' : e.kind === 'join' ? 'join' : e.kind === 'internal' ? 'internal' : kindClass(e);
    const key = ss + '|' + st + '|' + kc;
    let a = agg.get(key);
    if (!a) { a = { source: ss, target: st, kc, count: 0 }; agg.set(key, a); }
    a.count++;
  }
  const cedges = [...agg.values()];

  // 좌(가운데를 호출) / 우(가운데가 호출) 분류 — 양쪽이면 더 강한 방향(동률 → 좌).
  const inCnt = new Map(), outCnt = new Map();
  for (const e of cedges) {
    const sC = centerSet.has(e.source), tC = centerSet.has(e.target);
    if (tC && !sC) inCnt.set(e.source, (inCnt.get(e.source) || 0) + e.count);
    if (sC && !tC) outCnt.set(e.target, (outCnt.get(e.target) || 0) + e.count);
  }
  const left = new Set(), right = new Set();
  for (const sup of new Set([...inCnt.keys(), ...outCnt.keys()]))
    ((inCnt.get(sup) || 0) >= (outCnt.get(sup) || 0) ? left : right).add(sup);

  const cardFor = sup => {
    if (sup.startsWith('svc:')) { const s = sup.slice(4); return stats[s] ? makeServiceCard(s, stats[s]) : null; }
    if (sup.startsWith('infra:')) { const t = sup.slice(6); return makeInfraTypeCard(t, (infraMembers[t] || new Set()).size); }
    return null;
  };
  const mkCol = (cls, headHtml, sups, cntMap) => {
    const col = document.createElement('div');
    col.className = 'column ' + cls;
    const head = document.createElement('div');
    head.className = 'column-head';
    head.innerHTML = headHtml;
    col.appendChild(head);
    for (const sup of [...sups].sort((a, b) => (cntMap.get(b) || 0) - (cntMap.get(a) || 0))) {
      const c = cardFor(sup); if (c) col.appendChild(c);
    }
    return col;
  };

  // 왼쪽 = 이 저장소를 호출하는 서비스
  if (left.size) colsEl.appendChild(mkCol('repo-callers', '이 저장소를 <b style="color:var(--e-s2s)">호출</b> →', left, inCnt));

  // 가운데 = 저장소 컴포넌트 개별 노드. 저장소 색 테두리로 강조.
  const rh = serviceHue(repo);
  const multi = centerSvcs.size > 1;
  const center = document.createElement('div');
  center.className = 'column repo-center';
  center.style.setProperty('--repo-hue', rh);
  const chead = document.createElement('div');
  chead.className = 'column-head repo-center-head';
  chead.innerHTML = svcBadge(repo, 'lg');
  center.appendChild(chead);
  const centerSups = [...compStat.keys()].sort((a, b) => {
    const A = compStat.get(a), B = compStat.get(b);
    return A.svc.localeCompare(B.svc) || A.ck.localeCompare(B.ck, undefined, { numeric: true });
  });
  for (const sup of centerSups) {
    const info = compStat.get(sup);
    const card = sup.startsWith('comp:') ? makeComponentCard(sup, info, multi) : makeServiceCard(info.svc, stats[info.svc]);
    card.classList.add('ov-repo-own');
    card.style.setProperty('--repo-hue', rh);
    center.appendChild(card);
  }
  colsEl.appendChild(center);

  // 오른쪽 = 저장소가 호출하는 서비스/인프라
  if (right.size) colsEl.appendChild(mkCol('repo-callees', '→ 이 저장소가 <b style="color:var(--e-s2s)">호출</b>', right, outCnt));

  return { el: center, shown: new Set([...centerSet, ...left, ...right]), edges: cedges };
}

// repo 포커스 가운데 컴포넌트(acgoXXXX 등) 카드 — 클릭하면 그 컴포넌트 경로 드릴(프로세스 흐름)로 이동.
function makeComponentCard(sup, info, showSvc) {
  const card = document.createElement('div');
  card.className = 'node-card ov-svc ov-comp' + (sup === state.sel ? ' sel' : '');
  card.dataset.node = sup;
  card.innerHTML = `<div class="ov-svc-name"><span class="ov-comp-key">${esc(info.ck)}</span>${ovTag('컴포넌트', 'cmp')}</div>`
    + `<div class="ov-svc-sub">${showSvc ? esc(info.svc) + ' · ' : ''}${info.eps} endpoints · ${info.nodes} nodes</div>`;
  card.addEventListener('click', () => info.eps ? setSvcPath(info.svc, info.ck) : setService(info.svc));
  card.addEventListener('mouseenter', () => alignNeighbors(sup));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set(sup, card);
  return card;
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
// kakaopay 비즈 컴포넌트 키 — FQCN 의 `.biz.` 직전 패키지 세그먼트.
//   com.kakaopay.moneyball.ac.acgo0001.biz.PACU0001 → "acgo0001"
//   com.kakaopay.moneyball.bc.bcgo3000.biz.PBCU3000 → "bcgo3000"
// 이 패턴(<영문>+<숫자>.biz)이 없는 서비스(terafunding·프론트 등)는 null → 경로 그룹으로 폴백.
function componentKeyOf(node) {
  const m = node && node.fqcn && node.fqcn.match(/\.([a-z]+\d+)\.biz\./i);
  return m ? m[1] : null;
}
function pathKeyOf(node) {
  const comp = componentKeyOf(node);   // 컴포넌트(acgoXXXX) 단위 그룹 우선
  if (comp) return comp;
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
    + svcBadge(svc, 'lg')
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
    + `<a class="bc-link" id="bc-svc">${svcBadge(svc)}</a>`
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
const INFRA_CLS = { kafka: 'nc-r-kafka-topic', redis: 'nc-r-redis', db: 'nc-r-db-table', external: 'nc-l-external', fep: 'nc-l-fep', edw: 'nc-l-edw', other: 'nc-l-other' };
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
    + `<a class="bc-link" id="bc-svc">${svcBadge(svc)}</a>`
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

// 서비스명 → 고정 색상(hue). 등록 서비스(META.projects)는 정렬 인덱스에 황금각(137.5°)으로 hue 를
//   분배해 인접/유사 이름(예 sample-shop·sample-shop-react)도 서로 충분히 다른 색이 되게 한다.
//   미등록 이름(repo명·인프라 등)은 FNV-1a 해시로 흩뿌린다. 모든 뷰가 FM.serviceHue 로 같은 색을 쓴다.
let _hueByName = null;
function hueIndex() {
  if (_hueByName) return _hueByName;
  _hueByName = new Map();
  (META.projects || []).slice().sort().forEach((name, i) => _hueByName.set(name, Math.round((i * 137.508) % 360)));
  return _hueByName;
}
function hashHue(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}
function serviceHue(name) {
  const idx = hueIndex();
  return idx.has(name) ? idx.get(name) : hashHue(name);
}

// 서비스명 뱃지 — 커밋영향도(.imp-proj)와 동일 형태. 색은 serviceHue 로 인라인 지정.
//   cls: 'lg' 면 카드 제목용 큰 사이즈.
function svcBadge(name, cls) {
  return `<span class="svc-tag${cls ? ' ' + cls : ''}" title="${escAttr(name)}" `
    + `style="--svc-h:${serviceHue(name)}">${esc(name)}</span>`;
}

// 전체보기/하위 카드 타입 뱃지 — 화면/서비스/배치/외부/인프라
function ovTag(label, cls) { return `<span class="ov-tag t-${cls}">${label}</span>`; }
function isFrontendProject(svc) { return (MANIFEST?.projects || []).some(p => p.type === 'frontend' && p.name === svc); }

function makeServiceCard(svc, st, onClick) {
  const card = document.createElement('div');
  card.className = 'node-card ov-svc' + (('svc:' + svc) === state.sel ? ' sel' : '');
  card.dataset.node = 'svc:' + svc;
  const hue = serviceHue(svc);
  card.style.borderLeftColor = `hsl(${hue} 60% 50%)`;
  const tag = isFrontendProject(svc) ? ovTag('화면', 'scr') : ovTag('서비스', 'svc');
  card.innerHTML = `<div class="ov-svc-name">${svcBadge(svc, 'lg')}${tag}</div>`
    + `<div class="ov-svc-sub">${st.eps} endpoints · ${st.nodes} nodes</div>`;
  card.addEventListener('click', onClick || (() => setService(svc)));
  card.addEventListener('mouseenter', () => alignNeighbors('svc:' + svc));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set('svc:' + svc, card);
  return card;
}

// wallga 모노레포 sub-project 판별: manifest 의 repo(=gitRepo 모노레포명)가 있고 프로젝트명과 다르면
//   해당 프로젝트는 모노레포(예: tera-terafi)의 sub-project → 분해 대상. (standalone 은 repo===name 또는 null)
function monorepoOf(svc) {
  const p = (MANIFEST?.projects || []).find(x => x.name === svc);
  return p && p.repo && p.repo !== svc ? p.repo : null;
}
// 서비스(project) → 소속 main project. manifest repo(모노레포명)가 있으면 그 repo, 없으면(standalone)
//   프로젝트 자기 이름이 곧 main project. → nexcore/tera-terafi 는 묶이고, 샘플은 각자 1개로 노출.
function repoOf(svc) {
  const p = (MANIFEST?.projects || []).find(x => x.name === svc);
  return (p && p.repo) || svc;
}
// 전체보기 아래 하위 메뉴 대상 = 모든 main project(모노레포는 1개로 묶고, standalone 은 각자 1개).
let _repoList = null;
function repoList() {
  if (_repoList) return _repoList;
  const repos = new Set((META.projects || []).map(repoOf));
  _repoList = [...repos].sort();
  return _repoList;
}
function repoServices(repo) { return (META.projects || []).filter(s => repoOf(s) === repo); }

// 전체보기 아래 main project 별 하위 메뉴 버튼을 데이터 기반으로 1회 생성
function renderRepoSubs() {
  const host = document.getElementById('repo-subs');
  if (!host) return;
  const repos = repoList();
  host.innerHTML = '';
  if (!repos.length) { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  for (const r of repos) {
    const n = repoServices(r).length;
    const b = document.createElement('button');
    b.className = 'nav-btn nav-sub nav-sub-repo';
    b.dataset.repo = r;
    b.title = `${r} 관련 서비스만 — sub-project ${n}개 + 직접 호출/피호출 서비스`;
    b.style.setProperty('--repo-hue', serviceHue(r));
    b.innerHTML = `<span class="nb-label">${svcBadge(r)}</span><span class="nb-cnt">${n}</span>`;
    b.addEventListener('click', () => setOverview(true, r));
    host.appendChild(b);
  }
}
// wallga 모노레포 sub-project 를 Gradle 모듈 단위로 분해. 모듈(=node.module, src 제외) 2개 이상일 때만.
//   모듈 없는(src/null) 노드는 '(기타)' 카드로 모은다. 분해 대상 아니면 null.
function decomposeModulesOf(svc) {
  if (isFrontendProject(svc) || !monorepoOf(svc)) return null;
  const byMod = new Map();
  const other = { module: svc + ' (기타)', eps: 0, nodes: 0, other: true };
  for (const n of NODES) {
    if (n.project !== svc) continue;
    const m = (n.module && n.module !== 'src') ? n.module : null;
    const t = m ? (byMod.get(m) || byMod.set(m, { module: m, eps: 0, nodes: 0 }).get(m)) : other;
    t.nodes++;
    if (n.layer === 'CONTROLLER' && n.endpoint) t.eps++;
  }
  if (byMod.size < 2) return null;
  const mods = [...byMod.values()].sort((a, b) => b.nodes - a.nodes);
  if (other.nodes) mods.push(other);
  return mods;
}

// 분해 대상 프로젝트: 모듈 카드들을 래퍼(=svc:<project>, 엣지 앵커)로 묶어 한 티어 슬롯에 배치.
//   래퍼만 cardEls 에 등록 → 기존 서비스 엣지/하이라이트/정리(dim·orphan)가 그대로 동작.
function makeServiceGroupCard(svc, mods) {
  const wrap = document.createElement('div');
  wrap.className = 'ov-svc-group' + (('svc:' + svc) === state.sel ? ' sel' : '');
  wrap.dataset.node = 'svc:' + svc;
  const hue = serviceHue(svc);
  wrap.style.setProperty('--svc-hue', hue);
  const head = document.createElement('div');
  head.className = 'ovg-head';
  head.innerHTML = svcBadge(svc, 'lg')
    + `<span class="ovg-tag">${monorepoOf(svc) ? esc(monorepoOf(svc)) + ' · ' : ''}${mods.length}모듈</span>`;
  wrap.appendChild(head);
  for (const md of mods) {
    const c = document.createElement('div');
    c.className = 'node-card ov-svc ovg-modcard' + (md.other ? ' other' : '');
    c.style.borderLeftColor = `hsl(${hue} 60% 50%)`;
    c.innerHTML = `<div class="ov-svc-name">${esc(md.module)}</div>`
      + `<div class="ov-svc-sub">${md.eps} endpoints · ${md.nodes} nodes</div>`;
    c.addEventListener('click', () => setOverview(true, repoOf(svc)));   // 전체보기 → repo-focus 지도
    c.addEventListener('mouseenter', () => alignNeighbors('svc:' + svc));
    c.addEventListener('mouseleave', () => clearAlign());
    wrap.appendChild(c);
  }
  cardEls.set('svc:' + svc, wrap);
  return wrap;
}

// 서비스 보기 단계 컬럼: 외부/인프라 버킷을 전체보기처럼 단일 카드로 축약 (id = 버킷 key, 엣지 타깃과 일치)
function makeStepBucketCard(bkt) {
  const type = bkt.key.startsWith('ext:') ? 'external' : (bkt.key.split(':')[1] || 'other');
  const card = document.createElement('div');
  card.className = `node-card ov-infra ${INFRA_CLS[type] || 'nc-l-other'}` + (bkt.key === state.sel ? ' sel' : '');
  card.dataset.node = bkt.key;
  const n = bkt.members.size;
  const isExt = EXT_TYPES.has(type);
  const tag = isExt ? ovTag('외부 API', 'ext') : ovTag('인프라', 'infra');
  card.innerHTML = `<div class="ov-svc-name">${esc(bkt.label)}${tag}</div>`
    + `<div class="ov-svc-sub">${n} ${isExt ? 'endpoints' : 'nodes'}</div>`;
  card.addEventListener('mouseenter', () => alignNeighbors(bkt.key));
  card.addEventListener('mouseleave', () => clearAlign());
  cardEls.set(bkt.key, card);
  return card;
}

function infraGroup(id) {
  const n = nodeById.get(id);
  if (n) {
    if (isExtCallNode(id, n)) return EXT_GROUP[n.externalService] || 'external';   // FEP·EDW 는 전용 그룹, 그 외 외부호출은 external
    if (n.resourceType === 'kafka-topic') return 'kafka';
    if (n.resourceType === 'db-table') return 'db';
    if (n.resourceType === 'redis') return 'redis';
  }
  if (/^kafka:/.test(id)) return 'kafka';
  if (/^db:/.test(id)) return 'db';
  if (/redis/.test(id)) return 'redis';
  if (/^ext:/.test(id)) return EXT_GROUP[(id.split(':')[1] || '').split(/[#/ ]/)[0]] || 'external';   // ext:FEP#... → fep
  return 'other';
}

// 전체보기: 인프라/외부 타입을 하나의 노드로 표현
function makeInfraTypeCard(type, count) {
  const sup = 'infra:' + type;
  const card = document.createElement('div');
  card.className = `node-card ov-infra ${INFRA_CLS[type] || 'nc-l-other'}` + (sup === state.sel ? ' sel' : '');
  card.dataset.node = sup;
  const isExt = EXT_TYPES.has(type);
  const tag = isExt ? ovTag('외부 API', 'ext') : ovTag('인프라', 'infra');
  card.innerHTML = `<div class="ov-svc-name"><span class="nc-icon">${INFRA_ICON[type]}</span> ${esc(INFRA_LABEL[type])}${tag}</div>`
    + `<div class="ov-svc-sub">${count} ${isExt ? 'endpoints' : 'nodes'}</div>`;
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
    + `<a class="bc-link" id="bc-svc">${svcBadge(state.fromService)}</a>`
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
    const wStyle = e.count ? ` style="stroke-width:${Math.min(3.5, 0.9 + e.count * 0.35).toFixed(2)}"` : '';
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
  // repo 한정 전체보기: 그 repo 소유 카드는 고립이어도 목록에 남긴다(sub-project 전체 표시).
  for (const [id, el] of cardEls) el.classList.toggle('orphan-hidden', !connected.has(id) && !el.classList.contains('ov-repo-own'));
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
  // 서비스 보기의 정적 세로 정렬(svcAlignBy)은 hover 해제 후에도 유지 — 0 으로 지우지 않고 그 값으로 복원.
  const inSvc = document.getElementById('columns').classList.contains('svc-view');
  for (const [id, el] of cardEls) {
    const base = inSvc ? svcAlignBy.get(id) : 0;
    if (base) { el.style.transform = `translateY(${base}px)`; el.classList.remove('aligning', 'card-lift'); }
    else if (el.style.transform) { el.style.transform = ''; el.classList.remove('aligning', 'card-lift'); }
  }
}
// 서비스 보기 정적 세로 정렬 — 각 호출/피호출 카드를 자신이 연결된 기준(인접 컬럼) 카드의 높이에 맞춰
//   세로로 내려, 연결선이 수평에 가깝게 그려지도록 한다. base 컬럼은 자연 위치 유지, 바깥 링부터 차례로 정렬.
//   (겹침은 desired 중심 정렬 후 아래로 패킹해 방지. 위로는 base top 아래로 못 올라가게 floor 고정 → margin 없이 transform 만.)
function alignServiceColumns() {
  svcAlignBy = new Map();
  const colsEl = document.getElementById('columns');
  if (!colsEl || !colsEl.classList.contains('svc-view')) return;
  const cols = [...colsEl.querySelectorAll('.column')];
  const baseIdx = cols.findIndex(c => c.classList.contains('svc-base'));
  if (baseIdx < 0) return;
  const z = state.zoom || 1, GAP = 12;
  for (const c of cols) for (const el of c.querySelectorAll('.node-card')) el.style.transform = '';   // 재계산 전 초기화
  const colCards = cols.map(c => [...c.querySelectorAll('.node-card')].filter(el => el.offsetParent));
  // 무방향 인접 (현재 보이는 엣지 기준)
  const nb = new Map();
  const add = (a, b) => { if (!nb.has(a)) nb.set(a, new Set()); nb.get(a).add(b); };
  for (const e of currentEdges) { add(e.source, e.target); add(e.target, e.source); }
  // 자연(transform 0 가정) 스크린 좌표
  const natTop = el => el.getBoundingClientRect().top;
  const natCenter = el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  const baseCards = colCards[baseIdx];
  if (!baseCards.length) return;
  const floor = natTop(baseCards[0]);
  const targetCenter = new Map();   // el id → 정렬 후 스크린 center (다음 링의 anchor)
  for (const el of baseCards) targetCenter.set(el.dataset.node, natCenter(el));
  const place = (cards, anchorCards) => {
    if (!cards.length) return;
    const anchorIds = new Set(anchorCards.map(a => a.dataset.node));
    const items = cards.map(el => {
      const r = el.getBoundingClientRect();
      const ns = [...(nb.get(el.dataset.node) || [])].filter(id => anchorIds.has(id) && targetCenter.has(id)).map(id => targetCenter.get(id));
      const desired = ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : natCenter(el);
      return { el, h: r.height, nat: r.top, desired };
    });
    items.sort((a, b) => a.desired - b.desired);
    let prevBottom = -Infinity;
    for (const it of items) {
      let top = it.desired - it.h / 2;
      if (top < floor) top = floor;
      if (top < prevBottom + GAP * z) top = prevBottom + GAP * z;
      const ty = (top - it.nat) / z;
      if (ty > 0.5) { it.el.style.transform = `translateY(${ty.toFixed(1)}px)`; svcAlignBy.set(it.el.dataset.node, +ty.toFixed(1)); }
      targetCenter.set(it.el.dataset.node, top + it.h / 2);
      prevBottom = top + it.h;
    }
  };
  for (let i = baseIdx + 1; i < cols.length; i++) place(colCards[i], colCards[i - 1]);   // 호출(오른쪽): 안쪽→바깥
  for (let i = baseIdx - 1; i >= 0; i--) place(colCards[i], colCards[i + 1]);             // 피호출(왼쪽): 안쪽→바깥
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
  const collapsed = document.body.classList.contains('detail-collapsed');
  const visible = show && !collapsed;
  const toggled = el.classList.contains('hidden') === visible;
  el.classList.toggle('hidden', !visible);
  document.getElementById('detail-resizer').classList.toggle('hidden', !visible);
  document.getElementById('detail-collapse').classList.toggle('hidden', !visible);
  document.getElementById('detail-reopen').classList.toggle('hidden', !(show && collapsed));   // 접힘 + 표시할 내용 있을 때만 리오픈 탭
  document.getElementById('layout').style.setProperty('--detail-w', visible ? (el.getBoundingClientRect().width || 340) + 'px' : '0px');
  if (toggled && currentEdges.length) requestAnimationFrame(drawConnectors);   // 패널 표시 여부 변경 → 캔버스 폭 변동
  if (!visible) { if (!show) el.innerHTML = ''; return; }
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
// ── 통합 검색: 카테고리 메타 ───────────────────────────────────────
const CAT_ORDER = ['menu', 'node', 'service', 'screen', 'pr'];
const CAT_LABEL = { menu: '메뉴', node: 'API/노드', service: '서비스·인프라', screen: '화면', pr: 'PR·배포' };
const CAT_LIMIT = 12;            // 카테고리당 상한 (menu 제외)

// 메뉴(뷰 바로가기) — 정적. kw: 매칭 키워드(별칭 포함). act: navigateSearchItem 액션
const SEARCH_MENUS = [
  { ico: '🗺️', label: '전체보기', kw: '전체보기 화면 overview screen 지도 map 홈 home', act: { t: 'overview' } },
  { ico: '🧾', label: '커밋 영향도', kw: '커밋 영향도 commit impact pr git', act: { t: 'view', view: 'commits' } },
  { ico: '🚀', label: '배포 영향도', kw: '배포 영향도 deploy release 릴리즈', act: { t: 'view', view: 'deploy' } },
  { ico: '📖', label: 'API 문서', kw: 'api 문서 openapi swagger docs', act: { t: 'view', view: 'api' } },
  { ico: '🏗️', label: '어플리케이션구조', kw: '어플리케이션 구조 structure application app', act: { t: 'structure' } },
];

// PR/배포 검색 인덱스 — data/deploy/* 는 지연 로드라 첫 검색 시 1회 채움
let PR_SEARCH = null;            // null=미로드, []=로드완료(빈 결과 포함)
let prSearchLoading = null;
function ensurePrSearchIndex() {
  if (PR_SEARCH) return Promise.resolve(PR_SEARCH);
  if (prSearchLoading) return prSearchLoading;
  const BASE = 'data/deploy/';
  prSearchLoading = fetchData(BASE + 'pr_index.json').then(async pidx => {
    const out = [];
    for (const e of (pidx && pidx.entries) || []) {
      if (!e.file) continue;
      let day; try { day = await fetchData(BASE + e.file); } catch { continue; }
      for (const tk of (day && day.by_ticket) || []) {
        const tkId = String(tk.release_ticket_id);
        const summary = tk.summary || '';
        for (const p of tk.prs || []) {
          out.push({
            date: e.date, ticketId: tkId, summary,
            number: p.number, title: p.title || '',
            user: typeof p.user === 'string' ? p.user : (p.user && p.user.login) || '',
            html_url: p.html_url || '',
          });
        }
      }
    }
    PR_SEARCH = out; return out;
  }).catch(() => (PR_SEARCH = []));
  return prSearchLoading;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// 5개 카테고리(메뉴/노드/서비스·인프라/화면/PR)를 한 번에 수집
function collectSearchHits(q) {
  const g = { menu: [], node: [], service: [], screen: [], pr: [] };
  // (E) 메뉴
  for (const m of SEARCH_MENUS)
    if (m.label.toLowerCase().includes(q) || m.kw.toLowerCase().includes(q))
      g.menu.push({ cat: 'menu', title: m.label, sub: '바로가기', proj: null, badge: { kind: 'icon', ico: m.ico }, act: m.act });
  // (A) API/노드  +  (C) 화면(SCREEN 분리)
  for (const n of NODES) {
    if (!matches(q, n.method, n.fqcn, n.id, n.endpoint, n.description)) continue;
    if (n.layer === 'SCREEN') {
      if (g.screen.length < CAT_LIMIT)
        g.screen.push({ cat: 'screen', title: n.method || n.id, sub: n.endpoint || shortClass(n.fqcn || n.id), proj: n.project || null,
          badge: { kind: 'layer', color: layerColor(n) }, act: { t: 'focus', id: n.id } });
    } else if (g.node.length < CAT_LIMIT) {
      const sub = (n.layer === 'CONTROLLER' && n.endpoint) ? n.endpoint : shortClass(n.fqcn || n.id);
      const badge = (n.layer === 'CONTROLLER' && n.httpMethod)
        ? { kind: 'http', method: n.httpMethod } : { kind: 'layer', color: layerColor(n) };
      g.node.push({ cat: 'node', title: n.method || n.id, sub, proj: n.project || null, badge, act: { t: 'focus', id: n.id } });
    }
  }
  // (B) 서비스 (META.projects = 문자열 배열) + 인프라 타입 5종
  for (const svc of (META.projects || []))
    if (svc.toLowerCase().includes(q) && g.service.length < CAT_LIMIT)
      g.service.push({ cat: 'service', title: svc, sub: '서비스 보기', proj: null, badge: { kind: 'icon', ico: '🧩' }, act: { t: 'service', svc } });
  for (const [type, label] of Object.entries(INFRA_LABEL))
    if ((label.toLowerCase().includes(q) || type.includes(q)) && g.service.length < CAT_LIMIT)
      g.service.push({ cat: 'service', title: label, sub: '인프라 보기', proj: null, badge: { kind: 'icon', ico: INFRA_ICON[type] || '📦' }, act: { t: 'infra', type } });
  // (D) PR/배포 (PR_SEARCH 가 채워졌을 때만)
  for (const p of (PR_SEARCH || [])) {
    if (g.pr.length >= CAT_LIMIT) break;
    if (!matches(q, p.title, '#' + p.number, String(p.number), p.user, p.summary, p.ticketId)) continue;
    g.pr.push({ cat: 'pr', title: '#' + p.number + ' ' + p.title, sub: p.date + ' · ' + p.summary,
      proj: p.user || null, badge: { kind: 'icon', ico: '🔀' },
      act: { t: 'pr', d: p.date, tk: p.ticketId, pr: String(p.number), url: p.html_url } });
  }
  return g;
}

function searchBadgeHtml(b) {
  if (b.kind === 'http')  return `<span class="nc-badge http ${methodClass(b.method)} si-mb">${esc(b.method)}</span>`;
  if (b.kind === 'layer') return `<span class="legend-swatch si-mb" style="background:${b.color}"></span>`;
  return `<span class="si-ico si-mb">${esc(b.ico)}</span>`;
}

function renderSearchResults(grouped, q) {
  const box = document.getElementById('search-results');
  let html = '';
  for (const cat of CAT_ORDER) {
    const hits = grouped[cat];
    if (!hits.length) continue;
    html += `<div class="search-group"><div class="search-group-head">${esc(CAT_LABEL[cat])}</div>`;
    for (const h of hits) {
      html += `<div class="search-item" tabindex="-1" data-act='${escAttr(JSON.stringify(h.act))}'>`
        + searchBadgeHtml(h.badge)
        + `<span class="si-text"><span class="si-title">${markHit(h.title, q)}</span>`
        + (h.sub ? `<span class="si-sub">${markHit(h.sub, q)}</span>` : '')
        + `</span>`
        + (h.proj ? `<span class="si-proj">${esc(h.proj)}</span>` : '')
        + `</div>`;
    }
    html += `</div>`;
  }
  // PR 인덱스가 아직 로딩 중이면 안내 행
  if (PR_SEARCH == null) html += '<div class="search-empty search-loading">PR·배포 불러오는 중…</div>';
  box.innerHTML = html || '<div class="search-empty">일치하는 결과 없음</div>';
  box.classList.remove('hidden');
}

function runSearch(q) {
  const box = document.getElementById('search-results');
  q = (q || '').trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); return; }
  // PR 인덱스 비동기 1회 로드 → 도착 시 (입력이 그대로면) 재렌더 (seq 가드)
  if (PR_SEARCH == null) ensurePrSearchIndex().then(() => {
    const cur = document.getElementById('search').value.trim().toLowerCase();
    if (cur === q && !box.classList.contains('hidden')) renderSearchResults(collectSearchHits(q), q);
  });
  renderSearchResults(collectSearchHits(q), q);
}

function closeSearch() {
  const box = document.getElementById('search-results');
  document.getElementById('search').value = '';
  box.classList.add('hidden');
}

function navigateSearchItem(el) {
  let a; try { a = JSON.parse(el.dataset.act); } catch { return; }
  switch (a.t) {
    case 'focus':     if (!nodeById.has(a.id)) return; setFocus(a.id, null); break;
    case 'service':   setService(a.svc); break;
    case 'infra':     setInfraType(a.type); break;
    case 'overview':  setOverview(true); break;
    case 'structure': setStructure(true); break;
    case 'view':      openView(a.view); break;
    case 'pr':        openView('deploy', { y: (a.d || '').slice(0, 4), m: (a.d || '').slice(5, 7), d: a.d, t: a.tk, pr: a.pr }); break;
    default:          return;
  }
  closeSearch();
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
  const _runSearch = debounce(runSearch, 120);
  search.addEventListener('input', e => _runSearch(e.target.value));
  search.addEventListener('focus', e => { if (e.target.value) runSearch(e.target.value); });
  document.getElementById('search-results').addEventListener('click', e => {
    const it = e.target.closest('.search-item');
    if (it) navigateSearchItem(it);
  });
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
  renderRepoSubs();
  document.getElementById('structure-btn').addEventListener('click', () => setStructure(true));
  document.querySelectorAll('#nav .nav-btn[data-view]').forEach(b =>
    b.addEventListener('click', () => openView(b.dataset.view, b.dataset.st ? { st: b.dataset.st } : undefined)));
  setupDetailResizer();
  setupSidebar();
  setupDetailCollapse();
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
  renderLegend();
}

// ---- 범례 (선=호출 종류) — 색은 실제 CSS 변수(--e-*)에서 읽어 항상 일치. 사이드바 하단에 표시 ----
const EDGE_LEGEND = [
  ['s2s', '서비스 간 호출 (s2s)'], ['internal', '서비스 내부 호출'],
  ['external', '외부 API 호출'], ['join', '화면 ↔ 백엔드 API'],
  ['db', 'DB 액세스'], ['redis', 'Redis'], ['kafka', 'Kafka 이벤트'], ['batch', '배치'],
];
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function renderLegend() {
  const body = document.getElementById('sidebar-legend');
  if (!body) return;
  const lineRow = ([kc, label], dash) =>
    `<div class="lg-row"><span class="lg-line${dash ? ' dash' : ''}" style="--lc:${cssVar('--e-' + kc) || '#94a3b8'}"></span><span class="lg-label">${label}</span></div>`;
  body.innerHTML =
    `<div class="lg-sec"><div class="lg-h">선 — 호출 종류</div>${EDGE_LEGEND.map(e => lineRow(e)).join('')}</div>`
    + `<div class="lg-sec"><div class="lg-h">선 — 형태</div>`
    + `<div class="lg-row"><span class="lg-line"></span><span class="lg-label">실선 = 동기(sync)</span></div>`
    + `<div class="lg-row"><span class="lg-line dash"></span><span class="lg-label">점선 = 비동기(async)</span></div>`
    + `<div class="lg-row"><span class="lg-line thick"></span><span class="lg-label">굵을수록 호출 수 많음</span></div></div>`;
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
        if (it) navigateSearchItem(it);
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
const FEATURE_VER = '77';                      // 기능 모듈 캐시 버스팅
const FEATURE_OF_VIEW = { commits: 'impact', topic: 'topic', api: 'apidoc', deploy: 'deploy' };
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
  dockChangedNodes = new Set();
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
  serviceHue, svcBadge,
  copyToClipboard, shareUrl, matches, markHit,
  // 렌더 빌딩블록 (카드/컬럼/그룹박스/BFS)
  makeCard, mkHead, appendGroupBox, renderGroupedBoxes, computeColumns,
  // 캔버스 — setCanvasEdges(edges) 후 requestAnimationFrame(drawConnectors)
  setCanvasEdges(edges) { currentEdges = edges; buildCurrentAdj(); },
  drawConnectors, pruneOrphans, applyHighlight,
  // 네비게이션 / 상태
  setFocus, setService, setOverview, setStructure, setStructSvc, setStructPath, setStructFile, setSel, setInfraType, clearFocus,
  // 하단 프로세스 독 — 기능 뷰에서 state.sel 기준으로 표시 (on=true 후 setSel 로 base 지정)
  setProcessDockEnabled(on) { dockFeature = !!on; if (!on) dockChangedNodes = new Set(); renderProcessDock(); },
  // 프로세스 독에서 강조할 "실제 수정된 메서드" id 집합 지정 (기능 뷰 전용)
  setDockChangedNodes(ids) { dockChangedNodes = ids instanceof Set ? ids : new Set(ids || []); renderProcessDock(); },
  openView, pushViewUrl, param: urlParamOf, renderDetail,
  // 모듈 등록 / 데이터 로드
  registerView(view, mod) { featureViews.set(view, mod); },
  registerDetailExtension(fn) { detailExtensions.push(fn); },
  loadFeature, fetchData,
};

boot();
