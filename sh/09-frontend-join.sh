#!/usr/bin/env bash
# [09] frontend: join each front graph against the backend _combined.json -> <graph>.join.json.
# Needs stage 03 (backend merge). Auto-skips when BACKEND is unset/missing in react config.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$RA/scripts/pipeline/3-join.sh" "[09] frontend join"
