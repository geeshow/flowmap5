#!/usr/bin/env python3
"""flowmap 그래프 머지 빌드.

graphs/*.json (서비스별 node-link 그래프)를 하나로 머지해 web/data/graph.json 으로 출력한다.
브라우저가 9개 파일(+1MB tera)을 각각 fetch하지 않도록 서버측에서 미리 합친다.

머지 규칙 (README.md / RENDERING.md 기준):
  - 노드: `id` 로 dedup. 같은 id가 여러 파일에 있으면 `file` 이 채워진(원본) 노드를 우선.
  - 엣지: `(source, target, relation, callSiteLine)` 로 dedup.

재실행으로 갱신. 분석기 재실행 후 `python3 scripts/build.py` 한 번이면 웹 데이터가 최신화된다.
"""
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAPHS_DIR = os.path.join(ROOT, "graphs")
OUT_DIR = os.path.join(ROOT, "web", "data")
OUT_FILE = os.path.join(OUT_DIR, "graph.json")


def edge_key(e):
    return (e.get("source"), e.get("target"), e.get("relation"), e.get("callSiteLine"))


def main():
    files = sorted(glob.glob(os.path.join(GRAPHS_DIR, "*.json")))
    if not files:
        raise SystemExit(f"no graph files found under {GRAPHS_DIR}")

    nodes = {}   # id -> node
    edges = {}   # key -> edge
    generated_from = []

    for path in files:
        with open(path, encoding="utf-8") as f:
            g = json.load(f)
        generated_from.append(os.path.basename(path))
        for n in g.get("nodes", []):
            nid = n["id"]
            prev = nodes.get(nid)
            # file 이 채워진 노드를 우선 (다른 서비스 그래프의 스텁은 file=null)
            if prev is None or (n.get("file") and not prev.get("file")):
                nodes[nid] = n
        for e in g.get("edges", []):
            edges[edge_key(e)] = e

    node_list = list(nodes.values())
    edge_list = list(edges.values())
    projects = sorted({n.get("project") for n in node_list if n.get("project")})

    out = {
        "meta": {
            "nodes": len(node_list),
            "edges": len(edge_list),
            "projects": projects,
            "generatedFrom": generated_from,
        },
        "nodes": node_list,
        "edges": edge_list,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print(f"merged {len(generated_from)} files -> {os.path.relpath(OUT_FILE, ROOT)}")
    print(f"  nodes: {len(node_list)}")
    print(f"  edges: {len(edge_list)}")
    print(f"  projects ({len(projects)}): {', '.join(projects)}")


if __name__ == "__main__":
    main()
