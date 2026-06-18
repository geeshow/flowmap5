# flowmap — 프로젝트 가이드

서비스 간 호출관계(Screen × API Atlas)를 시각화하는 정적 웹앱 + 분석 파이프라인.

## 웹앱 경로 / 실행

- **앱 소스**: `docs/web/` — **정적 파일**(빌드 단계 없음). 파일 저장 후 새로고침이면 반영.
- **dev server**: `.claude/launch.json` 의 `flowmap`
  = `python3 -m http.server 8770 --directory docs/web` → http://localhost:8770
  (preview 도구 사용 시 `preview_start` name=`flowmap`. Bash 로 서버 띄우지 말 것.)
- **주요 화면(URL 파라미터)**: `?view=overview`(전체보기·기본 홈), `?view=commits`(커밋/PR 영향도),
  `?view=deploy`(배포 영향도 — 년도→일별 배포→PR+서비스 영향), `?view=api`(API 문서), `?view=structure`(어플리케이션구조).
  드릴 파라미터: `service=<svc>`, `infra=<type>`, `focus=<nodeId>`, `pp=<path>`(경로 드릴), `pick=`,
  `y=<년도>`·`d=<날짜>`(배포 영향도).

## ⚠️ 캐시 버스팅 (코드 고치면 반드시 버전 올릴 것)

정적 자산은 버전 쿼리로 캐시 관리. 안 올리면 브라우저가 옛 파일을 씀.
- `docs/web/index.html`: `style.css?v=NN`, `app.js?v=NN`
- `docs/web/app.js`: `const FEATURE_VER = 'NN'` — `features/*.js`·`features/*.css` 모듈 캐시키
- **현재 값**: style.css `v=66`, app.js `v=138`, FEATURE_VER `45`

## 핵심 파일

- `docs/web/index.html` — 레이아웃(사이드바/메인/독), 버전 쿼리
- `docs/web/style.css` — 전역 테마(`--c-*` 노드색, `--e-*` 선색), 노드카드, 범례
- `docs/web/app.js` — 데이터 로드/전체보기/서비스·경로 드릴/SVG 커넥터/줌
- `docs/web/features/impact.js`, `impact.css` — 커밋/PR 영향도(지연 로드 기능 모듈)

## 데이터

- **위치**: `docs/web/data/` (git 추적됨). `data/manifest.json` 을 로드(프로젝트별 독립 그래프 병합),
  없으면 `data/graph.json` 폴백(현재 없음). `.gz` 있으면 우선 사용(DecompressionStream).
- 프로젝트별: `<svc>.json`(그래프), `<svc>.openapi.json`(API 문서), 각 `.gz`.
- **배포 영향도 데이터**: `data/deploy/` — `index.json`·`pr_index.json`(년/일 인덱스) +
  `<년도>/<날짜>/deploy_list.json`·`pr_list.json`. `features/deploy.js` 가 로드(지연). PR→`view=commits` 딥링크.
- **생성 파이프라인**: `sh/` 스크립트 — `sh/run-all.sh` 가 단계 01~13 오케스트레이션
  (backend pull→analyze→merge→openapi→impact → **nexcore refresh** → frontend refresh→analyze→screens→join→**impact** → sync → verify).
  세 분석기(spring-kotlin·nexcore·react)가 각자 `json/` 에 산출물을 만들고, **sync(12)** 가 그
  세 디렉터리를 한 번에 `docs/web/data` 로 취합 + `manifest.json` 재생성(spring-kotlin `sync` 의
  `--frontend-dir` CSV 로 nexcore·react json 을 동시 투입).
- 레거시 `graphs/*.json` + `scripts/build.py` 경로는 제거됨(사용 안 함).

## 색/선 규칙 (통일 규칙)

- **노드(레이어) 색**: 단일 출처 CSS `--c-*`. JS 는 `layerColor(n)` 으로 읽음(중복 정의 없음).
  레이어→클래스 매핑 `LAYER_CLASS`(app.js). `.nc-l-*`/`.nc-r-*` 가 `--lc` 로 연결.
- **선(엣지) 색**: 8종(internal/s2s/external/batch/kafka/redis/db/join). **출처 2곳**:
  JS `KIND_COLOR`(마커·라벨) ↔ CSS `--e-*`(stroke) — 값은 동일하나 수동 동기화 필요(드리프트 주의).
- 선 형태: 실선=sync / 점선=async / 굵을수록 호출 수↑. 평상시 흐림(opacity .32), hover·핀 시 `hot`.
- 범례는 사이드바 하단(`#sidebar-legend`, `renderLegend()`)에서 실제 CSS 변수를 읽어 생성.

## 외부호출 노드 처리 (중요 — 화면↔화면 가짜 연결 방지)

- 외부호출 노드는 layer 가 백엔드 `EXTERNAL` / 프론트 모노레포 `API`(+`ext:`/`externalUrl`)로 다름.
  → **`isExtCallNode(id,n)`** 로 layer 무관하게 판별(app.js).
- 같은 외부 URL 을 여러 프론트가 호출하면 id 충돌로 한 프론트 소속이 되어 false edge 발생.
  `superId()` 가 외부호출을 공유 `infra:external` 로 묶고, `buildServiceGraph()` 가 `join` 엣지의
  ext source 만 그 프론트 svc 로 귀속(front→backend 흐름 유지).

## 검증

- 코드 수정이 화면에 보이는 변경이면 preview 도구로 직접 검증(수동 확인 요청 금지).
  서버 띄우고 → 새로고침 → `preview_console_logs`(에러) / `preview_eval`(상태) / `preview_screenshot`.

## 작업 환경

- 메인 브랜치: `main`. 원격: `github.com/geeshow/flowmap5`.
- 커밋/푸시/PR 은 사용자가 요청할 때만. 한국어로 소통.
