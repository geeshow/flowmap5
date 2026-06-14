#!/usr/bin/env python3
"""웹 데이터(docs/web/data/*.json) 전송 최적화.

기본: 모든 *.json 을 minify(공백 제거)해 제자리 갱신 (-15~22%).
--gzip: 추가로 <file>.json.gz (gzip -9) 도 생성하고 manifest.json 에 "compressed": true 를 기록.
        웹앱(app.js jsonFetch)이 이 플래그를 보고 .gz 를 받아 DecompressionStream 으로 해제 → 전송량 -95%.

실행 순서: 분석기 → scripts/build.py(graph.json 머지) → scripts/optimize.py [--gzip]
data/ 는 생성물이므로 분석기 재실행 시 평문으로 되돌아간다. 이 스크립트를 마지막에 한 번 더 돌리면 된다.

  python3 scripts/optimize.py            # minify 만
  python3 scripts/optimize.py --gzip     # minify + .gz + compressed 플래그 (권장)
"""
import argparse
import glob
import gzip
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "web", "data")
# 평문으로만 받는 파일(클라이언트가 compressed 플래그를 읽기 전에 fetch) → .gz 생성 제외
NO_GZIP = {"manifest.json", "_manifest.json"}


def minify(path):
    """JSON 을 컴팩트(분리자 공백 없음, 유니코드 보존)하게 제자리 재작성. 반환: (원본바이트, 결과바이트)."""
    raw = open(path, "rb").read()
    obj = json.loads(raw)
    out = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if out != raw:
        with open(path, "wb") as f:
            f.write(out)
    return len(raw), len(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gzip", action="store_true", help=".json.gz 동반 생성 + manifest compressed 플래그")
    args = ap.parse_args()

    if not os.path.isdir(DATA_DIR):
        raise SystemExit(f"data dir 없음: {DATA_DIR}")

    files = sorted(glob.glob(os.path.join(DATA_DIR, "*.json")))
    if not files:
        raise SystemExit(f"*.json 없음: {DATA_DIR}")

    orig_tot = min_tot = gz_tot = 0
    gz_made = 0
    for path in files:
        name = os.path.basename(path)
        o, m = minify(path)
        orig_tot += o
        min_tot += m
        gz_path = path + ".gz"
        if args.gzip and name not in NO_GZIP:
            data = open(path, "rb").read()
            with gzip.open(gz_path, "wb", compresslevel=9) as f:
                f.write(data)
            gz_tot += os.path.getsize(gz_path)
            gz_made += 1
        elif os.path.exists(gz_path):
            os.remove(gz_path)   # 모드 전환/미사용 시 stale .gz 제거

    # manifest.json 에 compressed 플래그 기록 (app.js 가 이 값으로 .gz 사용 여부 결정)
    man_path = os.path.join(DATA_DIR, "manifest.json")
    if os.path.exists(man_path):
        man = json.loads(open(man_path, "rb").read())
        man["compressed"] = bool(args.gzip)
        with open(man_path, "wb") as f:
            f.write(json.dumps(man, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    kb = lambda b: f"{b / 1024:.0f} KB"
    print(f"파일 {len(files)}개 minify: {kb(orig_tot)} → {kb(min_tot)} (-{100 * (orig_tot - min_tot) // max(orig_tot,1)}%)")
    if args.gzip:
        print(f".gz {gz_made}개 생성: 합계 {kb(gz_tot)} (manifest compressed=true)")
        print("→ 웹앱이 .gz 를 받아 해제합니다. (manifest.json 은 평문 유지)")
    else:
        print("gzip 생략 (--gzip 로 활성화). manifest compressed=false")


if __name__ == "__main__":
    main()
