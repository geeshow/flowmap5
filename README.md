# flowmap

**Spring Kotlin/Java 마이크로서비스 호출관계 시각화 도구.**
정적 분석기(`call-graph-spring-kotlin`)가 추출한 메서드 단위 호출 그래프(node-link JSON)를
브라우저에서 탐색합니다 — 서비스 지도, API 드릴다운, 호출관계분석, 그리고 서비스 경계를 넘는
end-to-end 프로세스 흐름까지. 바닐라 JS 단일 페이지로 빌드/의존성이 없습니다.

| 문서 | 내용 |
|---|---|
| **[MANUAL.md](MANUAL.md)** | 사용자 매뉴얼 — 화면별 기능, 조작법, URL 파라미터, 데이터 파이프라인 |
| **[SCHEMA.md](SCHEMA.md)** | 데이터 계약 — 노드/엣지/레지스트리 전체 필드 정본 |
| **[RENDERING.md](RENDERING.md)** | 시각화 가이드 — 레이어 색, 선 종류, 머지 규칙 |

## 빠른 시작

```bash
# 1) 서비스별 그래프(graphs/*.json)를 하나로 머지 → docs/web/data/graph.json
python3 scripts/build.py

# 2) 정적 서버로 띄우기 (아무 정적 서버나 가능)
python3 -m http.server 8770
# → http://localhost:8770/docs/web/
```

데모 데이터(9개 서비스)가 포함되어 있어 바로 실행해 볼 수 있습니다.

## GitHub Pages 배포

이 저장소는 GitHub Pages로 바로 서비스됩니다.

1. 저장소 **Settings → Pages → Build and deployment → Source**를 `Deploy from a branch`로,
   **Branch**를 `main` / 폴더를 **`/docs`**로 설정합니다.
2. 게시되면 앱 주소는 **`https://<사용자>.github.io/<저장소>/web/`** 입니다
   (예: `https://geeshow.github.io/flowmap5/web/`).

`docs/.nojekyll`이 있어 Jekyll 가공 없이 정적 파일을 그대로 서빙합니다.
앱은 모두 상대 경로를 쓰므로 로컬 서버·Pages 어디서든 동일하게 동작합니다.

## 주요 기능

- **전체보기** — 서비스 간 S2S·이벤트·인프라 의존 지도. 호출 방향대로 좌→우 레이어 배치
- **서비스 보기** — 한 서비스의 전체 API와 피호출/호출 단계. 노드를 선택하면 연결된 체인만 남는 단계 필터
- **프로세스 흐름** — 선택한 체인 전체의 application 내부 실행 흐름을 화면 하단에 시각화.
  서비스 경계(S2S/Kafka)를 넘어 `controller → service → repository → infra → 다음 서비스 controller → …`로
  컬럼이 오른쪽으로 이어지고, sync(실선)/async(점선) 구분과 hover 연결 강조 지원
- **호출관계분석** — 임의 노드 기준 피호출 ← 노드 → 호출 그래프 (깊이 조절, 내부 프로세스 트리)
- **검색** — 메서드/클래스/엔드포인트/한글 설명으로 전체 노드 검색
- **공유 링크** — 모든 화면 상태가 URL에 동기화되어 그대로 공유 가능

## 디렉토리

```
flowmap/
├── README.md           # (이 파일) 개요
├── MANUAL.md           # 사용자 매뉴얼
├── SCHEMA.md           # 데이터 계약
├── RENDERING.md        # 시각화 가이드
├── registry.json       # 크로스-런 카탈로그 (서비스 노출 엔드포인트 / Kafka producer·consumer)
├── graphs/
│   └── <service>.json  # 서비스별 node-link 그래프 (분석기 산출물)
├── scripts/
│   └── build.py        # graphs/*.json 머지 → docs/web/data/graph.json
└── docs/web/                # 시각화 웹 앱 (바닐라 JS, 의존성 없음)
    ├── index.html
    ├── app.js
    ├── style.css
    └── data/graph.json # build.py 출력 (렌더러의 유일한 입력)
```

## 데이터 흐름

```
call-graph-spring-kotlin (정적 분석)
        │  서비스마다 1회 실행, registry.json 공유로 S2S/Kafka 누적 매칭
        ▼
graphs/<service>.json  ──  scripts/build.py (id 기준 union 머지)  ──▶  docs/web/data/graph.json
                                                                         │
                                                                         ▼
                                                                   docs/web/ (브라우저 렌더링)
```

노드 `id`(예: `com.acme.user.UserController#getUser`, `kafka:order.created`)가
**서비스 경계를 넘는 조인 키**라서, 파일들을 union 하는 것만으로 S2S·Kafka 연결이 이어집니다.

## 산출물 재생성

분석기 repo에서 서비스마다 실행합니다. 같은 `registry.json`을 공유하면 따로 분석해도 연결됩니다.

```bash
cd ../call-graph-spring-kotlin
REG=../flowmap/registry.json
G=../flowmap/graphs
# provider 먼저 → 호출자 나중 (S2S가 누적 매칭됨)
python3 -m callgraph analyze --repo .repo --project user-service  --registry $REG --out $G/user-service.json
python3 -m callgraph analyze --repo .repo --project order-service --registry $REG --out $G/order-service.json
# ... 서비스 추가 시 같은 식으로. 재분석하면 해당 서비스 그래프와 레지스트리 항목이 upsert 됨.

cd ../flowmap && python3 scripts/build.py   # 웹 데이터 갱신
```

- API 한글 설명을 붙이려면 분석 시 `--restdocs <generated-snippets dir>` 추가
- 분석기 자체 문서: `../call-graph-spring-kotlin/callgraph/README.md`

## 포함된 데모 서비스 (9개)

`user-service`, `order-service`, `notification-service`, `sample-shop`,
`admin-portal`, `twice-api`, `funding-service`, `bank-broker`, `tera-cloud-user` —
이들 간 S2S/Kafka 연결이 그래프에 들어 있습니다.
