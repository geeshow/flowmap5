#!/usr/bin/env bash
# [14] verify cross-graph connectivity of the assembled web data.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
echo "──────── [14] verify connectivity ────────" >&2
node "$FM/tests/check-connectivity.mjs"
