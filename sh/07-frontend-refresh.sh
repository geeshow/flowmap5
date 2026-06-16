#!/usr/bin/env bash
# [07] frontend: git pull the analyzed checkout (skipped when PULL=false in react config).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$RA/scripts/pipeline/01-refresh.sh" "[07] frontend refresh"
