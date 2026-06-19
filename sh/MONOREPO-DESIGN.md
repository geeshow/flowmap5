# 모노레포(멀티 모듈) pulls/impact 구조 정리 — 설계/작업 메모

> 목표: **모듈 단위 graph 폴더는 유지**하되, **pulls·impact 는 모노레포(git repo) 단위 1벌**로 두고,
> 그 단위로 PR/impact 분석을 돌린다. 웹(flowmap5)은 `manifest.repo` 마커로 모듈↔repo 를 잇는다.

## 1. 표준 manifest 계약 (세 분석기 공통)

한 모노레포 `R`(예: `tera-terafi`)은 manifest 에 다음과 같이 들어가야 한다.

| 엔트리 | name | repo | graph | openapi | pulls | impact | 비고 |
|---|---|---|---|---|---|---|---|
| 모듈들 | `trf-credit` 등 (`≠R`) | `R` | ✅ | ✅(백엔드) | – | – | 모듈별 호출그래프 |
| repo 엔트리 | `R` | `R` | **null** | – | ✅ | ✅ | repo 단위 PR/impact 1벌 |

- 모듈 노드의 `node.project = 모듈명`, `node.module`(gradle 모듈 등) 보조.
- impact/pulls 의 PR 은 repo 전체에서 1번씩만 집계(모듈로 쪼개지 않음). 변경 노드 id 는 모듈 그래프의
  노드를 가리키므로 웹이 모듈로 귀속할 수 있다.
- **단일 graph 모노레포 변형**(현재 react `front-official-desktop`)은 `name===repo` 1엔트리(graph+impact)도 허용.
  이 경우 웹의 모듈 분해는 `manifest.modules`/`node.module` 로 처리.

## 2. 분석기별 현황 → 작업 (이 세션: 설계만)

### flowmap-spring (Kotlin) — ✅ 이미 표준
- `cmdRefresh` 가 `projects.groupBy { it.monorepo }` 로 묶어 **monorepo 단위 ImpactTarget 1개** 생성
  → `projects/<R>/<R>.impact.json` (graph 없는 폴더). `Cli.kt:711-714`, `:564`
- 모듈 그래프 meta 에 `gitRepo=R` 기록 → manifest `repo`. `Cli.kt:643`, `Manifest.kt:78-115,154-180`
- **레퍼런스 구현**. 나머지 둘을 여기에 맞춘다.

### flowmap-nexcore (Java) — ✅ 구현 완료 (clean 컴파일 + test 통과, 단 실 repo 대상 E2E 미검증)
- `../nexcore` 단일 git repo 아래 모듈(top-level `src/main/java` 디렉터리)을 분석하는 구조였고, 기존엔
  **모듈별 impact**(`service/<module>/impact.json`). 모노레포 단위로 전환:
  1. `Cli.refresh`: 모듈 2개 이상이면 모노레포로 판정, `gitRepoMark = git.repoName()`(work-tree 이름).
  2. 각 모듈 그래프 `meta.gitRepo = R` 기록(모노레포 마커).
  3. impact 는 **`_combined.json`(전 모듈 병합 그래프) 기준 repo 1회** → `service/<R>/impact.json`
     (graph 없는 repo 엔트리). impactedEndpoints 의 `service`=노드 project(=모듈)라 웹이 모듈로 귀속.
  4. `built` 에 R 추가 → sync/manifest 가 repo 엔트리 포함.
  - `GitLog.repoName()`(= `git rev-parse --show-toplevel` basename) 추가.
  - `Manifest`: 모듈 엔트리에 `repo`(meta.gitRepo) 필드 + graph 없는 `service/<R>/impact.json` →
    `impactOnlyEntry`(name===repo, graph=null) 추가. `builtProjects` 가 impact-only 디렉터리도 포함.
  - 단일 모듈(standalone)은 기존대로 모듈별 impact + `repo=null`.
  - **의존(확인 완료)**: 파이프라인 최종 취합 spring `sync`(step 12)의 `Sync.collectProjects`/`canonicalName`
    이 graph 없이 `impact.json` 만 있는 `service/<R>/` 도 `projects/<R>/<R>.impact.json` 으로 복사하고
    (주석에 "bare openapi.json/impact.json (nexcore)" 명시), spring `Manifest` 가 graph meta `gitRepo`→`repo`,
    graph 없는 impact→repo 엔트리를 만든다. → nexcore 출력과 호환됨.

### flowmap-react (TS) — ✅ 구현 완료 (tsc + vitest 159 통과, 실 repo E2E 미검증)
- 이미 갖춰진 것: `cmdAnalyze` 가 root(앱/패키지)별 graph 를 `<svc>/graph.json` 로 emit + meta `gitRepo=R`
  (`cli.ts:243-290`), `impact-repos` 가 git work tree 단위로 impact 1회(`cli.ts:788-831`).
- 표준 정렬로 바꾼 것:
  1. `cmdImpactRepos`: impact 를 대표 sub-root 가 아니라 **git work tree 이름 폴더**
     `<out-dir>/<R>/<base>.impact.json`(graph 없는 repo 폴더, +샤드)로 기록. 다른 sub-root 의 이전 impact 정리.
     단일 root 면 폴더명이 같아 기존과 동일(single-graph 변형).
  2. `jsonOutput.writeManifest`: graph 없는 `<R>/` (impact 만 있는 폴더)를 **impact-only repo 엔트리**
     (repo===name, graph=null)로 추가 → spring/nexcore 와 동일 shape.
  - 결과: 모듈(sub-root) 엔트리(graph, repo=R) + repo 엔트리(graph=null, repo=R, impact). 웹
    `mapRepoToService(R)` 가 정확매칭, `touchedServicesFor` 가 모듈 전체 touched.

## 3. 파이프라인(sh/) — 구조 변경 거의 없음
- 폴더 구조는 **분석기가 산출**한다. `sh/` 는 오케스트레이션만 → 본 작업으로 인한 sh 변경 불필요.
- 단 `12-sync.sh`(spring `sync`)가 `service/`·`frontend/` 폴더 그룹을 그대로 취합하므로,
  nexcore/react 가 `service/<R>/<R>.impact.json` 형태(graph 없는 repo 폴더)를 내보내면
  sync 가 그대로 `docs/web/data/projects/<R>/` 로 옮기고 manifest 에 repo 엔트리를 만든다(추가 작업 없음).
  → **검증 포인트**: sync 가 graph 없는 repo 폴더의 impact/pulls 를 누락 없이 복사하는지 확인 필요
  (`Sync.kt` `isArtifact`/`collectProjects` 가 impact/pulls/shard 디렉터리를 포함하는지).

## 4. 웹(flowmap5 docs/web) — 이번 세션 반영/검토

- ✅ **deploy.js**: 모노레포 배포 시 서비스 영향도 그래프가 graph 없는 repo 엔트리(`tera-terafi`) 하나만
  touched 로 잡아 **빈 카드/연결 0** 이 되던 문제 수정. `modulesOfRepo(repo)`/`touchedServicesFor(tk)` 로
  **모듈 서비스 전체**(graph 보유, repo===R, name≠R)를 touched 로. pulls/impact 조회는 종전대로 대표(repo 엔트리).
- ✅ **impact.js**: repo 엔트리(`R`)의 impact 를 그대로 로드(이미 동작). 커밋 칩 `_project=R`(모노레포명)로 표기.
  그래프는 변경 노드 id 의 `node.project`(모듈)로 서비스 박스 귀속 → 모듈 단위로 정상 분해.
- ✅ **app.js join/overview**: `monorepoOf`/`decomposeModulesOf` 가 `manifest.repo` 로 모듈 분해.
  `superId` 는 `node.project`(모듈) 기준이라 모듈이 서비스로 각각 표시(모노레포 내 s2s/모듈간 호출 보임).
- 잔여 검토(데이터 들어오면): nexcore/react repo 엔트리가 표준대로 들어오면 위 경로가 그대로 적용됨.
  단일 graph 변형(`name===repo`)도 `touchedServicesFor` 가 대표 1개로 폴백하므로 안전.

## 5. 검증 체크리스트
- [ ] nexcore/react 가 `service|frontend/<R>/<R>.impact.json`(+`.pulls.json`, shard dir) 산출, 모듈 graph meta `gitRepo=R`.
- [ ] `sync` 후 `manifest.json` 에 repo 엔트리(graph null, impact/pulls) + 모듈 엔트리(graph, repo=R) 동시 존재.
- [ ] 웹 배포 영향도: 모노레포 배포 → 서비스 그래프에 **모든 모듈** 서비스가 touched 로 표시, 연관선 보임.
- [ ] 웹 커밋 영향도: repo PR 선택 → 변경이 닿은 **모듈별** 서비스 박스로 분해, 1/2/3차 동작.
