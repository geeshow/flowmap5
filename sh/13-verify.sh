#!/usr/bin/env bash
# [13] verify cross-graph connectivity of the assembled web data.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
echo "──────── [13] verify connectivity ────────" >&2
node "$FM/tests/check-connectivity.mjs"
