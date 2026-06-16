#!/usr/bin/env bash
# [03] backend: merge per-project graphs -> _combined.json (the frontend join input).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$SK/scripts/03-merge.sh" "[03] backend merge (_combined.json)"
