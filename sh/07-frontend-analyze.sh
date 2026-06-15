#!/usr/bin/env bash
# [07] frontend: analyze -> flowmap-react/json/<base>.json (per-root when split).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$RA/scripts/pipeline/1-analyze.sh" "[07] frontend analyze"
