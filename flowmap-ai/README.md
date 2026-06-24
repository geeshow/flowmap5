# flowmap-ai — AI change-impact analysis

Adds an AI-driven change-impact analysis step to the flowmap pipeline. Analysis
is **per-PR**: for every merged PR of every project (each `impact`/`pulls`
directory under `web/data/projects/…`) it reads that PR's diff + the call-graph
and produces a **Korean** Markdown report at `<base>.AI분석결과/<PR번호>.md`
(a directory mirroring the `<base>.pulls/` shard layout). Already-analyzed PRs
(the result file exists) are skipped.

The production AI-model API is only available in the production environment, so
here the model call is faked by an HTTP server that shells out to the local
`claude` CLI. The server is the only swappable piece — see *Production migration*.

---

## Can we reach the actual `.repo` from impact/pulls? — findings

- `impact.json` / `pulls.json` carry **`repoUrl`** (`https://github.com/<owner>/<repo>`)
  and **`base`** branch; each per-PR detail file carries **`mergeCommit`** and full
  **diffs (patches)**. They do **not** carry a local filesystem path.
- Local clones do exist, but scattered: `flowmap-spring/.repo/<repo>`,
  `flowmap-react/.repo/<repo>`, and fallback roots (the nexcore monorepo clones
  live outside `flowmap-nexcore/.repo`, which is empty).
- Dir names are not a reliable key (nexcore: per-root = bizunit ≠ repo dir).
  → We resolve robustly by **matching `repoUrl` against each clone's `git origin`**,
  and persist that as a location index (`repo-locations.json`). This is the
  "위치 정보를 만들어" step.
- The **diffs are embedded**, so analysis works even when no clone is found
  (degraded "diffs-only" mode); a resolved clone lets the model read full source
  and history around each change.

---

## Components

| File | Role |
|------|------|
| `build-index.js` | Scan `.repo/*` + fallback roots, read each `git origin`, write `repo-locations.json` (repoUrl → local path/branch). |
| `server.js` | **AI-model API stand-in.** `POST /analyze` → runs `claude -p` (read-only tools) in the resolved repo dir → returns Markdown. |
| `run-batch.js` | Driver: discover targets, iterate PRs, skip done, build per-PR context, call the server, write `<base>.AI분석결과/<PR번호>.md`. |
| `lib/repo-index.js` | repoUrl normalization + clone scan + resolve. |
| `lib/graph.js` | Load `<base>.json` graph; map changed files → nodes (path-suffix); DFS to upstream endpoints / downstream externals. |
| `lib/context.js` | Assemble the per-project analysis context (diffs + impacted endpoints + subgraph), with size budgets. |
| `lib/prompt.js` | System + task prompt and the fixed Markdown output skeleton. |
| `../sh/15-ai-impact.sh` | Pipeline step: build index → start server → analyze all → stop server. |

---

## Analysis method

For each project the driver builds a compact, bounded context and the model
reasons over it (reading the repo when the diff is ambiguous):

1. **Diffs** — the PR's patches from `<base>.pulls/<n>.json` (truncated to a char
   budget).
2. **Inlined source (option 2)** — so an API-form model needs NO filesystem
   access, the driver reads the local clone and inlines:
   - `pr.files[].source` — the full working-tree source of each changed file
     (diff-surrounding context), and
   - `pr.relatedSources[]` — a `±N`-line excerpt around each impacted node's
     definition (upstream endpoints / downstream external-call sites / changed
     nodes), so the model sees real signatures without exploring.
   Both are bounded by char budgets; skipped when the repo is unresolved
   (degraded "diffs-only" mode still works).
3. **Precomputed blast radius** — `impactedEndpoints[]` from `impact.json`
   (endpoints the analyzer already linked to the PR) + `deletedEndpoints[]`
   (with `breaking` / `pathStillServed`).
4. **Call-graph subgraph** (the "DFS") — from `<base>.json`:
   changed file → graph nodes (matched by `node.file` suffix == diff `path`),
   then
   - **backward** (callers → changed node) ⇒ `upstreamEndpoints`: the service's
     own HTTP surface that transitively reaches the change;
   - **forward** (changed node → callees) ⇒ `downstreamExternals`: external /
     s2s / datastore dependencies the change calls;
   - flags `isEndpointChanged`, `isExternalCallChanged`, `reachesExternal`,
     `edgeKindsTouched`.
5. **Repo access (CLI stand-in only)** — the local `claude` CLI additionally runs
   with `cwd` = the resolved clone and read-only tools (`Read`/`Grep`/`Glob`/
   `git`) to confirm anything beyond the inlined source. A pure API model relies
   on the inlined context (step 2) instead. Select the model with `--model`
   (e.g. `--model sonnet`).

### The core question: external impact vs internal-only

Each PR gets exactly one label, the distinction the user emphasized:

- `INTERNAL_ONLY` — refactor / logging / formatting / tests; no contract change.
- `EXTERNAL_POSSIBLE` — on a request/response or external-call path, but the
  in/out **spec** does not appear to change.
- `EXTERNAL_LIKELY` — the in/out **spec** changed: endpoint added/removed/renamed,
  method/path changed, request/response DTO fields changed, external/s2s call
  contract changed, message topic/payload changed, or DB schema changed.

## Output format

One file **per PR** at `<base>.AI분석결과/<PR번호>.md` — **Korean** Markdown with a
fixed skeleton: 위험도 (LOW/MEDIUM/HIGH) → 변경 요약 → 외부 영향도 (`INTERNAL_ONLY` /
`EXTERNAL_POSSIBLE` / `EXTERNAL_LIKELY`) → 영향 체인 → 삭제/Breaking → 쿼리/성능 →
설정 검토 → 환경별 설정 (dev/stage/prod) → 권장 사항. The fixed skeleton keeps
results scannable and lets the deploy view (`?view=deploy`, the **🤖 AI 영향도 분석**
tab) load the selected PR's report directly. Code identifiers / file paths /
endpoints stay in their original form even though prose is Korean.

---

## Usage

```bash
# 1) build the location index (repoUrl → local clone)
node flowmap-ai/build-index.js

# 2) start the AI-model stand-in (separate shell)
node flowmap-ai/server.js            # http://localhost:8790

# 3) analyze every PR not yet analyzed
node flowmap-ai/run-batch.js
#   --only <substr>   limit to matching project (impact) paths
#   --pr <number>     limit to one PR number (use with --only)
#   --force           re-analyze even if a per-PR result exists
#   --dry-run         build context + prompt only (no model call)
#   --model <id>      pass a model id to the server

# or the whole step in one shot:
sh/15-ai-impact.sh
```

### Env
- `FLOWMAP_AI_PORT` (default `8790`)
- `FLOWMAP_AI_TIMEOUT_MS` (default `600000`)
- `FLOWMAP_REPO_ROOTS` — extra clone parent dirs (path-separator delimited) for
  repos not under an analyzer's `.repo` (e.g. nexcore monorepo clones).

---

## Production migration

`server.js` is the local stand-in for the hosted AI-model API. In production,
keep `build-index.js` + `run-batch.js` (context building is environment-agnostic)
and point the driver at the real endpoint:

```bash
node flowmap-ai/run-batch.js --server https://<prod-ai-api>
```

The request body (`{ prompt, system, repoPath, model }`) and the expected
response (`{ markdown }`) are the contract to keep stable.
```
