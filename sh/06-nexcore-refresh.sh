#!/usr/bin/env bash
# [06] nexcore: analyze every NEXCORE module + combine + openapi + impact + manifest
# into flowmap-nexcore/json (its own staging dir — a per-service tree json/service/<svc>/).
# Independent of the spring-kotlin backend — its per-module backend graphs are folded into
# the web data later by the sync stage (12): spring's single `sync` reads nexcore's json via
# --frontend-dir and normalizes its service/<svc>/ tree alongside the others.
# Impact auto-skips when the nexcore repo has no git history.
# Extra flags pass through, e.g. ./06-nexcore-refresh.sh --no-impact --impact-max 20
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
build_step "$NX" "./gradlew -q installDist" "[06] build nexcore analyzer (flowmap-nexcore)"
echo "──────── [06] nexcore refresh ────────" >&2
bash "$NX/scripts/01-refresh.sh" "$@"
