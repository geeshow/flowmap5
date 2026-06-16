# flowmap

**마이크로서비스 호출관계 시각화 도구.**
3개 정적 분석기(`flowmap-spring`·`flowmap-nexcore`·`flowmap-react`)가 추출한 메서드 단위
호출 그래프(node-link JSON)를 브라우저에서 탐색합니다 — 서비스 지도, API 드릴다운,
호출관계분석, 그리고 서비스 경계를 넘는 end-to-end 프로세스 흐름까지. 바닐라 JS 단일
페이지로 빌드/의존성이 없습니다.

| 문서 | 내용 |
|---|---|
| **[MANUAL.md](MANUAL.md)** | 사용자 매뉴얼 — 화면별 기능, 조작법, URL 파라미터, 데이터 파이프라인 |
| **[SCHEMA.md](SCHEMA.md)** | 데이터 계약 — 노드/엣지/레지스트리 전체 필드 정본 |
| **[RENDERING.md](RENDERING.md)** | 시각화 가이드 — 레이어 색, 선 종류, 머지 규칙 |

## 설정 (필수)

분석 파이프라인(`sh/run-all.sh`)을 돌리려면 **각 분석기 디렉터리**에서
`flowmap.config.example` → `flowmap.config` 로 복사한 뒤 분석 대상을 지정한다.
모든 `flowmap.config`(real)은 **머신별 설정이라 gitignore 대상**이고, 템플릿
`flowmap.config.example` 만 추적된다(네 프로젝트 모두 동일 규칙).

| 프로젝트 | 꼭 설정할 키 |
|---|---|
| `flowmap-spring` | `REPO` (백엔드 소스 루트) |
| `flowmap-nexcore` | `REPO` (NEXCORE 소스 루트) |
| `flowmap-react` | `REPO` (프론트 소스 루트), `BACKEND` (`_combined.json` CSV) |
| `flowmap5`(루트) | 보통 불필요 — 분석기 위치/`FRONTEND_DIR` override 시에만 |

```bash
# 각 분석기에서 (필수)
for d in flowmap-spring flowmap-nexcore flowmap-react; do
  cp "$d/flowmap.config.example" "$d/flowmap.config"   # REPO 등 값 작성
done
# 루트(선택): 분석기 위치/경로 override 가 필요할 때만
cp flowmap.config.example flowmap.config

# 전체 파이프라인 실행
./sh/run-all.sh
```

## 빠른 시작

웹 데이터(`docs/web/data/`)는 저장소에 포함되어 있어 **분석 없이 바로** 띄울 수 있습니다.

```bash
# 정적 서버로 docs/web 을 서빙 (아무 정적 서버나 가능)
python3 -m http.server 8770 --directory docs/web
# → http://localhost:8770/
```

데이터를 새로 뽑으려면 분석 파이프라인을 돌립니다(위 **설정** 완료 후):

```bash
./sh/run-all.sh   # 3개 분석기 → json/projects/ → sync → docs/web/data/manifest.json
```

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
- **커밋/PR 영향도**(`?view=commits`) — 변경이력(커밋·PR)이 닿는 영향 그래프. 공개 메서드 기준
  역방향 추적으로 영향받는 엔드포인트/화면을 산출, 변경→영향 경계 투영
- **배포 영향도**(`?view=deploy`) — 년도→일별 배포→PR. 진입 시 첫 배포·첫 PR이 선택되고, PR을 고르면
  그 PR의 커밋 영향도가 같은 화면 하단에 임베드됨(커밋 영향도 컴포넌트 재사용)
- **검색** — 메서드/클래스/엔드포인트/한글 설명으로 전체 노드 검색
- **공유 링크** — 모든 화면 상태가 URL에 동기화되어 그대로 공유 가능

## 디렉토리

```
flowmap5/
├── README.md           # (이 파일) 개요
├── MANUAL.md           # 사용자 매뉴얼
├── SCHEMA.md           # 데이터 계약
├── RENDERING.md        # 시각화 가이드
├── sh/                 # 파이프라인 오케스트레이션 (run-all.sh + 단계 스크립트)
├── flowmap-spring/     # 분석기 ① Spring Kotlin/Java (자체 json/ 산출)
├── flowmap-nexcore/    # 분석기 ② NEXCORE
├── flowmap-react/      # 분석기 ③ React/프론트
└── docs/web/                    # 시각화 웹 앱 (바닐라 JS, 의존성 없음)
    ├── index.html  app.js  style.css  features/
    └── data/                    # 렌더러 입력 (sync 산출)
        ├── manifest.json        # 프로젝트 카탈로그 (렌더러의 진입점)
        └── projects/<name>/     # 프로젝트별 graph/openapi/impact (+ 지연로드 샤드)
```

## 데이터 흐름

```
3개 분석기 (flowmap-spring · flowmap-nexcore · flowmap-react)
        │  각자 자기 json/ 에 프로젝트별 산출물(projects/<name>/ · service/ · frontend/)
        ▼
sh/run-all.sh → sync (flowmap-spring 의 sync 가 세 json/ 를 한 번에 취합)
        │  모든 프로젝트를 docs/web/data/projects/<name>/<name>.* 로 통합 + manifest.json 재생성
        ▼
docs/web/ (브라우저 렌더링 — manifest.json 로드 후 프로젝트별 그래프 병합)
```

노드 `id`(예: `com.acme.user.UserController#getUser`, `kafka:order.created`)가
**서비스 경계를 넘는 조인 키**라서, 프로젝트 그래프들을 union 하는 것만으로 S2S·Kafka 연결이 이어집니다.

### 모노레포 분리 (`wallga.yml`)

한 git 저장소가 여러 배포 단위를 묶은 모노레포라면, 저장소 루트의 `wallga.yml`
(`advanced.sub_project.projects.*` 의 `project_name` + `build.path`)로 경계를 재정의해
**각 sub-project 를 독립 프로젝트로** 분석합니다(자세한 내용은 `flowmap-spring/README.md`).

## 산출물 재생성

```bash
# 전체 (권장): 3개 분석기 pull→analyze→openapi→impact→combine + sync + verify
./sh/run-all.sh

# 분석기 하나만: 각 분석기 디렉터리에서 (flowmap.config 기준 zero-arg 실행)
cd flowmap-spring && ./gradlew run      # → flowmap-spring/json/projects/<name>/
```

- 각 분석기는 프로젝트별 산출물을 자기 `json/` 에 쓰고, **sync** 단계가 셋을
  `docs/web/data/` 로 취합합니다(`flowmap-spring/MANUAL.md` 의 sync/manifest 규약 참고).
- API 한글 설명을 붙이려면 분석 대상에 REST Docs `generated-snippets` 가 있으면 자동 반영됩니다.
- 분석기별 상세 문서: `flowmap-spring/README.md` · `flowmap-react/README.md` · `flowmap-nexcore/README.md`

## 포함된 데모 데이터 (23개 프로젝트)

샘플 그래프가 포함되어 있어 분석 없이 바로 탐색할 수 있습니다. S2S/Kafka·프론트→백엔드 join 연결이 들어 있습니다.

- **백엔드 (19)** — Spring: `user-service`·`order-service`·`notification-service`·`sample-shop`·`admin-portal`·
  `twice-api`·`funding-service`·`bank-broker`·`shopflow`·`tera-cloud-gateway`·`tera-cloud-user`,
  `wallga.yml` 분할(`tera-terafi` → `trf-loan`·`trf-member`·`trf-credit`·`trf-statis`·`trf-gateway`),
  NEXCORE: `acc-app-ac`·`acc-app-bc`·`acc-bat-ac`
- **프론트엔드 (4)** — `front-official-desktop`·`shopflow-web`·`sample-shop-react`·`sample-shop-nuxt`
