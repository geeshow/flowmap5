#!/usr/bin/env bash
# Shared setup for the UNIFIED cross-repo pipeline (flowmap/sh).
#
# Orchestrates the two analyzers in dependency order and assembles + verifies the
# web data. Each numbered stage delegates to the per-step script that already lives
# in the owning repo (no logic is duplicated here):
#
#   backend  = flowmap-spring-kotlin/scripts/<n>-*.sh   (Kotlin CLI: analyze/merge/…)
#   frontend = flowmap-react/scripts/pipeline/<n>-*.sh  (ts CLI: analyze/screens/join)
#
# Order (bidirectional dependency, mirrors scripts/iterate.sh):
#   01-05 backend (no sync) -> 03 produces _combined.json
#   06-09 frontend          -> 09 join reads that _combined.json
#   10    backend sync      -> assembles web data from BOTH (must follow frontend)
#   11    verify
set -euo pipefail

FM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # flowmap (web/hub) repo root
STUDY="$(cd "$FM/.." && pwd)"
SK="$STUDY/flowmap-spring-kotlin"   # backend analyzer
RA="$STUDY/flowmap-react"           # frontend analyzer

# run a delegated stage script (self-locating; cwd-independent), with a header.
step() {  # $1 = script path, $2 = label
  echo "──────── $2 ────────" >&2
  [ -f "$1" ] || { echo "missing step script: $1" >&2; exit 2; }
  bash "$1"
}
