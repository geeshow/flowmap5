#!/usr/bin/env bash
# [10] frontend: join each front graph against the backend graph(s) -> <graph>.join.json.
# Needs stage 03 (backend merge) and 06 (nexcore refresh). react's BACKEND is a CSV of
# both backends' _combined.json (set in flowmap-react/flowmap.config), so the join unions
# spring-kotlin controllers + nexcore `.jmd` aliases into one match index — FE `.jmd`
# transaction calls (/std/<Tid>, /lng/<Tid>, /<Tid>) resolve via the alias tier.
# Auto-skips when BACKEND is unset/missing in react config.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$RA/scripts/pipeline/04-join.sh" "[10] frontend join"
