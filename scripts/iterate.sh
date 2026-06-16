#!/usr/bin/env bash
# 한 번의 반복(iteration): 실제 파이프라인 명령으로 산출물을 만들고 연결성을 검증한다.
#   1) flowmap-spring: ./gradlew run (refresh, NO sync) — analyze + combine(_combined.json) + impact + manifest
#   2) flowmap-react:         ./flowmap pipeline                — analyze + screens + join (FRESH _combined 로 직접매칭)
#   3) flowmap-spring: ./gradlew run (sync)             — web data 조립(+떠난/stale prune +manifest)
#   4) flowmap:               node tests/check-connectivity.mjs
#
# 순서가 핵심이다 (양방향 의존):
#   - react join 은 spring 의 _combined.json 을 읽으므로 spring combine 이 먼저여야 하고(1 < 2),
#   - spring sync 는 react 가 만든 fresh graph-<root>.* 를 web data 로 조립/prune 하므로 react 뒤여야 한다(2 < 3).
# 그래서 spring 은 두 번 실행된다: [1] refresh(sync 제외) → [3] sync(standalone).
# 단순 `cp` 대신 standalone `sync` 를 쓰는 이유: cp 는 떠난(리네임된) per-root 파일 prune 도, manifest
# 재생성도 하지 않아 유령 프로젝트가 남는다. sync 는 둘 다 한다.
# refresh 는 반복 속도/오프라인 결정성을 위해 git pull 은 건너뛰고(--no-pull), PR 은 최근 2건만 본다(--impact-max 2).
set -uo pipefail
RA=/Users/kyutaepark/study/flowmap-react
SK=/Users/kyutaepark/study/flowmap-spring
FM=/Users/kyutaepark/study/flowmap

echo "================ [1/4] spring: refresh (NO sync) — _combined.json + impact(2 PRs) ================"
( cd "$SK" && ./gradlew --console=plain --quiet run --args="refresh --repo .repo --out-dir json --no-pull --impact-max 2" ) \
  || { echo "❌ spring refresh FAILED"; exit 2; }

echo "================ [2/4] react: ./flowmap pipeline (reads spring _combined.json) ================"
( cd "$RA" && ./flowmap pipeline ) || { echo "❌ react pipeline FAILED"; exit 2; }

echo "================ [3/4] spring: sync — assemble web data from FRESH artifacts (+prune +manifest) ================"
( cd "$SK" && ./gradlew --console=plain --quiet run --args="sync --out-dir json --sync-dir ../flowmap/docs/web/data --frontend-dir ../flowmap-react/json" ) \
  || { echo "❌ spring sync FAILED"; exit 2; }

echo "================ [4/4] flowmap: connectivity verifier ================"
node "$FM/tests/check-connectivity.mjs"
