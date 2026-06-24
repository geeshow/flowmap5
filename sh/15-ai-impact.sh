#!/usr/bin/env bash
# 15-ai-impact.sh — AI change-impact analysis over all projects.
#
# Runs AFTER sync(12)/deploy-sync(13)/verify(14): the web data (impact/pulls/
# graph) is fresh. Builds the repoUrl→local-clone index, starts the local
# AI-model stand-in server (claude CLI), analyzes every project that does not
# yet have a <base>.AI분석결과.md, then stops the server.
#
# Production note: the stand-in server is the swappable piece. To run against
# the real hosted AI-model API, skip the server and point the driver at it:
#   node flowmap-ai/run-batch.js --server https://<prod-ai-api>
#
# Env: FLOWMAP_AI_PORT (default 8790), FLOWMAP_REPO_ROOTS (extra clone roots).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI="$ROOT/flowmap-ai"
PORT="${FLOWMAP_AI_PORT:-8790}"

command -v node >/dev/null 2>&1 || { echo "[15] node not found on PATH" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "[15] claude CLI not found on PATH" >&2; exit 1; }

echo "[15] building repo-location index…"
node "$AI/build-index.js"

echo "[15] starting AI-model stand-in server on :$PORT…"
FLOWMAP_AI_PORT="$PORT" node "$AI/server.js" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# wait for /health
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "[15] analyzing projects (skipping ones with existing .AI분석결과.md)…"
node "$AI/run-batch.js" --server "http://localhost:$PORT" "$@"

echo "[15] done."
