#!/usr/bin/env bash
# [11] frontend: per-REPO PR change-impact -> <repoName>/<base>.impact.json
# (+ <base>.impact/<n>.json shards). Needs stage 08 (analyze) first; front graphs are
# grouped by git work tree (a monorepo's sub-roots merge into ONE repo-level impact) and
# each repo's checkout is mined for merged PRs (git-first, gh fallback); roots that are
# not standalone git repos are skipped.
# Extra flags pass through, e.g. ./11-frontend-impact.sh   (IMPACT_MAX env caps PRs).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
echo "──────── [11] frontend impact ────────" >&2
bash "$RA/scripts/pipeline/05-impact.sh" "$@"
