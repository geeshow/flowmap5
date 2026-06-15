#!/usr/bin/env bash
# [02] backend: build a call graph per project -> flowmap-spring-kotlin/json/<project>.json
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$SK/scripts/2-analyze.sh" "[02] backend analyze"
