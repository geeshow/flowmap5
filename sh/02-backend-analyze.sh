#!/usr/bin/env bash
# [02] backend: build a call graph per project -> flowmap-spring/json/<project>.json
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$SK/scripts/02-analyze.sh" "[02] backend analyze"
