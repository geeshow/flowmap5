#!/usr/bin/env bash
# 생성된 JSON 산출물을 전부 지워서 파이프라인을 깨끗한 상태에서 다시 돌릴 수 있게 한다.
# 프론트/백엔드 root 가 리네임·삭제됐을 때 소스 출력 디렉터리에 남는 stale per-root 파일
# (예: graph-<oldroot>.json)을 제거해, 다음 iterate.sh 실행이 유령 없이 시작되도록 한다.
#
# 대상 (모두 gitignore 된 생성물):
#   1) flowmap-spring/json   — 백엔드 그래프/_combined/openapi/impact/pulls/manifest
#   2) flowmap-react/json           — graph-<root>.json / .screens.json / .join.json / _manifest
#   3) flowmap/docs/web/data        — 위 산출물이 조립된 웹 데이터 + manifest.json (+ *.json.gz)
#
# 사용: scripts/clean.sh            # 바로 삭제
#       scripts/clean.sh --dry-run  # 지울 대상만 출력
set -uo pipefail
SK=/Users/kyutaepark/study/flowmap-spring
RA=/Users/kyutaepark/study/flowmap-react
FM=/Users/kyutaepark/study/flowmap

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

clean_dir() {  # $1 = dir
  local d="$1"
  if [ ! -d "$d" ]; then echo "  (없음, skip) $d"; return; fi
  # 생성물: *.json, *.json.gz (웹 빌드 압축본), <project>.pulls/ 샤드 디렉터리
  local files dirs
  files=$(find "$d" -maxdepth 1 -type f \( -name '*.json' -o -name '*.json.gz' \) 2>/dev/null)
  dirs=$(find "$d" -maxdepth 1 -type d -name '*.pulls' 2>/dev/null)
  if [ -z "$files$dirs" ]; then echo "  (비어있음) $d"; return; fi
  if [ "$DRY" = "1" ]; then
    [ -n "$files" ] && echo "$files" | sed 's/^/    rm  /'
    [ -n "$dirs" ]  && echo "$dirs"  | sed 's/^/    rm -rf  /'
  else
    [ -n "$files" ] && echo "$files" | xargs rm -f
    [ -n "$dirs" ]  && echo "$dirs"  | xargs rm -rf
    echo "    삭제 완료: $(printf '%s\n' "$files" "$dirs" | grep -c . ) 항목"
  fi
}

[ "$DRY" = "1" ] && echo "== DRY RUN (실제 삭제 안 함) =="
echo "== [1/3] spring out: $SK/json =="; clean_dir "$SK/json"
echo "== [2/3] react out:  $RA/json =="; clean_dir "$RA/json"
echo "== [3/3] web data:   $FM/docs/web/data =="; clean_dir "$FM/docs/web/data"
echo "done."
