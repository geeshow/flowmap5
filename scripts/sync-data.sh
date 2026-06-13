#!/usr/bin/env bash
# sync-data.sh — kotlin-analyzer JSON 출력을 flowmap 웹앱 데이터로 동기화
set -u

# ── 경로 변수 ────────────────────────────────────────────────
ANALYZER_DIR="/Users/kyutaepark/study/flowmap-spring-kotlin/kotlin-analyzer"
JSON_DIR="$ANALYZER_DIR/json"
REPO="/Users/kyutaepark/study/flowmap-spring-kotlin/.repo/tera-cloud-user"
FLOWMAP_DIR="/Users/kyutaepark/study/flowmap"
DATA_DIR="$FLOWMAP_DIR/docs/web/data"
IMPACT_TMP="$ANALYZER_DIR/build/impact-sync.json"

log()  { echo "[sync-data] $*"; }
warn() { echo "[sync-data][WARN] $*" >&2; }

mkdir -p "$DATA_DIR"

# ── 1. graph.json (백업 후 복사) ────────────────────────────
if [ -f "$DATA_DIR/graph.json" ]; then
  cp "$DATA_DIR/graph.json" "$DATA_DIR/graph.json.bak" \
    && log "기존 graph.json -> graph.json.bak 백업 완료" \
    || warn "graph.json 백업 실패"
fi
if cp "$JSON_DIR/_combined.json" "$DATA_DIR/graph.json"; then
  log "graph.json 복사 성공 ($JSON_DIR/_combined.json)"
else
  warn "graph.json 복사 실패"
fi

# ── 2. openapi.json 복사 ────────────────────────────────────
if cp "$JSON_DIR/_openapi.json" "$DATA_DIR/openapi.json"; then
  log "openapi.json 복사 성공 ($JSON_DIR/_openapi.json)"
else
  warn "openapi.json 복사 실패"
fi

# ── 3. impact.json 생성 (실패해도 계속 진행) ────────────────
log "impact 분석 시작 (git: $REPO)"
if (cd "$ANALYZER_DIR" && ./gradlew run --quiet \
      --args="impact --git $REPO --graph $JSON_DIR/_combined.json --max 30 --depth 3 --out $IMPACT_TMP"); then
  if [ -s "$IMPACT_TMP" ]; then
    cp "$IMPACT_TMP" "$DATA_DIR/impact.json" \
      && log "impact.json 생성/복사 성공" \
      || warn "impact.json 복사 실패"
  else
    warn "impact 출력 파일이 비어 있음 — impact.json 갱신 생략"
  fi
else
  warn "impact 분석 실패 — impact.json 갱신 생략 (앱은 404 빈 상태를 처리함)"
fi

log "동기화 완료"
