#!/usr/bin/env bash
# 한 번의 반복(iteration): 실제 파이프라인 명령으로 산출물을 만들고 연결성을 검증한다.
#   1) flowmap-spring-kotlin: ./gradlew run (refresh)  — analyze + combine(_combined.json) + sync + manifest
#   2) flowmap-react:         ./flowmap pipeline        — analyze + screens + join (FRESH _combined 로 직접매칭)
#   3) 프론트 산출물을 web data 로 재동기화 (refresh 가 1)에서 복사한 stale 프론트 파일을 덮어씀)
#   4) flowmap:               node tests/check-connectivity.mjs
#
# spring 을 먼저 돌려 _combined.json 을 최신화한 뒤 react join 이 이를 읽으므로, 새 엔드포인트도
# 같은 패스에서 직접매칭(Stage-1)된다. refresh 는 반복 속도/오프라인 결정성을 위해 git pull/impact 만 건너뛴다.
set -uo pipefail
RA=/Users/kyutaepark/study/flowmap-react
SK=/Users/kyutaepark/study/flowmap-spring-kotlin
FM=/Users/kyutaepark/study/flowmap

echo "================ [1/4] spring: ./gradlew run (refresh) ================"
( cd "$SK" && ./gradlew --console=plain --quiet run --args="refresh --repo .repo --out-dir json --no-pull --no-impact --sync-dir ../flowmap/docs/web/data --frontend-dir ../flowmap-react/json" ) \
  || { echo "❌ spring refresh FAILED"; exit 2; }

echo "================ [2/4] react: ./flowmap pipeline ================"
( cd "$RA" && ./flowmap pipeline ) || { echo "❌ react pipeline FAILED"; exit 2; }

echo "================ [3/4] re-sync frontend artifacts -> web data ================"
cp "$RA"/json/*.json "$FM"/docs/web/data/ || { echo "❌ frontend re-sync FAILED"; exit 2; }

echo "================ [4/4] flowmap: connectivity verifier ================"
node "$FM/tests/check-connectivity.mjs"
