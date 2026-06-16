#!/usr/bin/env bash
# [11] frontend: per-root PR change-impact against each front graph -> <graph>.impact.json
# (+ <graph>.impact/<n>.json shards). Needs stage 08 (analyze) first; each per-root
# graph's matching checkout under REPO/<root> is mined for merged PRs (git-first, gh
# fallback), and roots that are not standalone git repos are skipped.
# Extra flags pass through, e.g. ./11-frontend-impact.sh   (IMPACT_MAX env caps PRs).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
echo "──────── [11] frontend impact ────────" >&2
bash "$RA/scripts/pipeline/05-impact.sh" "$@"
