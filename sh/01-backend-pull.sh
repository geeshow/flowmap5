#!/usr/bin/env bash
# [01] backend: build the analyzer CLI from source, then git fast-forward pull each
# analyzed project. The build picks up any flowmap-spring source fix before stage 02
# analyzes with it (gradle installDist is incremental — a no-op when unchanged).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
build_step "$SK" "./gradlew -q installDist" "[01] build backend analyzer (flowmap-spring)"
step "$SK/scripts/01-pull.sh" "[01] backend pull"
