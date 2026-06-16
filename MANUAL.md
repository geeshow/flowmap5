# flowmap 사용자 매뉴얼

flowmap 웹 앱의 화면별 기능, 조작법, URL 파라미터, 데이터 파이프라인을 정리한 문서입니다.
데이터 필드의 정확한 정의는 [SCHEMA.md](SCHEMA.md), 색/선 규칙의 배경은 [RENDERING.md](RENDERING.md)를 참고하세요.

---

## 1. 실행

```bash
python3 scripts/build.py        # graphs/*.json → docs/web/data/graph.json 머지
python3 -m http.server 8770     # 정적 서버 (아무 것이나 가능)
# → http://localhost:8770/docs/web/
```

빌드 도구나 의존성이 없습니다. `docs/web/` 디렉토리는 `index.html` + `app.js` + `style.css` +
`data/graph.json`이 전부입니다.

---

## 2. 화면 구성

```
┌──────────────────────────────────────────────────────────────┐
│ 상단바: 로고 · 🗺️ 전체보기 · API 검색 · 🔗 공유 링크 복사        │
├───────────────────────────────────────────────┬──────────────┤
│                                               │              │
│   메인 캔버스                                   │  상세 패널    │
│   (브레드크럼 + 컬럼 그래프 + 연결선)             │  (조건부 표시) │
│                                               │              │
├───────────────────────────────────────────────┴──────────────┤
│   하단 프로세스 흐름 패널 (서비스 보기 3단계에서만 표시)            │
└──────────────────────────────────────────────────────────────┘
```

- **상세 패널(오른쪽)** — *엔드포인트(CONTROLLER) 또는 인프라(Kafka/Redis/DB/외부 API) 노드를
  선택했을 때만* 나타납니다. 다른 화면으로 이동하면 사라집니다. 왼쪽 가장자리를 드래그해 너비 조절.
- **프로세스 흐름 패널(하단)** — 서비스 보기에서 노드를 선택(3단계)했을 때만 나타납니다.
  상단 가장자리를 드래그해 높이 조절. 조절한 크기는 `localStorage`에 저장되어 유지됩니다.

---

## 3. 진입 브라우저 — 서비스 → 경로 → 엔드포인트

첫 화면. 서비스 카드(엔드포인트 수 막대 포함)를 클릭해 들어가면 URL 1단계 경로(`/admin`, `/v1` …)
폴더와 엔드포인트 카드가 나옵니다. 경로는 최대 2단계까지 그룹핑되고, 그 아래는 엔드포인트 목록입니다.

- 목록 상단의 **필터 입력**으로 경로/메서드를 좁힐 수 있습니다.
- 엔드포인트 카드를 클릭하면 그 노드 기준 **호출관계분석**(§7)으로 진입합니다.
- 브레드크럼(`📚 서비스 › svc › /path`)으로 상위 단계로 돌아갑니다.

## 4. 전체보기 — 서비스 지도

상단바 **🗺️ 전체보기**. 서비스 간 의존을 서비스 단위로 합쳐 보여줍니다.

- 서비스 간 **S2S 호출**(파랑)·**이벤트/인프라 의존**(보라 등)이 집계 엣지로 표시되고,
  호출 횟수에 따라 선이 굵어지며 `×N` 라벨이 붙습니다.
- 컬럼은 S2S 방향 기준 좌(진입/호출) → 우(제공 서비스)로 배치되고,
  맨 오른쪽에 **공유 인프라/외부**(Kafka 토픽, Redis, DB 테이블, 외부 API) 타입 카드가 모입니다.
- **서비스 카드 클릭** → 서비스 보기(§5). **인프라 타입 카드 클릭** → 인프라 타입 보기(§8).

## 5. 서비스 보기 — 전체보기 › 서비스 (2단계)

한 서비스의 모든 API(1단계 경로 그룹 박스)와, 서비스/인프라 단위로 한 단계씩 확장한
**피호출 N단계 ← API 목록 → 호출 N단계** 컬럼을 보여줍니다.

- 분석 바의 **목록 좁히기** 입력으로 중앙 API 목록을 필터링.
- 호출/피호출 관계가 없는 노드는 기본적으로 숨겨집니다.
- 카드에 hover 하면 연결된 노드(그룹 박스)가 같은 행으로 정렬 애니메이션 됩니다.

## 6. 노드 선택 — 3단계 (서비스 보기의 핵심)

서비스 보기에서 **노드를 클릭**하면 3단계로 진입합니다:

1. **브레드크럼**이 `🗺️ 전체보기 › <service> › <METHOD> <API PATH>`로 바뀝니다.
2. 캔버스가 **선택 노드와 연결된 체인만** 남도록 필터링됩니다
   (선택 노드에서 호출/피호출 방향으로 닿는 노드 전체, 빈 그룹/컬럼은 숨김).
3. 화면 하단에 **프로세스 흐름 패널**(§6.1)이 나타납니다.

3단계에서의 동작 규칙:

- **기준 노드는 고정** — 다른 노드를 클릭해도 기준(브레드크럼/필터)은 바뀌지 않고,
  선택만 이동해 상세 패널과 하단 흐름도가 그 노드 기준으로 갱신됩니다.
- **해제 방법**: 브레드크럼의 서비스명 클릭 / `Esc` / `Backspace` / 하단 패널 ✕
- 선택 상태는 URL `pick=` 파라미터로 저장되어 공유/뒤로가기에 유지됩니다.

### 6.1 프로세스 흐름 패널

선택한 체인 **전체**의 application 내부 실행 흐름을 그리는 미니 플로우맵입니다.

```
[🧩 svc A]                       │ [🧩 svc B]
CONTROLLER → SERVICE → REPOSITORY → INFRA │ CONTROLLER → COMPONENT → …
```

- **세그먼트** — 서비스 단위 컬럼 그룹. 체인 방향(피호출 서비스 → 기준 서비스 → 호출 서비스)으로
  왼쪽→오른쪽 정렬되고 점선으로 구분됩니다. S2S/Kafka 경계를 넘으면 다음 세그먼트로 이어집니다.
- **레이어 컬럼** — 세그먼트 안에서 Controller → Service → Component → Batch/Config →
  Repository → Infra/External 순서.
- **노드 카드** — HTTP 메서드/레이어/리소스 배지, 메서드명, 엔드포인트·외부 URL, 클래스명,
  API 설명, 파일명:라인. hover 시 전체 FQCN·경로 툴팁이 나타납니다. 기준 노드는 노란 테두리.
- **연결선** — kind 색(내부 회색 / S2S 파랑 / 외부 빨강 / Kafka 보라 / Redis 분홍 / DB 갈색),
  화살표는 호출 방향. **sync는 실선, async는 점선 + `· async` 라벨**
  (`kafka:produce · async` 등). 헤더에 `— sync ┄ async` 범례.
- **hover 강조** — 노드에 마우스를 올리면 연결된 엣지가 굵게, 나머지는 투명하게 처리되고
  연결선이 **노드 위로** 올라와 어디로 이어지는지 또렷하게 보입니다. 연결 안 된 노드는 흐려집니다.
- **헤더 정보** — 레이어 구성 칩(`CONTROLLER → SERVICE ×10 → DB ×2`), 노드/호출 수,
  기준 API 설명. 그래프가 상한(200 호출)을 넘으면 `(일부만 표시)`로 알립니다.

## 7. 호출관계분석 — 임의 노드 기준 그래프

검색 결과 선택, 진입 브라우저의 엔드포인트 클릭, 카드의 **중심 ⟲** 버튼으로 진입합니다.

- **피호출 N ← 기준 API → 호출 N** 컬럼 그래프. 분석 바의 스테퍼로 양방향 깊이(0~6) 조절.
- 기준 카드의 **프로세스 상세보기 ▼** — 내부 실행 흐름을 들여쓰기 트리로 인라인 확장.
  각 행에 레이어 색 점, 호출 라인(`L44`), 관계 태그, async 표시. 행의 **중심 ⟲**으로 재중심.
- 기준 컬럼의 **연결된 노드만** 체크박스로 고아 노드 표시 여부 전환.
- 출처(전체보기/서비스 보기)에서 진입한 경우 브레드크럼과 ⟵ 버튼이 그 맥락으로 돌아갑니다.

## 8. 인프라 타입 보기 — 전체보기 › Kafka/Redis/DB/외부

전체보기의 인프라 타입 카드를 클릭하면 그 타입의 모든 노드(토픽/테이블/외부 클라이언트 그룹)와
피호출/호출 1단계 관계를 보여줍니다. 노드 클릭 시 그 노드 기준 호출관계분석으로 진입합니다.

## 9. 검색

상단 검색창(`/` 단축키)에 메서드명/클래스/엔드포인트/한글 설명을 입력합니다.
최대 40건이 즉시 표시되고, `↑`/`↓` + `Enter` 또는 클릭으로 선택하면 호출관계분석으로 진입합니다.

## 10. 상세 패널

엔드포인트 또는 인프라 노드를 선택하면 오른쪽에 표시됩니다:
메서드/클래스/태그, API 설명, layer · project · endpoint · returnType · file:line · id 테이블,
**이 노드 기준 호출관계분석** / **공유 링크 복사** 버튼.

## 11. 조작법 요약

| 조작 | 동작 |
|---|---|
| `/` | 검색창 포커스 |
| `Esc` / `Backspace` | 한 단계 뒤로 (3단계 해제 → 전체보기 → 브라우저 순) |
| `+` `-` `0` | 줌 인/아웃/리셋 (트랙패드 핀치, 우하단 버튼도 동일) |
| 카드 hover | 연결 노드 행 정렬 + 연결선 강조 |
| 하단 패널 상단 가장자리 드래그 | 프로세스 흐름 높이 조절 (140px ~ 화면 80%) |
| 상세 패널 왼쪽 가장자리 드래그 | 패널 너비 조절 (240px ~ 화면 60%) |
| 🔗 공유 링크 복사 | 현재 화면 URL 클립보드 복사 |

## 12. URL 파라미터

모든 화면 상태가 URL에 동기화됩니다. 주소를 그대로 공유하면 같은 화면이 열립니다.

| 파라미터 | 의미 | 예 |
|---|---|---|
| `view=overview` | 전체보기 | `?view=overview` |
| `service=<svc>` | 서비스 보기 | `?service=order-service&up=1&down=1` |
| `pick=<nodeId>` | 서비스 보기에서 선택한 기준 노드 (3단계) | `…&pick=com.acme...%23create` |
| `infra=<type>` | 인프라 타입 보기 (`kafka`/`redis`/`db`/`external`) | `?infra=kafka` |
| `focus=<nodeId>` | 호출관계분석 기준 노드 | `?focus=…%23getUser&up=2&down=2` |
| `up` / `down` | 피호출/호출 깊이 (0~6) | |
| `exp=1` | 기준 노드 프로세스 상세보기 펼침 | |
| `from=<svc>` / `fo=1` | 분석 진입 출처 (서비스 보기 / 전체보기) — 브레드크럼·뒤로가기 체인 | |
| `svc` / `path` | 진입 브라우저 위치 | `?svc=sample-shop&path=orders` |
| `sel=<nodeId>` | 상세 패널 선택 노드 | |

## 13. 데이터 파이프라인

```
graphs/<service>.json  ──  scripts/build.py  ──▶  docs/web/data/graph.json  ──▶  브라우저
        ▲                                              (id 기준 union)
        │
call-graph-spring-kotlin 분석기 (registry.json 공유로 S2S/Kafka 누적 매칭)
```

- **머지 규칙**: 노드는 `id`로 dedup(원본 `file`이 채워진 노드 우선),
  엣지는 `(source, target, relation, callSiteLine)`으로 dedup.
- 분석기를 재실행한 뒤 `python3 scripts/build.py` 한 번이면 웹 데이터가 최신화됩니다.
- `registry.json`은 서비스별 노출 엔드포인트와 Kafka producer/consumer를 누적한 인덱스로,
  렌더러가 직접 읽지는 않습니다(그래프에 이미 연결이 반영됨).

## 14. 데이터 모델 요약

전체 필드 정의는 [SCHEMA.md](SCHEMA.md) 참고. 렌더러가 주로 쓰는 필드:

**노드** — `id`(경계를 넘는 조인 키), `layer`(CONTROLLER/SERVICE/COMPONENT/REPOSITORY/CONFIG/
BATCH/EXTERNAL/RESOURCE/OTHER), `method`, `fqcn`, `httpMethod`+`endpoint`(컨트롤러),
`resourceType`(kafka-topic/db-table/redis), `externalService`/`externalUrl`(외부),
`description`(API 한글 설명), `async`, `file`/`line`, `project`, `module`, `returnType`

**엣지** — `source`/`target`, `kind` × `relation` × `mode`:

| kind | relation | mode | 표현 |
|---|---|---|---|
| `internal` | `call` | sync/async | 회색 실선/점선 |
| `s2s` | `call` | sync | 파랑, `S2S` 라벨 |
| `external` | `call` | sync | 빨강, `EXT` 라벨 |
| `resource` | `kafka:produce`·`kafka:consume`·`db:io`·`redis:io` | async/sync | 타입 색, relation 라벨 |
| `batch` | `batch:step`·`batch:reader`·`batch:processor`·`batch:writer` | async | 보라 |

`callSiteFile`/`callSiteLine`은 호출 지점 — 화면에서는 호출 순서 정렬과 프로세스 트리의 `L44` 표기에 사용됩니다.

## 15. 기능 모듈 (lazy load)

`docs/web/features/` 의 기능 모듈은 **메뉴 진입 시에만** 코드와 데이터를 로드합니다 (초기 로딩 영향 0).
모듈 계약은 `docs/FEATURE-API.md` 참조 — AI/개발자가 기능을 수정할 땐 해당 모듈 파일만 보면 됩니다.

### 15.1 🧾 커밋 영향도 (`?view=commits`)
- 헤더 nav `🧾 커밋 영향도` 로 진입. 데이터: 매니페스트의 `<project>.impact.json` 들을 병합(없으면 생성 안내 표시).
- 좌측 커밋 레일: 체크박스로 **여러 커밋 묶어 보기**(합집합), 카드 클릭은 단일 선택. 작성자/메시지/파일 필터.
- 커밋 미선택: 엔드포인트 → 영향 커밋 집계 테이블. 선택: 변경 노드(◆ 주황 링)에서 피호출 역추적 → 영향 엔드포인트(◇ 점선 링) 그래프.
- `inGraph:false` 변경은 "그래프 외 변경 N건" 으로 별도 표기.
- 상세 패널: 영향받은 엔드포인트 선택 시 `◆ 영향 커밋 N건` 섹션 (impact 모듈 로드 후).
- URL: `commit=<shortSha[,sha...]>`, `ep=<nodeId>` (역조회 필터)

### 15.2 📡 카프카 토픽 영향도 (`?view=topic`)
- 진입: kafka 토픽 노드 상세 패널의 `📡 토픽 영향도 분석` 버튼, 또는 `?view=topic` (토픽 목록).
- 좌측 PRODUCE 레인: 이 토픽을 발행시키는 체인을 API 엔드포인트까지 역추적. 우측 CONSUME 레인: 소비 후 후속 처리(DB/외부/2차 토픽)까지 순추적.
- `엔드포인트까지 역추적(end-to-end)` 토글 (`e2e=0/1`), 컨슈머 없는 토픽은 "소비되지 않음" 경고.
- URL: `topic=<노드id>` (예 `kafka:order.created`)

### 15.3 📖 API 문서 (`?view=api`)
- 헤더 nav `📖 API 문서` 로 진입. 데이터: 매니페스트의 `<project>.openapi.json` 들을 병합 (OpenAPI 3.1, operationId = 그래프 노드 id).
- 서비스 목록 → 엔드포인트 카탈로그 (마스터-디테일). 행 클릭 → 상세 패널에 파라미터 테이블·Request/Response 스키마 트리($ref 클릭 전개, 순환은 `↺ 재귀`).
- 그래프의 CONTROLLER 노드 상세 패널에서도 `📄 API 문서` 버튼으로 동일 문서 확인.
- URL: `asvc=<서비스>`, `q=<필터>`

## 16. 데이터 동기화 — 프로젝트별 독립 분석 + 매니페스트

여러 프로젝트(백엔드 다수 + 프론트엔드)를 **각각 따로 분석**해 둔 산출물을 모아 한 화면에 통합한다. 앱은 통합 그래프 하나가 아니라 **프로젝트별 파일 + 매니페스트**를 읽고 브라우저에서 병합한다(서비스 간 s2s 호출과 프론트→백엔드 join 연결도 브라우저가 계산).

- 두 분석기는 각자 `json/`에 per-project 파일과 `_manifest.json`(프로젝트 메타데이터)을 자동 생성한다.
  - 백엔드(`../flowmap-spring`): `<project>.json`, `<project>.openapi.json`, `_combined.json`, `_manifest.json`
  - 프론트(`../flowmap-react`): `<project>.json`, `<project>.join.json`, `_manifest.json`
- 동기화:
```bash
scripts/sync-data.sh
# 1) 두 분석기 json/ 의 per-project 파일을 docs/web/data/ 로 복사 (_* 통합본 제외)
# 2) 백엔드 커밋 영향도 → <project>.impact.json 생성
# 3) 두 _manifest.json 을 병합 → data/manifest.json (앱의 프로젝트 목록)
```
- 매니페스트(`data/manifest.json`): `{version, generated, projects:[{name,type,graph,openapi,impact,join,screens,nodes,edges}]}`. `type`은 `backend`/`frontend`.
- 한 프로젝트만 재분석해도 그 프로젝트 파일과 매니페스트 엔트리만 갱신하면 된다(전체 재통합 불필요). 매니페스트가 없으면 앱은 단일 `data/graph.json`으로 폴백한다(하위호환).

## 17. 테스트

```bash
node tests/check-data.mjs       # 데이터 계약 (끊긴 엣지/operationId 조인율/impact 무결성)
node tests/check-features.mjs   # 기능 모듈 정적 검사 (문법/등록/금지 패턴)
```
