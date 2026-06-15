#!/usr/bin/env bash
# [10] backend: assemble the web data dir from BOTH analyzers' fresh artifacts
# (+ prune departed/stale files + rebuild the app-facing manifest.json).
# Must run AFTER the frontend stages so react's fresh graph-*.json are picked up.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$SK/scripts/6-sync.sh" "[10] backend sync (assemble web data)"
