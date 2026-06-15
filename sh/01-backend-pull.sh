#!/usr/bin/env bash
# [01] backend: git fast-forward pull each analyzed project.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$SK/scripts/1-pull.sh" "[01] backend pull"
