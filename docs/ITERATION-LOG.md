# Shopflow connectivity — iteration log

Loop: each iteration adds deeper / trickier samples (deep call depth, API URLs in
variables/constants/substituted, S2S chains, gateway prefixes), runs the REAL pipeline
(`flowmap-react: ./flowmap pipeline` → `flowmap-spring: ./gradlew run` refresh →
`flowmap: node tests/check-connectivity.mjs`), and must pass the demo gate with **zero
orphans**. Stop after **5 consecutive clean passes**.

Run one iteration: `bash flowmap/scripts/iterate.sh`

| # | new complexity added | verifier | fixes needed | clean-streak |
|---|---|---|---|---|
| 1 | baseline shopflow slice (9 screens, 10 endpoints, 4 S2S; const/env/wrapper URLs) | ✅ PASS | verifier absorbed-node removal; module-aware S2S in app.js; slice-container→action edge in ts-analyzer graphBuilder | — (had fixes) |
| 2 | +review service (2 ep, 5-level chain, review→user S2S, deeper FE hook nesting) | ✅ PASS (first-try) | none | 1 |
| 3 | +shipping service; backend **constant-concat** endpoint `@GetMapping(A+B)`; FE redux-thunk flow; shipping→order S2S | ✅ PASS (first-try) | none | 2 |
| 4 | +inventory service; FE **axios instance baseURL embeds gateway segment** + relative path consts (baseURL compose); inventory→user S2S | ✅ PASS (first-try) | none | 3 |
| 5 | +search service; FE **direct (non-gateway) call** via 2nd env host → join Stage-1 direct match; search→catalog S2S | ✅ PASS (first-try) | reordered pipeline (spring→react→resync) + direct-match fallback in app.js & verifier | 4 |
| 6 | +wishlist service; FE **deep JSX render chain** Page→Panel→Button→hook→API; wishlist→user S2S | ✅ PASS (first-try) | none | 5 ✅ STOP |

## Result

**5 consecutive clean passes (iterations 2–6).** Final demo: 17 screens, 18 frontend API
calls (all resolved + joined), 19 backend endpoints (all inbound ≥1), 9 S2S edges, **zero
orphans**. Every screen/endpoint connects via gateway-prefix, direct call, or S2S.

Analyzer hardening landed in iteration 1 (both analyzers) + the gateway/verifier; iterations
2–6 added new services with escalating resolution patterns (const tables, env, wrapper chains,
path-builder fns, substituted vars, constant concatenation, baseURL composition, direct vs
gateway routing, deep render/hook chains, Feign/WebClient/RestTemplate S2S) and all passed
**without further analyzer changes** — demonstrating robustness.

Reproduce any single pass: `bash flowmap/scripts/iterate.sh`
