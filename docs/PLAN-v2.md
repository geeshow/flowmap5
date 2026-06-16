# flowmap v2 기능 기획안

**작성일**: 2026-06-13 · **데이터 소스**: `flowmap-spring/kotlin-analyzer/json/`

## 0. 요약

flowmap은 현재 "지금 코드가 어떻게 연결되어 있는가"를 보여주는 정적 지도다. v2의 방향은 두 가지 축으로 확장한다.

1. **시간 축**: git commit 영향도 — "이번 변경이 어떤 API를 건드리는가"
2. **깊이 축**: OpenAPI/RestDocs 조인 — "이 엔드포인트는 무엇을 주고받는가"

여기에 Kafka 영향도(비동기 전파 경로)를 더해, 배포 전 리뷰 도구로서의 실사용 가치를 만든다. 기존 기능(진입 브라우저, 전체보기, 서비스 보기, 호출관계분석, 프로세스 독, 검색, 공유 링크, 줌, 상세 패널)은 전부 유지하며, 신규 기능은 모두 기존 화면에 **오버레이/패널로 점진 부착**한다. 단일 파일 바닐라 JS 구조는 유지하되 파일만 기능 단위로 2~3개 분리한다.

### 데이터 검증 결과 (기획 근거)

| 항목 | 실측값 |
|---|---|
| `_combined.json` | 1.05MB, 노드 759 / 엣지 1137, s2s 14 |
| 레이어 분포 | SERVICE 240, REPOSITORY 166, CONTROLLER 142, COMPONENT 123, OTHER 53, CONFIG 17, RESOURCE 8, EXTERNAL 5, BATCH 5 |
| 프로젝트 편중 | tera-cloud-user 705 노드(93%), 나머지 8개 프로젝트 합계 41 노드 |
| 엣지 relation | call 1122, db:io 8, batch:* 4, kafka:produce/consume 각 1, redis:io 1 |
| `_openapi.json` | 124 paths / 132 operations, **전부 operationId 보유**(그래프 노드 id와 1:1), 스키마 65개, requestBody 64건 |
| description(RestDocs) | OpenAPI에는 0건. **그래프 노드 `description` 필드에 9건** (bank-broker 5, twice-api 2, admin-portal 1, funding-service 1) |
| 엔드포인트 컨트롤러 | 135개, 그중 내부 피호출(s2s 포함) 0건인 노드 124개 |
| urlPlaceholder 미해결 | 2건 (`${tera.service-url.system}/...`) |
| impact | analyzer CLI에 구현 완료·MANUAL 문서화 완료. **json 디렉토리에 산출물 없음** — refresh 워크플로우 미포함 |

---

## 1. 데이터 소스 전환 전략

### 1.1 결정: `_combined.json` 단일 로드 유지 + 빌드(동기화) 스크립트

| 선택지 | 판단 |
|---|---|
| **A. `_combined.json` 단일 로드 (채택)** | 1.05MB는 기존 graph.json(852KB)과 동급. gzip 시 ~150KB 수준. 현재 앱의 전역 인덱스(nodeById, in/outEdges) 구조를 그대로 사용 가능. 스키마 호환 확인됨. |
| B. 프로젝트별 lazy load | 노드의 93%가 tera-cloud-user 한 프로젝트에 몰려 있어 분할 효과가 없다. 전체보기·s2s 분석은 어차피 combined가 필요. **기각** |
| C. 심볼릭 링크 | 로컬에선 동작하나 정적 호스팅 배포 시 깨지고, analyzer repo와 web repo의 수명주기가 묶인다. **기각** |

### 1.2 파일별 로딩 시점

| 파일 | 로딩 시점 | 근거 |
|---|---|---|
| `graph.json` (← `_combined.json` 복사) | 부트 시 (현행 유지) | 모든 화면의 기반 |
| `openapi.json` (← `_openapi.json` 복사) | **지연 로드**: API 문서 최초 열람 시 1회 fetch 후 메모리 캐시 | 118KB. 부트 경로에 안 넣어 초기 로딩 영향 0. 실패 시 문서 탭만 비활성("문서 데이터 없음") |
| `impact.json` (신규 생성 필요) | **지연 로드**: 영향도 탭 최초 진입 시. 404면 탭에 생성 가이드 노출 | 데이터가 아직 없으므로 부재를 1급 상태로 설계 |

### 1.3 동기화 스크립트 (신규, `scripts/sync-data.sh`)

```
analyzer refresh → json/ 갱신
  → cp json/_combined.json  web/data/graph.json
  → cp json/_openapi.json   web/data/openapi.json
  → analyzer impact --git <대상repo> --graph json/_combined.json --out web/data/impact.json
```

- impact 단계를 동기화에 포함시키는 것이 핵심. **analyzer 쪽 갭**: refresh 워크플로우에 impact가 없으므로 스크립트에서 명시 호출하거나, analyzer `refresh`에 `--impact` 옵션 추가를 요청한다(후자 권장).
- impact는 git 작업 트리가 필요하므로 CI가 아닌 로컬 동기화 단계에서 실행한다.
- 부트 코드 변경은 fetch 경로 한 줄 + meta 필드 차이 흡수 정도. **공수: 0.5일**

---

## 2. 기능별 기획

### 2.1 Git Commit 영향도 분석

**사용자 스토리**
- "배포 담당자로서, 이번 릴리스에 포함된 커밋들이 **어떤 엔드포인트의 동작을 바꿀 수 있는지** 배포 전에 확인하고 싶다."
- "리뷰어로서, 특정 커밋이 건드린 메서드의 **호출자 체인**을 그래프 위에서 보고 싶다."
- "QA로서, 영향받은 엔드포인트 목록을 **공유 링크로** 테스트 범위 산정에 쓰고 싶다."

**UX 플로우**
1. **진입 1 — 상단 탭 "영향도"** (신규 최상위 모드, URL `?view=commits`): 좌측에 커밋 리스트(shortSha · subject · author · date · 영향 엔드포인트 수 배지), 우측에 `endpointImpact[]` 집계 테이블("엔드포인트 → 영향 커밋들"). 릴리스 노트 관점의 기본 화면.
2. 커밋 선택 → 해당 커밋의 `changedNodes`를 시드로 기존 **호출관계분석 화면을 재사용**해 역방향(피호출) 체인을 렌더. 변경 노드는 ⚡ 배지 + 강조색, 영향 엔드포인트는 HTTP 메서드 칩으로 표시. impact.json의 `subgraph`가 이미 caller 체인을 담고 있으므로 프론트 BFS 재계산 불필요.
3. **진입 2 — 오버레이 모드**: 전체보기/서비스 보기에 "최근 변경 표시" 토글. `impactedEndpoints`에 포함된 엔드포인트 카드에 "변경됨 N commits" 배지. 상세 패널에 관련 커밋 목록 섹션 추가.
4. 모든 상태는 기존 관례대로 URL 동기화(`?view=commits&commit=<shortSha>`), 공유 링크 그대로 동작.

**필요 데이터와 갭**
- 출력 스키마는 확정됨: `commits[](sha, shortSha, author, date, subject, changedFiles, changedNodes[{id,inGraph}], impactedEndpoints, impactedServices)`, `subgraph{nodes,edges}`, `endpointImpact[]`.
- **갭 1 (차단 요소)**: impact.json이 생성되지 않음 → 1.3의 동기화 스크립트/refresh 옵션 작업 선행 필수.
- **갭 2**: 다중 repo. impact는 `--git` 하나의 repo 기준. 9개 프로젝트 전체를 보려면 repo별 실행 + 병합이 필요. **v2 범위는 주력 repo(tera-cloud-user) 1개로 한정**하고, 다중 repo 병합은 analyzer 백로그로 넘긴다.

**엣지케이스**
- `inGraph:false` 변경 노드(rename/삭제/미분석 레이어): 그래프에 못 그리므로 커밋 상세에 "그래프 외 변경 N건" 회색 목록으로만 표기. 숨기면 영향도 과소평가로 오인된다.
- 변경 노드 0건 커밋(.kt 외 파일만 변경): 리스트에 "코드 영향 없음"으로 표시하되 changedFiles는 보여준다 — 설정/SQL 변경이 실제로는 더 위험할 수 있음을 툴팁으로 고지.
- impact 시점 정합성: impact.json의 생성 시각과 graph.json의 생성 시각을 화면 헤더에 병기, 불일치 시 경고 배지.
- 동일 메서드를 여러 커밋이 수정: endpointImpact 집계가 이미 처리. 커밋 칩을 누적 표시.

### 2.2 Kafka 영향도 분석

**사용자 스토리**
- "개발자로서, 어떤 API를 호출하면 **어떤 토픽에 이벤트가 발행되고, 누가 그걸 consume해서 어디까지 이어지는지** 끝까지 보고 싶다."
- "장애 분석자로서, 토픽 consume 이후 체인에 포함된 DB/외부호출을 한눈에 보고 싶다."

**UX 플로우**
1. **진입**: 전체보기의 Kafka 노드 클릭(기존 동선) 또는 검색에서 `kafka:` 접두 검색 → **토픽 중심 뷰**. 좌측 producer 체인(이 토픽에 publish하는 메서드 ← 그 호출 엔드포인트까지 역추적), 우측 consumer 체인(listener → 후속 동기 호출 → DB/외부/또 다른 produce까지 순방향).
2. 핵심 시각 장치: **비동기 경계선**. produce→topic→consume 구간을 점선 + 토픽 노드를 세로 구분선으로 렌더해 "여기서부터는 다른 트랜잭션"임을 명시.
3. 호출관계분석 화면에 **"비동기 전파 포함" 토글**: 켜면 BFS가 kafka:produce → 같은 토픽의 kafka:consume 엣지를 통과해 이어 탐색, 끄면 토픽에서 정지. commit 영향도와 결합 시 가치 배가 — "이 커밋의 영향이 이벤트 너머 notification-service까지 간다."
4. 상세 패널: 토픽 선택 시 producer/consumer 목록, 각 callSiteFile:line 링크.

**필요 데이터와 갭**
- 데이터는 충분: `kafka:order.created` 토픽 노드, `kafka:produce`/`kafka:consume` 엣지, callSite 정보. 조인(produce target 토픽 = consume source 토픽)은 프론트 단순 매칭.
- **갭 (중요)**: 현재 데이터에 토픽이 **1개뿐**(order.created). 기능은 일반화해 만들되, analyzer의 토픽 추출 커버리지(변수/상수 토픽명, 설정 참조, `@KafkaListener` topics 배열) 검증을 선행 과제로 둔다.

**엣지케이스**
- consumer 없는 토픽 / producer 없는 토픽: "분석 범위 밖 consumer/producer 가능성"을 빈 레인에 명시. 빈 화면으로 두면 "아무도 안 듣는다"로 오독된다.
- 순환(consume 체인이 다시 같은 토픽에 produce): "루프 감지" 배지로 표기.
- 토픽 1개인 현 데이터에서 토픽 목록 화면은 과함 — 목록은 기존 인프라 드릴다운에 위임하고 토픽 중심 뷰만 신설.

### 2.3 RestDoc / API 문서 보기

**사용자 스토리**
- "프론트/타 서비스 개발자로서, 그래프에서 찾은 엔드포인트의 **요청 파라미터·request/response 스키마·설명**을 flowmap 안에서 바로 보고 싶다."
- "API 소비자로서, 호출관계와 문서를 **한 화면에서** 오가며 's2s로 나를 호출하는 쪽이 보내는 파라미터'를 확인하고 싶다."

**UX 플로우**
1. **진입 1 — 상세 패널 확장**: CONTROLLER 노드 선택 시 상세 패널에 "API 문서" 섹션 추가. operationId(= 노드 id)로 `_openapi.json` 조인 → path 파라미터, requestBody/response 스키마를 접이식 렌더. `$ref`는 1단계 해석(중첩은 클릭 펼침).
2. **진입 2 — 진입 브라우저 엔드포인트 카드**: description 한 줄을 카드 부제로 노출.
3. 스키마 렌더는 Swagger UI 수준이 아닌 **이름/타입/required/중첩 트리** 미니멀 렌더러(재귀 함수 1개). 의존성 제로 원칙 유지.
4. URL: `?sel=<nodeId>&tab=doc` 형태로 패널 탭까지 공유 가능.

**필요 데이터와 갭**
- 조인 키 검증 완료: 132개 오퍼레이션 전부 operationId 보유, 그래프 노드 id와 동일 규칙.
- **갭 1**: OpenAPI의 summary/description이 전부 비어 있음. RestDocs 설명은 그래프 노드 `description`에만 있음(9건). 프론트에서 두 소스 병합 표시 + analyzer에 "description을 OpenAPI에도 주입" 개선 요청.
- **갭 2**: description 커버리지 9/135 = 6.7%. 커버리지 지표를 대시보드에 노출해 작성 문화를 유도.

**엣지케이스**
- OpenAPI에 없는 엔드포인트: "문서 없음" 명시 + endpoint 문자열의 `{var}`에서 파라미터 추론 표시.
- 순환 참조 스키마: 렌더 깊이 제한(기본 3단) + "..." 펼침.
- `additionalProperties: {}` 같은 빈약한 스키마: "비정형 응답(Map)"으로 정직하게 표기.

---

## 3. 추가 기능 후보 (데이터 검증 기반 가치/노력 평가)

| 후보 | 데이터 근거(실측) | 가치 | 노력 | 판단 |
|---|---|---|---|---|
| **A. 인사이트 대시보드 (통계+품질 리포트 통합)** | 레이어/프로젝트 분포, fan-in/out (최대 fan-out 20: `SignupService#signupInternal`, 최대 fan-in 31: `SystemConfigService#getValue`) | 상 — 핫스팟·복잡도 식별 | 중(2일) | **채택(P2)**. 아래 B·C·D를 탭 하나에 묶음 |
| **B. 내부 미참조 엔드포인트 리포트** | 135개 중 124개가 내부 피호출 0 | 중 — "죽은 API"가 아니라 "**s2s로는 안 불리는 API**". 명칭·문구로 오독 방지 필수 | 하(0.5일) | 채택(A에 포함) |
| **C. description 커버리지** | 9/135 (6.7%), bank-broker 5/5 vs tera-cloud-user 0/122 | 중 — RestDoc 기능과 묶어 문서화 동기 부여 | 하(0.5일) | 채택(A에 포함) |
| **D. 미해결 URL/외부 의존 리포트** | urlPlaceholder 2건, EXTERNAL 5건 | 중 — analyzer 설정 보완 유도 + 외부 의존 가시화 | 하(0.5일) | 채택(A에 포함) |
| **E. 배치 잡 시각화** | BATCH 5노드, batch:* 4엣지 — 체인 1개 | 하 — 데이터 1건 | 하(0.5일) | **축소 채택(P3)** — 전용 화면 없이 프로세스 독에서 batch relation을 단계형 렌더 |
| **F. DB 테이블 영향도** | db-table 6개, db:io 8엣지 | 하 — repository의 1% 미만만 테이블 매핑. **거짓 음성 유발** | 중 | **보류** — analyzer 커버리지 확보 후 재검토 |
| **G. async/sync 흐름 필터** | async 22 / sync 1115 | 중 — Kafka 뷰의 비동기 경계 표시로 핵심 가치 흡수 | 하(0.5일) | Kafka 기능에 통합 |
| H. 코드 점프 (file:line 링크) | 전 노드 file/line, 전 엣지 callSite 보유 | 중 — GitHub/IDE 링크, repo URL prefix 설정 하나면 됨 | 하(0.5일) | **채택(P2)** |

> **F 보류 이유**: 영향도류 기능은 커버리지가 낮으면 "표시 안 됨 = 영향 없음"이라는 잘못된 확신을 준다. 6/166 repository만 매핑된 상태에서는 만들지 않는 것이 옳다.

---

## 4. 우선순위 로드맵

> 전제: 단일 파일 바닐라 JS 유지. 프레임워크 도입·전면 리팩토링 없음. 신규 기능은 `impact.js`, `doc.js` 정도의 파일 추가로 분리하고, 기존 render 파이프라인에 훅으로 부착.

### Phase 1 — 기반 전환 + 핵심 영향도 (약 1.5주)

| 작업 | 공수 | 의존 |
|---|---|---|
| 1-1. 데이터 소스 전환 + sync-data.sh | 0.5일 | — |
| 1-2. analyzer: refresh에 impact 포함(또는 스크립트 호출) + impact.json 산출 | 1일 (analyzer 측) | 1-1 |
| 1-3. 영향도 탭: 커밋 리스트 + endpointImpact 테이블 | 2일 | 1-2 |
| 1-4. 커밋 → 호출관계분석 재사용 렌더 (subgraph 하이드레이트) | 2일 | 1-3 |
| 1-5. 전체보기/서비스 보기 "변경됨" 배지 오버레이 | 1일 | 1-3 |

### Phase 2 — 문서 + Kafka (약 1.5주)

| 작업 | 공수 | 의존 |
|---|---|---|
| 2-1. OpenAPI 지연 로드 + operationId 조인 + 미니 스키마 렌더러 | 2.5일 | 1-1 |
| 2-2. 진입 브라우저 카드에 description 부제 | 0.5일 | 1-1 |
| 2-3. Kafka 토픽 중심 뷰 (producer/consumer 레인, 비동기 경계선) | 2일 | 1-1 |
| 2-4. 호출관계분석 "비동기 전파 포함" 토글 | 1일 | 2-3 |
| 2-5. analyzer: description → OpenAPI 주입, Kafka 토픽 추출 커버리지 점검 | 1~2일 (analyzer 측) | 병행 |

### Phase 3 — 인사이트 + 마감 (약 1주)

| 작업 | 공수 | 의존 |
|---|---|---|
| 3-1. 인사이트 대시보드 (통계, fan-in/out 핫스팟, 미참조 API, description 커버리지, 외부 의존) | 2일 | 1-1 |
| 3-2. 코드 점프 링크 (repo URL 설정) | 0.5일 | — |
| 3-3. 프로세스 독 batch 단계 렌더 | 0.5일 | — |
| 3-4. commit 영향도 × Kafka 전파 결합 | 1일 | 1-4, 2-4 |

**총 공수**: 웹 약 16일 + analyzer 약 2~3일. Phase 1 종료 시점부터 배포 전 리뷰에 실전 투입 가능.

---

## 5. 리스크와 대응

| 리스크 | 내용 | 대응 |
|---|---|---|
| **렌더 성능** | tera-cloud-user(705노드) + 깊이 확장 + 비동기 전파 토글로 탐색 범위 폭증 가능 | 깊이 기본값 보수 유지, 비동기 전파는 명시적 토글로만, 렌더 노드 상한 초과 시 "범위를 좁히세요" 안내 |
| **로딩 크기** | graph 1.05MB + openapi 118KB + impact(커밋 수 비례) | openapi/impact 지연 로드, 서버 gzip, impact는 `--max` 상한 운용 |
| **impact 신선도** | graph.json과 impact.json 생성 시점이 어긋나면 조인이 틀어짐 | sync-data.sh에서 항상 같은 시점에 생성, 양쪽 생성 시각 화면 병기 + 불일치 경고 |
| **단일 파일 구조 한계** | 1872줄 + 신규 3기능이면 3천줄대 | 전면 리팩토링 금지. 신규 기능은 별도 js 파일 + 명시적 훅으로 부착. state 키 추가는 URL 파서와 동시 수정 체크리스트 |
| **거짓 안심(과소 영향도)** | 커버리지 한계가 "영향 없음"으로 읽힐 위험. **가장 큰 제품 리스크** | 모든 영향도 화면에 분석 범위 고지 고정 노출, 빈 결과를 "범위 밖 가능성"으로 표기, DB 영향도 출시 보류 |
| **다중 repo impact** | impact가 repo 단위 — 9개 프로젝트 전체 커버 불가 | v2는 단일 repo 한정 명시, 화면에 대상 repo 표기. 다중 repo 병합은 백로그 |
| **데이터 빈약 구간** | Kafka 토픽 1개, description 9건, batch 1체인 | 기능은 일반화 설계하되 전용 화면 신설 최소화. analyzer 추출 커버리지 개선 병행 |

---

## 부록: analyzer 측 요청 사항

1. `refresh`에 impact 산출 포함 옵션(`--impact --git <repo>`) — **Phase 1 차단 요소**
2. RestDocs description을 OpenAPI operation의 `summary`/`description`에도 주입
3. Kafka 토픽 추출 커버리지 점검 (변수/상수/설정 참조 토픽명, `@KafkaListener` topics 배열)
4. (백로그) 다중 repo impact 병합, DB 테이블 매핑 커버리지 확대
