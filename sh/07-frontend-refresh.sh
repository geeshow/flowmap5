#!/usr/bin/env bash
# [07] frontend: build the ts-analyzer CLI from source, then git pull the analyzed
# checkout (pull skipped when PULL=false in react config). Unlike spring/nexcore (whose
# per-step _common rebuilds every stage), react's pipeline runs the prebuilt dist/cli.js
# as-is and the `flowmap` launcher only builds when dist is MISSING — so without this
# step a flowmap-react/ts-analyzer source fix would never reach stages 08–11 (stale JS).
# scripts/build.sh skips npm install when node_modules exists and tsc-compiles incrementally.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
build_step "$RA" "bash scripts/build.sh" "[07] build frontend analyzer (flowmap-react)"
step "$RA/scripts/pipeline/01-refresh.sh" "[07] frontend refresh"
