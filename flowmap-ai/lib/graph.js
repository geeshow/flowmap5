// graph.js — load a per-service call graph (<name>.json) and trace impact.
//
// Linkage facts (verified against the data):
//  - node.id      e.g. "com.tf.user.controller.VerifyController#uploadOCR"
//  - node.file    e.g. "tera-cloud-user/tera-user-service/src/.../UsebClient.kt"
//                 == "<repoDir>/" + the PR diff's `path`, so we match a changed
//                 file to its graph nodes by path-suffix.
//  - edges: {source,target,kind,mode,relation}. kind ∈ internal|s2s|external|
//           batch|kafka|redis|db|join|resource. Endpoint nodes have `endpoint`
//           /`httpMethod`; external/s2s call sites have `externalUrl`/
//           `externalService`/`s2sService`.
//
// From a set of changed files we seed the graph, then:
//  - BACKWARD (callers → seed): which HTTP endpoints transitively reach the
//    changed code = this service's public-API blast radius.
//  - FORWARD (seed → callees): which external systems / sibling services /
//    datastores the changed code depends on.

import { readFileSync } from 'node:fs';

const EXTERNAL_KINDS = new Set(['s2s', 'external', 'kafka', 'redis', 'db', 'batch', 'join']);

export function loadGraph(file) {
  const g = JSON.parse(readFileSync(file, 'utf8'));
  const nodes = g.nodes || [];
  const edges = g.edges || g.links || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fwd = new Map(); // source -> [{target,kind,...}]
  const rev = new Map(); // target -> [{source,kind,...}]
  for (const e of edges) {
    if (!fwd.has(e.source)) fwd.set(e.source, []);
    if (!rev.has(e.target)) rev.set(e.target, []);
    fwd.get(e.source).push(e);
    rev.get(e.target).push(e);
  }
  return { nodes, edges, byId, fwd, rev };
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');

/** Graph node ids whose source file matches one of the changed diff paths. */
export function changedNodeIds(graph, changedPaths) {
  const paths = changedPaths.map(norm).filter(Boolean);
  const ids = [];
  for (const n of graph.nodes) {
    const f = norm(n.file);
    if (!f) continue;
    if (paths.some((p) => f === p || f.endsWith('/' + p))) ids.push(n.id);
  }
  return ids;
}

function walk(adj, seeds, pick, maxDepth = 12) {
  const seen = new Set(seeds);
  const out = new Set();
  const kinds = new Set();
  let frontier = [...seeds];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const id of frontier) {
      for (const e of adj.get(id) || []) {
        if (e.kind) kinds.add(e.kind);
        const neigh = pick(e);
        if (seen.has(neigh)) continue;
        seen.add(neigh);
        next.push(neigh);
        out.add(neigh);
      }
    }
    frontier = next;
    depth++;
  }
  return { reached: out, kinds };
}

const slim = (n) =>
  n && {
    id: n.id,
    layer: n.layer,
    httpMethod: n.httpMethod || undefined,
    endpoint: n.endpoint || undefined,
    externalService: n.externalService || undefined,
    externalUrl: n.externalUrl || undefined,
    s2sService: n.s2sService || undefined,
    file: n.file || undefined,
    line: n.line || undefined,
  };

/**
 * Build a compact impact subgraph for one PR's changed files.
 * Bounded by `cap` to keep the prompt small.
 */
export function buildSubgraph(graph, changedPaths, cap = 40) {
  const seedIds = changedNodeIds(graph, changedPaths);
  const seeds = seedIds.map((id) => graph.byId.get(id)).filter(Boolean);

  const back = walk(graph.rev, seedIds, (e) => e.source); // callers
  const fwd = walk(graph.fwd, seedIds, (e) => e.target); // callees

  const upstreamEndpoints = [...back.reached]
    .map((id) => graph.byId.get(id))
    .filter((n) => n && (n.endpoint || n.httpMethod))
    .map(slim);

  const downstreamExternals = [...fwd.reached]
    .map((id) => graph.byId.get(id))
    .filter((n) => n && (n.externalUrl || n.externalService || n.s2sService))
    .map(slim);

  const edgeKindsTouched = [...new Set([...back.kinds, ...fwd.kinds])].sort();
  const isEndpointChanged = seeds.some((n) => n.endpoint || n.httpMethod);
  const isExternalCallChanged = seeds.some(
    (n) => n.externalUrl || n.externalService || n.s2sService,
  );
  const reachesExternal = edgeKindsTouched.some((k) => EXTERNAL_KINDS.has(k));

  return {
    changedNodeCount: seeds.length,
    changedNodes: seeds.slice(0, cap).map(slim),
    upstreamEndpoints: upstreamEndpoints.slice(0, cap),
    upstreamEndpointCount: upstreamEndpoints.length,
    downstreamExternals: downstreamExternals.slice(0, cap),
    downstreamExternalCount: downstreamExternals.length,
    edgeKindsTouched,
    isEndpointChanged,
    isExternalCallChanged,
    reachesExternal,
    unmatchedFiles: changedPaths.length && !seeds.length, // diff present but no graph node hit
  };
}
