# 작업 인수인계 (2026-06-14)

> flowmap 웹앱(`docs/web/`) 디자인 리뉴얼 + 커밋/PR 영향도 개선 진행 중.
> CLI에서 이어받을 때 이 파일부터 읽으면 됩니다. (작업 끝나면 삭제해도 됩니다.)

## 지금까지 한 일
1. **커밋 목록(영향도 레일) 개선** — 체크박스 제거, 클릭 시 스크롤 위치 유지, 날짜별 그룹 타임라인(점+세로선), 프로젝트 색 칩, `↗` 저장소 링크 버튼.
2. **커밋 링크** — impact.json의 `commitUrl`을 그대로 사용(없으면 `repoUrl + /commit/<sha>` 폴백).
3. **PR 스키마 지원** — `tera-cloud-user.impact.json`이 PR 기반(`pulls`/`base`/`pullCount`)으로 바뀜. `normalizePart()`가 PR→커밋 형태로 정규화(표시 `#219`, URL키 `PR219`, 링크 `/pull/219`).
4. **전역 라이트 테마** — `:root` 토큰을 라이트로, 하드코딩 다크색(#0b1220 등)을 토큰으로 치환, 노드 카드 흰색화, 흰 글자 깨짐 보정.
5. **좌측 사이드바 + 통계** — 상단 가로탭 → 좌측 세로 네비(브랜드/F로고 + 전체보기·커밋영향도·API문서) + 하단 통계(API·화면·서비스·노드·관계). `renderSidebarStats()`.
6. **통계 숫자 카드** — 커밋 미선택 집계 화면 상단에 "○○ — 변경 영향도" 타이틀 + 색상 숫자 카드 5개.
7. **서비스 색상 체계** — 전체보기 서비스 카드마다 고유 색(좌측 보더 + 점). `serviceHue()`(app.js) = `projectHue()`(impact.js) 동일 FNV-1a → 뷰 간 색 일치.

## ⚠️ 캐시 버스팅 규칙 (중요)
정적 자산은 버전 쿼리로 캐시 관리. **코드 고치면 반드시 버전 올릴 것**, 안 그러면 브라우저가 옛 파일을 씀.
- `docs/web/index.html`: `style.css?v=NN`, `app.js?v=NN`
- `docs/web/app.js`: `const FEATURE_VER = 'NN'` (← `features/impact.js`·`impact.css` 등 기능 모듈 캐시키)
- **현재 값**: style.css `v=53`, app.js `v=75`, FEATURE_VER `22`

## 핵심 파일
- `docs/web/index.html` — 레이아웃(사이드바/메인컬럼), 버전
- `docs/web/style.css` — 전역 테마·사이드바·노드카드
- `docs/web/app.js` — 그래프 로딩/전체보기/서비스색(`serviceHue`)/사이드바 통계(`renderSidebarStats`)
- `docs/web/features/impact.js` — 커밋/PR 영향도(`normalizePart`, `commitCard`, `renderAggregate`, `projectHue`)
- `docs/web/features/impact.css` — 타임라인·통계카드·집계 스타일

## 데이터 상태 (바뀜 주의)
- `docs/web/data/`는 더 이상 .gitignore 안 됨(추적됨).
- 현재 impact 데이터는 **`tera-cloud-user`만** 존재(PR 기반 50건). `tera-cloud-gateway.impact.json`은 디스크·manifest에서 제거됨 → 변경이력 50건은 정상.
- 두 스키마 공존 가능: 커밋 기반(`commits`/`branch`) + PR 기반(`pulls`/`base`). `normalizePart`가 흡수.

## 프리뷰 / 검증
- dev server: `.claude/launch.json`의 `flowmap` (포트 8770). 정적 서버라 파일 저장 후 새로고침이면 반영(버전만 올리면 됨).
- 확인 화면: `?view=overview`, `?view=commits`, `?view=api`.

## 남은 일 (사진 = apimap "FLOW MAP v4" 기준)
- [ ] **완전한 PR Impact Flow 뷰**: 배포→PR→변경API→영향레포를 좌→우 다단 컬럼 + 곡선 연결(포스graph). 현재는 통계카드 요약만 들어감.
- [ ] 서비스 색 **범례 드롭다운**(상단 "서비스 N ▾" + 모두선택/해제 필터). 지금은 카드 색이 범례 역할.
- [ ] (선택) 레일/집계의 "커밋" 용어를 데이터에 따라 "PR"로 동적 표기.
