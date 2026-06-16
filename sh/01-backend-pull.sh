#!/usr/bin/env bash
# [01] backend: git fast-forward pull each analyzed project.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
step "$SK/scripts/01-pull.sh" "[01] backend pull"
