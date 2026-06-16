#!/usr/bin/env bash
# [05] backend: per-project PR impact against _combined.json (needs stage 03 first).
# Extra flags pass through, e.g. ./05-backend-impact.sh --max 2  (fewer PRs, faster).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
echo "──────── [05] backend impact ────────" >&2
bash "$SK/scripts/05-impact.sh" "$@"
