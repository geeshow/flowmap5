#!/usr/bin/env bash
# [12] assemble the web data dir from ALL THREE analyzers' per-service staging trees
# via a SINGLE spring `sync` call (+ prune departed/stale files + rebuild manifest.json).
# Must run AFTER nexcore (06) and the frontend stages (07-11) so their fresh graphs exist.
#
# spring's `sync` copies from its own OUT_DIR + every dir in FRONTEND_DIR (a CSV of extra
# source dirs). Each analyzer stages a two-level `<root>/<category>/<svc>/…` tree with a
# different category dir (spring=projects, nexcore=service, react=frontend); spring's `sync`
# discovers each per-service dir across the FOLDER_GROUPS and NORMALIZES them into
# docs/web/data/projects/<svc>/<svc>.*, then rebuilds the app-facing manifest.json. We add
# BOTH react's and nexcore's json to FRONTEND_DIR so one sync assembles all three — the
# departed-file prune is type-scoped, so spring + nexcore backend graphs coexist (both are
# present as sources) instead of pruning each other.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
export FRONTEND_DIR="${FRONTEND_DIR:-$RA/json,$NX/json}"
step "$SK/scripts/06-sync.sh" "[12] sync (assemble web data: backend + nexcore + frontend)"
