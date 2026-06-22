#!/usr/bin/env bash
# [12] assemble the web data dir from ALL THREE analyzers' per-service staging trees
# via a SINGLE spring `sync` call (+ prune departed/stale files + rebuild manifest.json).
# Must run AFTER nexcore (06) and the frontend stages (07-11) so their fresh graphs exist.
#
# spring's `sync` copies from its own OUT_DIR + every dir in FRONTEND_DIR (a CSV of extra
# source dirs). All three analyzers now stage the SAME nested tree
# `<root>/projects/<git-namespace>/<git-repo>/<per-root>/…`; spring's `sync` recurses each
# source's `projects/` to its leaf per-root dirs and MIRRORS them into
# web/data/projects/<ns>/<repo>/<per-root>/<per-root>.*, then rebuilds the app-facing
# manifest.json (each entry carries `namespace` + `repo` from the graph meta). We add
# BOTH react's and nexcore's json to FRONTEND_DIR so one sync assembles all three — the
# departed-file prune is type-scoped, so spring + nexcore backend graphs coexist (both are
# present as sources) instead of pruning each other.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
export FRONTEND_DIR="${FRONTEND_DIR:-$RA/json,$NX/json}"
step "$SK/scripts/06-sync.sh" "[12] sync (assemble web data: backend + nexcore + frontend)"
