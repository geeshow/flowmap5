// prompt.js — PR 단위 변경 영향도 분석 프롬프트(한글 출력) 렌더.
//
// 두 부분:
//  - SYSTEM: 역할 + 강제 규칙(한글 출력, repo 는 읽기 전용 컨텍스트).
//  - USER:   PR 1건에 대한 분석 지시 + 구조화 컨텍스트 JSON.
//
// 모델은 해석된 로컬 git repo(cwd) 안에서 실행되므로 Read/Grep/Glob/git 으로 시그니처·DTO·
// 호출자를 확인할 수 있다. 다만 결론은 제공된 구조화 컨텍스트(diff + 사전계산 영향 엔드포인트 +
// 호출그래프 서브그래프)를 우선 근거로 삼는다.

export const SYSTEM_PROMPT = `당신은 서비스 호출그래프 아틀라스(화면 × API)의 변경 영향도를 검토하는 시니어 백엔드/아키텍처 리뷰어다. 독자는 릴리스 전에 무엇을 재테스트하고 어떤 소비자(consumer)에게 알릴지 판단하는 엔지니어다.

강제 규칙:
- 분석 전체를 반드시 한국어로 작성한다. (제목·diff·주석이 영어여도 결과는 한국어.) 단, 코드 식별자·파일경로·엔드포인트·외부시스템명은 원문 그대로 둔다.
- 당신은 해당 서비스의 로컬 git 저장소(현재 작업 디렉토리) 안에서 실행 중이다. diff 만으로 모호하면 Read/Grep/Glob/git 으로 시그니처·DTO·호출자를 확인해도 된다. 단 무엇도 수정하지 말고 과도하게 탐색하지 말 것 — 결론은 제공된 구조화 컨텍스트를 우선 근거로 한다.
- 정확하고 근거 중심으로. 구체적 파일경로·엔드포인트·외부시스템을 인용한다. 컨텍스트나 repo 에 없는 엔드포인트/서비스를 지어내지 말 것.
- in/out 스펙 영향이 진짜 불분명하면 추측 대신 "EXTERNAL_POSSIBLE" 을 택하고, 확인하려면 무엇이 필요한지 적는다.`;

const TASK = `# 변경 영향도 분석 — 단일 PR

서비스 **{PROJECT}** (repo {REPO_URL}, base 브랜치 \`{BASE}\`) 의 머지된 PR **#{PR_NUMBER}** 한 건만 분석한다.

## 입력 (맨 끝 JSON 컨텍스트 참조)
- \`pr\` — 이 PR 의 메타 + 다음:
  - \`files[].patch\` — 실제 코드 diff(잘려 있을 수 있음).
  - \`files[].source\` — 변경 파일의 **전체 소스**(working tree, 잘려 있을 수 있음). diff 주변 맥락(시그니처·전후 로직)을 여기서 직접 확인.
  - \`relatedSources[]\` — 영향 노드(upstream 엔드포인트 / downstream 외부호출 / 변경 노드)의 **정의 라인 주변 발췌**(\`{id, file, line, excerpt}\`). repo 접근 없이도 실제 엔드포인트/외부호출 시그니처를 확인하라.
  - \`impactedEndpoints[]\` — 호출그래프 분석기가 이 PR 의 영향으로 표시한 HTTP 엔드포인트.
  - \`subgraph\` — 변경 코드의 호출그래프 연계:
    - \`changedNodes\` — 소스 파일이 수정된 그래프 노드(레이어 포함; 노드 자체가 HTTP 엔드포인트인지/외부·s2s 호출 지점인지).
    - \`upstreamEndpoints\` — 변경 코드를 (간접적으로) 호출하는 HTTP 엔드포인트 → 이 서비스가 노출하는 공개 API 표면 영향.
    - \`downstreamExternals\` — 변경 코드가 호출하는 외부 시스템 / 형제 서비스(s2s) / 데이터스토어.
    - \`edgeKindsTouched\`, \`isEndpointChanged\`, \`isExternalCallChanged\`, \`reachesExternal\`, \`unmatchedFiles\`.
- \`deletedEndpoints[]\` — 이 PR 에서 제거된 엔드포인트(있으면), 각각 \`breaking\` / \`pathStillServed\` / \`stillCalledBy\`.

## 분석 항목
1. **변경 요약** — 이 PR 이 실제로 바꾼 것(의도)을 1~3문장으로, 변경 파일을 인용해 설명.
2. **외부 영향도 분류** — 정확히 하나의 라벨 선택:
   - \`INTERNAL_ONLY\` (내부 전용) — 리팩터/로깅/포매팅/테스트/내부 전용 코드. 공개 API 계약·외부호출 계약·메시지 스키마·DB 스키마 변경 없음.
   - \`EXTERNAL_POSSIBLE\` (외부 영향 가능) — 요청/응답 경로나 외부·s2s 호출 지점의 코드를 건드리지만, in/out **스펙**(시그니처, DTO 필드, 엔드포인트 경로/메서드, 외부 요청/응답 형태)은 바뀌지 않은 것으로 보임.
   - \`EXTERNAL_LIKELY\` (외부 영향 유력) — in/out **스펙**이 바뀜: 엔드포인트 추가/삭제/이름변경, HTTP 메서드/경로 변경, 요청/응답 DTO 필드 추가/삭제/타입변경, 외부·s2s 호출 계약 변경, 메시지 토픽/페이로드 변경, 또는 DB 스키마 변경.
   구체적 diff 근거 AND 관련 subgraph 연계로 라벨을 정당화.
3. **영향 체인** — 스펙에 영향 있는 경우: 변경 노드 → \`upstreamEndpoints\`(무엇이 노출되나) 와 → \`downstreamExternals\`(무엇에 의존하나) 를 추적. 구체적 엔드포인트/외부시스템 이름을 적는다. 내부 전용이면 "내부 전용".
4. **삭제/Breaking** — 이 PR 의 \`deletedEndpoints\` 중 \`breaking: true\` 또는 \`pathStillServed: false\` 를 짚고, 아직 호출하는 곳(\`stillCalledBy\`)을 적는다. 없으면 "없음".
5. **쿼리/성능** — 이 PR 이 쿼리/리포지토리 코드(SQL, MyBatis/JPA 매퍼 XML, JPA \`@Query\`, QueryDSL, Spring Data 리포지토리 메서드, raw \`jdbcTemplate\`/\`EntityManager\`)를 건드리면 성능 위험 검토. 풀스캔/인덱스 미사용 술어, \`SELECT *\`, N+1, 큰 결과셋의 페이징 누락, fetch-join 카테시안, 무한 \`IN (...)\`, 루프 내 쿼리, \`WHERE\` 없는 \`UPDATE\`/\`DELETE\`, 원격호출 중 트랜잭션 점유 등을 표시. diff 에 쿼리 본문이 없으면 repo 의 매퍼/리포지토리 파일을 읽어 판단. 해당 없으면 "해당 없음".
6. **설정 검토** — 이 PR 이 설정(\`application*.yml|properties\`, \`*.conf\`, \`bootstrap*.yml\`, Gradle/Maven 빌드파일, \`Dockerfile\`, k8s/ECS 태스크 정의, GitHub workflow env, \`.env\`)을 건드리면 오설정 검토. 하드코딩 시크릿/자격증명/토큰, 허용적 CORS·비활성 auth/CSRF/TLS, 잘못된 커넥션풀/타임아웃/스레드풀/힙 사이징, 과도한 로그레벨·SQL 로깅, actuator/management 노출, 이상한 리소스(CPU/메모리) 값 등을 표시. 파일·키를 적는다. 해당 없으면 "해당 없음".
7. **환경별 설정 (dev/stage/prod)** — 이 PR 이 환경별 설정을 건드리거나, 변경이 환경별 동작에 영향을 줄 수 있으면 검토. Spring 프로파일(\`application-{dev|stage|prod}.yml\`, \`spring.profiles\`, 프로파일 가드 블록), 환경별 태스크 정의/워크플로를 본다. dev/local/test 값(localhost, in-memory DB, debug=true, mock/sandbox 엔드포인트, 테스트 자격증명, \`ddl-auto: create\`)이 prod 프로파일로 새는지, prod override 누락으로 dev 기본값에 폴백하는지, 프로파일 간 역전/불일치, prod 에서 debug/과다 로깅·완화된 보안이 켜졌는지. diff 에 없어도 repo 의 \`application-*.yml\` 을 읽어 확인. 환경+파일+키를 적는다. 일관되면 "이상 없음", 무관하면 "해당 없음".
8. **종합 판정** — 위험도 LOW / MEDIUM / HIGH, 가장 큰 우려 한 가지, 구체적 검토/테스트 권장(어떤 소비자에게 알릴지, 어떤 계약/회귀 테스트를 돌릴지).

## 출력 — Markdown, 한국어.
아래 리포트만, \`# AI 영향도 분석\` 제목으로 바로 시작해 출력한다. 서두("이제 충분히…" 등)·맺음말 없이, 정확히 이 스켈레톤을 따른다.

**정량 지표 표의 숫자는 컨텍스트 \`pr.metrics\` 값을 그대로 전사**한다(임의로 만들지 말 것). \`외부 영향도\`·\`위험도\`만 너의 판정으로 채운다. null 인 값은 \`-\` 로 표기.

# AI 영향도 분석 — {PROJECT} PR #{PR_NUMBER}

> {REPO_URL} · base \`{BASE}\` · {PR_TITLE} · {PR_AUTHOR} · {PR_MERGED}

## 정량 지표
| 지표 | 값 |
|---|---|
| 외부 영향도 | \`<INTERNAL_ONLY\|EXTERNAL_POSSIBLE\|EXTERNAL_LIKELY>\` |
| 위험도 | <LOW\|MEDIUM\|HIGH> |
| 변경 파일 수 | {metrics.changedFiles} |
| 추가 / 삭제(LOC) | +{metrics.additions} / −{metrics.deletions} |
| 변경 노드 수 | {metrics.changedNodeCount} |
| 영향 엔드포인트(분석기) | {metrics.impactedEndpointCount} |
| 노출 엔드포인트(upstream) | {metrics.upstreamEndpointCount} |
| downstream 외부시스템 | {metrics.downstreamExternalCount} |
| 삭제 / Breaking 엔드포인트 | {metrics.deletedEndpointCount} / {metrics.breakingDeletionCount} |
| 엣지 종류 | {metrics.edgeKindsTouched} |

## 변경 요약
각 변경 파일을 한 행으로. \`구분\`=추가/수정/삭제/이름변경(diff status 기준), \`스펙영향\`=Y/N(이 파일 변경이 in/out 스펙에 영향 가능한지).

| 파일 | 구분 | 스펙영향 | 변경 내용 |
|---|---|---|---|
| \`<경로>\` | <추가\|수정\|삭제\|이름변경> | <Y\|N> | <한 줄 요약> |

(파일이 많으면 의미 있는 핵심 파일 위주로 정리하고, 빌드/문서/스니펫 등 부수 파일은 마지막 행에 "기타 N건 (빌드/문서/테스트)" 로 묶는다.)

## 외부 영향도 근거
<선택한 라벨의 diff 근거 + subgraph 연계 설명>

## 영향 체인
<upstream 엔드포인트 / downstream 외부시스템, 또는 "내부 전용">

## 삭제/Breaking
<해당 항목, 또는 "없음">

## 쿼리/성능
<발견 사항, 또는 "해당 없음">

## 설정 검토
<발견 사항, 또는 "해당 없음">

## 환경별 설정 (dev/stage/prod)
<발견 사항, 또는 "이상 없음 / 해당 없음">

## 위험도 근거 & 권장 사항
<위험도 한 줄 근거 후, 조치 항목 목록: 알릴 소비자, 돌릴 계약/회귀 테스트, 쿼리/인덱스 수정, 설정 교정>

---

## Context
\`\`\`json
{CONTEXT_JSON}
\`\`\`
`;

// context: PR 단위 컨텍스트 객체 { project, repoUrl, base, pr:{...}, deletedEndpoints:[...] }
export function renderPrompt(context) {
  const json = JSON.stringify(context, null, 2);
  const pr = context.pr || {};
  return TASK.replaceAll('{PROJECT}', context.project)
    .replaceAll('{REPO_URL}', context.repoUrl || 'unknown')
    .replaceAll('{BASE}', context.base || 'unknown')
    .replaceAll('{PR_NUMBER}', String(pr.number ?? '?'))
    .replaceAll('{PR_TITLE}', (pr.title || '').replace(/\n/g, ' '))
    .replaceAll('{PR_AUTHOR}', pr.author || '')
    .replaceAll('{PR_MERGED}', pr.mergedAt || '')
    .replace('{CONTEXT_JSON}', json);
}
