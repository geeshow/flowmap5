#!/usr/bin/env bash
# sync-data.sh — 백엔드/프론트 분석기의 "프로젝트별 산출물"을 flowmap 웹앱 데이터로 동기화
#   • per-project 파일(<project>.json / .openapi.json / .impact.json / .join.json / .screens.json) 복사
#   • 두 분석기의 _manifest.json 을 병합해 data/manifest.json 생성 (앱은 이걸로 프로젝트 목록 인지)
set -u

# ── 경로 변수 ────────────────────────────────────────────────
BE_DIR="/Users/kyutaepark/study/flowmap-spring-kotlin/kotlin-analyzer"
BE_JSON="$BE_DIR/json"
FE_JSON="/Users/kyutaepark/study/flowmap-react/json"
IMPACT_REPO="/Users/kyutaepark/study/flowmap-spring-kotlin/.repo/tera-cloud-user"
IMPACT_PROJECT="tera-cloud-user"        # impact 산출물의 프로젝트명 (graph 프로젝트명과 일치해야 함)
FLOWMAP_DIR="/Users/kyutaepark/study/flowmap"
DATA_DIR="$FLOWMAP_DIR/docs/web/data"

log()  { echo "[sync-data] $*"; }
warn() { echo "[sync-data][WARN] $*" >&2; }

mkdir -p "$DATA_DIR"

# ── 1. per-project 아티팩트 복사 (통합본 _*.json 은 제외) ─────
copy_artifacts() {  # $1 = source json dir
  local src="$1"
  [ -d "$src" ] || { warn "소스 디렉토리 없음: $src"; return; }
  local n=0
  for f in "$src"/*.json; do
    [ -e "$f" ] || continue
    local base; base="$(basename "$f")"
    case "$base" in
      _*) continue ;;                       # _combined / _openapi / _manifest 제외
    esac
    cp "$f" "$DATA_DIR/$base" && n=$((n+1))
  done
  log "$src → 프로젝트 파일 $n개 복사"
}
copy_artifacts "$BE_JSON"
copy_artifacts "$FE_JSON"

# ── 2. 백엔드 커밋 영향도 → <project>.impact.json (실패해도 계속) ─
log "impact 분석 시작 (git: $IMPACT_REPO)"
IMPACT_OUT="$DATA_DIR/$IMPACT_PROJECT.impact.json"
if (cd "$BE_DIR" && ./gradlew run --quiet \
      --args="impact --git $IMPACT_REPO --graph $BE_JSON/_combined.json --max 30 --depth 3 --out $IMPACT_OUT"); then
  [ -s "$IMPACT_OUT" ] && log "impact 생성 성공: $IMPACT_PROJECT.impact.json" || warn "impact 출력이 비어 있음"
else
  warn "impact 분석 실패 — impact 생략 (앱은 빈 상태 처리)"
fi

# ── 3. 매니페스트 병합 (백엔드 + 프론트 _manifest.json) ──────
log "manifest 병합 중…"
python3 - "$DATA_DIR" "$BE_JSON/_manifest.json" "$FE_JSON/_manifest.json" <<'PY'
import json, os, sys, glob
from datetime import datetime, timezone

data_dir, *manifests = sys.argv[1], *sys.argv[2:]
projects, seen = [], set()

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return None

# 1) 분석기가 만든 _manifest.json 들을 병합
for mpath in manifests:
    m = load(mpath)
    if not m or not isinstance(m.get('projects'), list):
        print(f"[sync-data][WARN] manifest 없음/무효: {mpath}", file=sys.stderr); continue
    for p in m['projects']:
        if p.get('name') in seen: continue
        seen.add(p['name']); projects.append(p)

# 2) data 디렉토리에 실제 존재하는 sibling 아티팩트로 각 엔트리 보정
def exists(fn): return bool(fn) and os.path.isfile(os.path.join(data_dir, fn))
for p in projects:
    name = p['name']
    for key, suffix in (('openapi','.openapi.json'),('impact','.impact.json'),
                        ('join','.join.json'),('screens','.screens.json')):
        cand = name + suffix
        if exists(cand): p[key] = cand
        elif not exists(p.get(key) or ''): p[key] = None
    # graph 파일이 실제로 없으면 경고
    if not exists(p.get('graph') or ''):
        print(f"[sync-data][WARN] graph 파일 없음: {p.get('graph')}", file=sys.stderr)

# 3) 고아 검출: data 에 <project>.json 이 있는데 매니페스트에 없는 경우 경고
for g in sorted(glob.glob(os.path.join(data_dir, '*.json'))):
    b = os.path.basename(g)
    if b.startswith('_') or b == 'manifest.json': continue
    if any(b.endswith(s) for s in ('.openapi.json','.impact.json','.join.json','.screens.json')): continue
    nm = b[:-5]
    if nm not in seen:
        print(f"[sync-data][WARN] 매니페스트에 없는 프로젝트 파일: {b}", file=sys.stderr)

out = {'version': 1,
       'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
       'projects': projects}
with open(os.path.join(data_dir, 'manifest.json'), 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(f"[sync-data] manifest.json 생성: {len(projects)} projects ({', '.join(sorted(seen))})")
PY

# ── 4. 레거시 단일 파일 정리 (매니페스트가 대체) ─────────────
rm -f "$DATA_DIR/graph.json" "$DATA_DIR/graph.json.bak" "$DATA_DIR/openapi.json" "$DATA_DIR/impact.json"

log "동기화 완료"
