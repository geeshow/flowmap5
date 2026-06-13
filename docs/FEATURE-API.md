# flowmap 기능 모듈 계약 (FEATURE-API)

기능 모듈은 `web/features/<이름>.js` + `web/features/<이름>.css` 한 쌍이다.
**메뉴 진입 시에만** 코어가 js/css를 동적으로 주입한다(lazy load). 모듈은 코어 파일(app.js 등)을 수정하지 않는다.

## 등록된 모듈

| 모듈 | 뷰(view=) | 데이터 | 진입점 |
|---|---|---|---|
| `impact` | `commits` | `data/impact.json` (없을 수 있음 → 빈 상태) | 헤더 nav `🧾 커밋 영향도` |
| `topic` | `topic` | graph.json (이미 로드됨) | kafka 노드/배지에서 진입 |
| `apidoc` | `api` | `data/openapi.json` | 헤더 nav `📖 API 문서` + 상세 패널 `📄 API 문서` 버튼 |

## 모듈 골격

```js
(() => {
  'use strict';
  const FM = window.Flowmap;

  FM.registerView('commits', {
    render() { /* #columns 등에 화면 렌더 (아래 "화면 표면" 참조) */ },
    escape() { FM.setOverview(true); },   // 선택 — Esc/Backspace 처리. 없으면 기본 전체보기 복귀
  });

  // 선택: 상세 패널 확장 — 노드 선택 시 패널 하단에 섹션 추가
  FM.registerDetailExtension((node, panelEl) => { /* ... */ });
})();
```

스크립트는 plain JS IIFE (모듈 시스템 없음, 의존성 제로 원칙). `'use strict'` 사용.

## window.Flowmap API

### 데이터 (읽기 전용으로 취급)
- `FM.NODES` / `FM.EDGES` / `FM.META` — graph.json 전체. 노드/엣지 스키마는 SCHEMA.md 참조
- `FM.nodeById: Map<id, node>` / `FM.inEdges: Map<id, edge[]>` / `FM.outEdges: Map<id, edge[]>`
- `FM.state` — 코어 상태. 모듈은 `state.view`(자기 뷰명), `state.sel`(상세 패널 선택)만 읽는다. **직접 쓰기 금지** (sel 변경은 `FM.setSel(id)`)

### 데이터 lazy 로드
- `await FM.fetchData('data/impact.json')` → JSON 또는 **null**(404/오류). 결과는 캐시됨. null이면 빈 상태 UI를 렌더할 것

### URL
- 자기 뷰의 추가 파라미터는 모듈이 소유: 읽기 `FM.param('commit')`, 쓰기 `FM.pushViewUrl('commits', { commit: 'abc,def' })` (view=는 자동 포함)
- popstate/새로고침 시 코어가 `render()`를 다시 호출하므로, render()는 **항상 URL 파라미터에서 상태를 복원**해야 한다 (모듈 내부 변수에만 의존 금지)
- 다른 화면으로 이동: `FM.setFocus(nodeId)`(호출관계분석), `FM.setService(svc)`, `FM.setOverview(true)`, `FM.setInfraType('kafka'|'redis'|'db'|'external')`, `FM.openView('api', {...})`
- `FM.param(name)` 은 파라미터 부재 시 **null** 반환 (빈 문자열 아님)
- `FM.pushViewUrl` 은 URL만 바꾼다 — **render는 자동 호출되지 않음**, 모듈이 직접 재렌더할 것

### 화면 표면 (render()가 사용할 DOM)
- `#columns` — 메인 캔버스. `cols.className = ''; cols.innerHTML = ''` 후 `.column` div들을 추가하면 기존 컬럼 레이아웃 그대로
- `#breadcrumb` — `bc.style.display='flex'; bc.innerHTML=...` (기존 `.bc-link`/`.bc-sep`/`.bc-focus` 클래스 재사용)
- `#connectors` — 코어가 비워둠. 엣지를 그리려면 아래 "캔버스 커넥터" 사용
- 좌측 레일 등 추가 패널이 필요하면 `#flow-canvas` 안에 모듈이 직접 생성하되, **id에 모듈 접두사**(`imp-rail` 등)를 붙이고 다른 뷰로 떠날 때를 대비해 render() 시작 시 잔여 DOM 정리 — 단 코어는 `#columns`를 비우므로 columns 안에 만들면 정리 불필요. 캔버스 밖 요소는 `escape()`/다음 render에서 제거 책임이 모듈에 있음. **권장: 모든 UI를 #columns 안에 만들 것**

### 렌더 빌딩블록
- `FM.makeCard(id, opts)` → 노드 카드 엘리먼트 (hover 정렬/선택/상세패널 연동 자동). opts: `{ route, isFocus, onActivate(id), onPick(id), inBrowser }`. 생성 시 `FM.cardEls`에 자동 등록됨
- `FM.mkHead(text)` → 컬럼 헤더
- `FM.appendGroupBox(col, label, nodeList, onActivate, onPick)` — 노드 배열을 테두리 박스로
- `FM.computeColumns(bases[, skipDown])` → `{assigned: Map<id,level>, columns: Map<level, id[]>}` — state.up/down 깊이 기준 BFS (음수=피호출, 양수=호출)

### 캔버스 커넥터 (SVG 베지어)
```js
FM.setCanvasEdges(edges);                       // {source, target, kind, relation, mode} — cardEls 에 있는 노드만 그려짐
requestAnimationFrame(() => { FM.pruneOrphans(); FM.drawConnectors(); FM.applyHighlight(); });
```
커스텀 카드(makeCard 미사용)를 만들면 `FM.cardEls.set(id, el)`로 등록해야 커넥터가 연결된다.

### 상세 패널 확장
`FM.registerDetailExtension((node, panelEl) => {...})` — 노드 선택으로 패널이 그려진 **후** 호출됨. panelEl에 섹션을 append. 해당 없는 노드면 아무것도 하지 말 것(빈 섹션 금지). 패널은 CONTROLLER 엔드포인트/인프라 노드 선택 시에만 표시됨.

### 유틸
`FM.esc / FM.escAttr / FM.shortClass / FM.methodClass / FM.layerColor(n) / FM.kindClass(e) / FM.isInfra(id[,n]) / FM.infraGroup(id) / FM.pickLabelOf(n) / FM.copyToClipboard(text, btnEl) / FM.shareUrl() / FM.markHit(text,q) / FM.matches(q,...vals)`
상수: `FM.RES_ICON / FM.KIND_COLOR / FM.INFRA_LABEL / FM.INFRA_ICON / FM.LAYER_CLASS`

## CSS 규칙
- 다크 테마 토큰 사용: `var(--bg) --bg-panel --border --text --text-dim --c-controller … --c-kafka --e-s2s` (style.css `:root` 참조)
- 영향도 전용 토큰(코어에 정의됨): `var(--imp-changed) --imp-tint --imp-halo` (주황 계열 — 변경/영향 하이라이트 전용)
- 재사용 가능한 기존 클래스: `.node-card .column .column-head .path-group .pg-head .pg-body .btn .btn.primary .tag .nc-badge .http .m-get/.m-post/... .browse-empty .search-item .bc-link .bc-sep .bc-focus .hint .grid-count`
- 신규 클래스는 모듈 접두사: impact → `.imp-*`, topic → `.tpc-*`, apidoc → `.doc-*`
- 모든 텍스트 삽입은 `FM.esc()`/`FM.escAttr()` 경유 (XSS)

## 금지 사항
- 코어 파일(app.js, index.html, style.css) 수정 금지
- 전역 네임스페이스 오염 금지 (IIFE 내부에서만)
- `Flowmap.state` 직접 쓰기 금지, `history.pushState` 직접 호출 금지 (`FM.pushViewUrl` 사용)
- 프레임워크/외부 라이브러리 도입 금지
