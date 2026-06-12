# flowmap 데이터 계약 (SCHEMA)

렌더러가 의존하는 산출물 스키마의 **정본**입니다. 모든 값은 실제 산출물에서 가져온 예시입니다.

---

## A. 그래프 JSON — `graphs/<service>.json`

### 최상위 봉투

```jsonc
{
  "directed": true,        // 방향 그래프
  "multigraph": true,      // 두 노드 사이에 여러 엣지 가능(relation이 다름)
  "meta": { ... },         // 실행 메타데이터
  "nodes": [ MethodNode, ... ],
  "edges": [ CallEdge, ... ]
}
```

`meta` 키: `command`(analyze/search/stats), `repo`, `project`, `files`, `nodes`, `edges`
(search일 때 추가: `query`, `roots`, `direction`, `depth`).

### MethodNode (노드)

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | **고유 ID이자 서비스 경계를 넘는 조인 키** (형식은 아래 표) |
| `fqcn` | string | 패키지 포함 클래스명 (리소스 노드는 ID와 동일한 식별자) |
| `method` | string | 메서드명 (리소스 노드는 라벨: 토픽/테이블/`Redis`/`JDBC`) |
| `layer` | enum | `CONTROLLER`·`SERVICE`·`REPOSITORY`·`COMPONENT`·`CONFIG`·`BATCH`·`EXTERNAL`·`RESOURCE`·`OTHER` |
| `visibility` | string | `public`·`private`·`protected`·`internal` |
| `async` | bool | 비동기 메서드 여부 (`suspend`/`@Async`/`@Scheduled`/reactive 반환) |
| `returnType` | string \| null | 반환 타입(제네릭 제거 단순명) |
| `httpMethod` | string \| null | 엔드포인트/외부/S2S 노드의 HTTP 메서드 (`GET`/`POST`/…/`ANY`) |
| `endpoint` | string \| null | 컨트롤러: 풀 URL 경로 / 외부·S2S: 대상 경로 |
| `externalService` | string \| null | **EXTERNAL 노드**: Feign client name 또는 클라이언트 타입 |
| `externalUrl` | string \| null | **EXTERNAL 노드**: 전체 외부 URL(`${...}` placeholder 가능) |
| `resourceType` | string \| null | **RESOURCE 노드**: `kafka-topic` / `redis` / `db-table` |
| `description` | string \| null | API 한글 설명(REST Docs 연동 시). S2S 타깃에도 전파됨 |
| `file` | string \| null | 선언 위치(repo 상대경로). **다른 서비스 그래프에선 스텁이라 null일 수 있음** |
| `line` | int \| null | 선언 라인(1-based) |
| `project` | string \| null | 출처 서비스 = `.repo/<project>`. **노드 그룹핑·색칠의 기준** |
| `module` | string \| null | 출처 모듈(없으면 `src` 등으로 거칠게 나올 수 있음) |

#### 노드 ID 형식 (조인 키)

| 종류 | `id` 예시 | layer |
|---|---|---|
| 내부 메서드 | `com.acme.order.OrderService#placeOrder` | SERVICE 등 |
| 컨트롤러 엔드포인트 | `com.acme.order.OrderController#create` | CONTROLLER |
| 외부(3rd-party) | `ext:RestTemplate#postForObject` | EXTERNAL |
| S2S 타깃(=provider의 컨트롤러 노드) | `com.acme.user.UserController#getUser` | CONTROLLER |
| Kafka 토픽 | `kafka:order.created` | RESOURCE |
| DB 테이블 / JDBC | `db:table:orders` / `db:jdbc` | RESOURCE |
| Redis | `redis` | RESOURCE |

#### 실제 예시

컨트롤러 엔드포인트:
```json
{ "id": "com.acme.order.OrderController#create", "fqcn": "com.acme.order.OrderController",
  "method": "create", "layer": "CONTROLLER", "visibility": "public", "async": false,
  "returnType": "OrderResponse", "httpMethod": "POST", "endpoint": "/orders",
  "externalService": null, "externalUrl": null, "resourceType": null, "description": null,
  "file": "order-service/src/main/kotlin/com/acme/order/OrderController.kt", "line": 14,
  "project": "order-service", "module": "src" }
```

Kafka 토픽(RESOURCE, 서비스 간 공유 노드):
```json
{ "id": "kafka:order.created", "fqcn": "kafka:order.created", "method": "order.created",
  "layer": "RESOURCE", "resourceType": "kafka-topic", "project": null, "file": null, ... }
```

외부 API(EXTERNAL, 매칭 안 된 3rd-party):
```json
{ "id": "ext:RestTemplate#postForObject", "fqcn": "RestTemplate", "method": "postForObject",
  "layer": "EXTERNAL", "externalService": "RestTemplate", "externalUrl": null,
  "project": "notification-service", ... }
```

설명 달린 엔드포인트(REST Docs):
```json
{ "...": "UserController#getUser", "httpMethod": "GET", "endpoint": "/internal/users/{id}",
  "description": "사용자 단건 조회 (내부용)" }
```

### CallEdge (엣지)

| 필드 | 타입 | 설명 |
|---|---|---|
| `source` | string | 호출자 노드 `id` |
| `target` | string | 피호출자 노드 `id` |
| `mode` | enum | `sync` / `async` |
| `kind` | enum | `internal`·`external`·`s2s`·`batch`·`resource` (아래 표) |
| `relation` | string | 세부 관계 (아래 표) |
| `callSiteFile` | string \| null | 호출 지점 파일 |
| `callSiteLine` | int \| null | 호출 지점 라인 |

#### `kind` 의미

| `kind` | 뜻 | `target` 노드 |
|---|---|---|
| `internal` | 같은 서비스 내부 호출 | 같은 project의 메서드 |
| `external` | 매칭 안 된 3rd-party 호출 | `ext:...` (EXTERNAL) |
| `s2s` | **분석된 다른 서비스로의 호출** | 그 서비스의 컨트롤러 노드(다른 project) |
| `batch` | 스프링 배치 와이어링 | 같은 config의 Job/Step/… |
| `resource` | Kafka/Redis/DB 사용 | `kafka:`/`db:`/`redis` (RESOURCE) |

#### `relation` 값

`call` · `batch:step`·`batch:reader`·`batch:processor`·`batch:writer`·`batch:tasklet`·`batch:listener`
· `kafka:produce`·`kafka:consume` · `redis:io` · `db:io`

#### 실제 예시

```json
// S2S: order-service -> user-service (kind=s2s, target은 user의 컨트롤러 노드)
{ "source": "com.acme.order.OrderService#placeOrder",
  "target": "com.acme.user.UserController#getUser",
  "mode": "sync", "kind": "s2s", "relation": "call",
  "callSiteFile": "order-service/.../OrderService.kt", "callSiteLine": 16 }

// Kafka produce (async). 같은 kafka:order.created 노드로 consumer 엣지와 이어짐
{ "source": "com.acme.order.OrderService#placeOrder", "target": "kafka:order.created",
  "mode": "async", "kind": "resource", "relation": "kafka:produce", ... }

// DB
{ "source": "com.acme.order.OrderRepository#save", "target": "db:table:orders",
  "mode": "sync", "kind": "resource", "relation": "db:io", "callSiteLine": null }

// Redis
{ "source": "com.acme.order.OrderService#placeOrder", "target": "redis",
  "mode": "sync", "kind": "resource", "relation": "redis:io", ... }
```

> 엣지 식별(중복 제거) 키 = `(source, target, relation, callSiteLine)`.

---

## B. 레지스트리 JSON — `registry.json`

여러 분석 실행에 걸쳐 누적되는 카탈로그. 새 서비스를 분석하면 여기 등록된 기존 서비스와
자동으로 S2S/Kafka 연결됩니다(연결 결과는 각 그래프 파일에 이미 반영됨).

```jsonc
{
  "version": 1,
  "services": { "user-service": {}, "order-service": {}, ... },   // 분석된 서비스 집합
  "endpoints": [                                                  // 서비스가 노출하는 HTTP API
    { "project": "user-service",
      "nodeId": "com.acme.user.UserController#getUser",
      "fqcn": "com.acme.user.UserController", "method": "getUser",
      "httpMethod": "GET", "endpoint": "/internal/users/{id}",
      "description": "사용자 단건 조회 (내부용)" }
  ],
  "kafka": {                                                      // 토픽별 producer/consumer
    "order.created": {
      "producers": [ { "project": "order-service", "nodeId": "...#placeOrder",
                       "fqcn": "...", "method": "placeOrder", "layer": "SERVICE" } ],
      "consumers": [ { "project": "notification-service", "nodeId": "...#onOrderCreated",
                       "fqcn": "...", "method": "onOrderCreated", "layer": "COMPONENT" } ]
    }
  }
}
```

- `endpoints[].nodeId` = 그래프의 컨트롤러 노드 `id`와 동일 → 레지스트리↔그래프를 join 가능.
- `kafka[topic].producers/consumers[].nodeId` = 그래프의 producer/consumer 노드 `id`와 동일.

### S2S 매칭 규칙 (분석기 내부 동작, 참고용)

Feign 호출 `(httpMethod, path)`를 `endpoints`와 비교 — path는 `{var}`→`{}` 정규화
(`/users/{id}` == `/users/{userNo}`). 후보 여럿이면 Feign `name`이 provider `project`와
같은 것을 우선, 아니면 경로 유일 후보를 채택. 매칭되면 그래프에 `kind:"s2s"` 엣지로 생성.
**렌더러는 이 규칙을 알 필요 없음** — 이미 그래프 엣지로 들어있음.

---

## C. enum 전체 목록 (렌더러 switch용)

```
Layer  : CONTROLLER SERVICE REPOSITORY COMPONENT CONFIG BATCH EXTERNAL RESOURCE OTHER
EdgeKind: internal external s2s batch resource
CallMode: sync async
resourceType: kafka-topic redis db-table
relation: call
          batch:step batch:reader batch:processor batch:writer batch:tasklet batch:listener
          kafka:produce kafka:consume redis:io db:io
```
