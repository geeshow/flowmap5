#!/usr/bin/env bash
# [06] frontend: git pull the analyzed checkout (skipped when PULL=false in react config).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$RA/scripts/pipeline/0-refresh.sh" "[06] frontend refresh"
