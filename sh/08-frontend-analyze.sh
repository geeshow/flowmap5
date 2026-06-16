#!/usr/bin/env bash
# [08] frontend: analyze -> flowmap-react/json/<base>.json (per-root when split).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$RA/scripts/pipeline/02-analyze.sh" "[08] frontend analyze"
