#!/usr/bin/env bash
# Run the UNIFIED cross-repo pipeline in order (backend -> frontend -> sync -> verify).
#
#   ./sh/run-all.sh                # full pipeline (stages 01..11)
#   ./sh/run-all.sh 3 9            # a subset, e.g. backend merge + frontend join
#   ./sh/run-all.sh 1 2 3 4 5      # backend only (no sync/verify)
#
# Stage scripts are named `<NN>-*.sh`; arguments may be given with or without the
# leading zero (3 == 03). Any extra flags after a SINGLE stage number are passed
# through to that stage, e.g.  ./sh/run-all.sh 5 --max 2
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve() {  # $1 = stage number (with/without leading zero) -> prints script path
  local nn; nn=$(printf '%02d' "$((10#$1))")
  local s; s=$(ls "$DIR/$nn"-*.sh 2>/dev/null | head -1 || true)
  [ -n "$s" ] || { echo "run-all: no stage '$1'" >&2; exit 2; }
  echo "$s"
}

# Single stage + pass-through flags:  run-all.sh 5 --max 2
if [ $# -ge 2 ] && [ "${2#-}" != "$2" ]; then
  s=$(resolve "$1"); shift
  bash "$s" "$@"
  echo "done." >&2
  exit 0
fi

if [ $# -eq 0 ]; then
  scripts=()
  for s in "$DIR"/[0-9][0-9]-*.sh; do scripts+=("$s"); done   # glob sorts 01..11
else
  scripts=()
  for n in "$@"; do scripts+=("$(resolve "$n")"); done
fi

for s in "${scripts[@]}"; do
  bash "$s"
done
echo "done." >&2
