#!/usr/bin/env bash
# Shared setup for the UNIFIED cross-repo pipeline (flowmap/sh).
#
# Orchestrates the THREE analyzers in dependency order and assembles + verifies the
# web data. Each numbered stage delegates to the per-step script that already lives
# in the owning repo (no logic is duplicated here):
#
#   backend  = flowmap-spring/scripts/<n>-*.sh          (Kotlin CLI: analyze/merge/…)
#   nexcore  = flowmap-nexcore/scripts/01-refresh.sh         (Java CLI: refresh; spring's sync assembles it)
#   frontend = flowmap-react/scripts/pipeline/<n>-*.sh  (ts CLI: analyze/screens/join/impact)
#
# Order (bidirectional dependency):
#   01-05 backend (no sync)  -> 03 produces _combined.json
#   06    nexcore refresh    -> independent backend graphs into flowmap-nexcore/json
#   07-11 frontend           -> 10 join reads backend's _combined.json, 11 = PR impact
#   12    sync               -> assembles web data from ALL THREE (must follow them)
#   13    deploy-sync        -> deploy 영향도 데이터(data/deploy/) — manifest 확정 후라야 repo 조인 정합
#   14    verify
#
# The sync (12) is a SINGLE spring `sync` call that assembles ONE web data dir from all
# THREE analyzers' per-service staging trees: spring's own OUT_DIR plus the extra source
# dirs given via --frontend-dir (a CSV: react's + nexcore's json). Each analyzer stages a
# two-level `<root>/<category>/<svc>/…` tree with a different category dir (spring=projects,
# nexcore=service, react=frontend) and different internal filenames (`<svc>.*`, bare
# `openapi.json`, `graph.*`); spring's `sync` discovers each per-service dir and NORMALIZES
# its files into `web/data/projects/<svc>/<svc>.*`, then rebuilds the app-facing
# manifest.json by scanning that dir. No separate nexcore self-sync step is needed.
set -euo pipefail

FM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # flowmap (web/hub) repo root
STUDY="$FM"                                             # analyzers live INSIDE this repo
SK="$STUDY/flowmap-spring"          # backend analyzer (Kotlin)
NX="$STUDY/flowmap-nexcore"         # nexcore analyzer (Java / NEXCORE BizUnit)
RA="$STUDY/flowmap-react"           # frontend analyzer (ts)
DEPLOY="$STUDY/flowmap-deploy"      # deploy 영향도 분석 (techplatform-mcp + GHE)

# Optional root run-config (machine-specific; gitignored, template = flowmap.config.example):
# overrides the auto-derived analyzer locations (SK/NX/RA) and/or FRONTEND_DIR. The
# per-analyzer REPO/BACKEND live in each analyzer's own flowmap.config.
[ -f "$FM/flowmap.config" ] && . "$FM/flowmap.config"

# run a delegated stage script (self-locating; cwd-independent), with a header.
step() {  # $1 = script path, $2 = label
  echo "──────── $2 ────────" >&2
  [ -f "$1" ] || { echo "missing step script: $1" >&2; exit 2; }
  bash "$1"
}

# (re)build a delegated analyzer's CLI from its OWN source, with a header. Runs the
# given build command from the analyzer dir so a source fix in that analyzer takes
# effect before its stages run. Builds are INCREMENTAL (gradle installDist / tsc):
# a near-instant no-op when sources are unchanged, a recompile when they changed —
# so this is safe to run at the head of every block without slowing repeat runs.
build_step() {  # $1 = analyzer dir, $2 = build command, $3 = label
  echo "──────── $3 ────────" >&2
  [ -d "$1" ] || { echo "missing analyzer dir: $1" >&2; exit 2; }
  ( cd "$1" && eval "$2" )
}
