# Shopflow demo contract (flowmap end-to-end connectivity slice)

A purpose-built, **fully-connected** demo that exercises the analyzers' hardest cases:
deep call depth, API URLs held in variables / constant tables / substituted variables,
server-to-server (S2S) calls, and gateway-prefix routing. Every screen and every
endpoint must connect (directly or via gateway) — **zero orphans**.

This is the join contract shared by three repos:
- `flowmap-spring-kotlin/.repo/shopflow/**`  (backend, multi-module)
- `flowmap-react/.repo/shopflow-web/**`       (frontend)
- `flowmap` (gateway/aggregation + verifier)

## Gateway-prefix convention

`gatewayMatch()` in `flowmap/docs/web/app.js` strips exactly the **first** path segment
and matches the remainder against a backend CONTROLLER. So:

| Frontend calls (gateway path) | strip 1st seg | Backend CONTROLLER endpoint |
|---|---|---|
| `/{service}/{backendPath}` | `/{backendPath}` | `/{backendPath}` |

Frontend gateway base URL: env `VITE_GW_BASE` = `https://gw.shopflow.io`.
Gateway service segments: `user`, `order`, `payment`, `catalog`.

A screen may also call a backend path **directly** (no service prefix) to exercise the
join's Stage-1 direct match. Both modes must end connected.

## Backend endpoints (canonical, post-prefix-strip paths)

| Service (module) | HTTP | endpoint | reached by |
|---|---|---|---|
| shopflow-user    | POST | `/v1/users`                 | FE SignupPage |
| shopflow-user    | GET  | `/v1/users/{id}`            | S2S order→user |
| shopflow-user    | GET  | `/v1/users/{id}/profile`    | FE ProfilePage (direct) |
| shopflow-order   | POST | `/v1/orders`                | FE CheckoutPage (gw `order`) |
| shopflow-order   | GET  | `/v1/orders`                | FE OrderListPage (gw `order`) |
| shopflow-order   | GET  | `/v1/orders/{id}`           | FE OrderDetailPage (gw `order`) |
| shopflow-payment | POST | `/v1/payments`              | FE PaymentPage (gw `payment`) + S2S order→payment |
| shopflow-payment | GET  | `/v1/payments/{id}`         | FE PaymentStatusPage (gw `payment`) |
| shopflow-catalog | GET  | `/v1/catalog/items`         | FE CatalogPage (gw `catalog`) |
| shopflow-catalog | GET  | `/v1/catalog/items/{id}`    | FE ItemDetailPage (gw `catalog`) + S2S order→catalog |

Every endpoint above has ≥1 inbound edge (FE join and/or S2S). No orphan endpoints.

## Server-to-server (S2S) chains (backend → backend)

- `shopflow-order`  OrderService → **user-service**    `GET /v1/users/{id}`        (Feign, url from yaml `service-url.user`)
- `shopflow-order`  OrderService → **payment-service** `POST /v1/payments`         (Feign, url from yaml `service-url.payment`)
- `shopflow-order`  OrderService → **catalog-service** `GET /v1/catalog/items/{id}`(WebClient, baseUrl const + path const)
- `shopflow-payment` PaymentService → **user-service** `GET /v1/users/{id}`        (RestTemplate, url built from const + var)

S2S edges are produced by the backend `combine` step matching `ext:` Feign/WebClient
targets to other services' CONTROLLER endpoints by `(httpMethod, normPath)`.

## Variable / constant / substituted-URL requirements

**Backend** — endpoints and client URLs must NOT be inline string literals at the call site:
- Controllers map paths via a constant object, e.g. `@RequestMapping(ApiPaths.ORDERS)` where
  `object ApiPaths { const val ORDERS = "/v1/orders" }` in `shopflow-common`.
- Feign clients: `@FeignClient(name="user-service", url="\${service-url.user}")` +
  `@GetMapping(UserPaths.BY_ID)`; url resolved from `application.yml`.
- WebClient/RestTemplate: base URL from `@Value`/const, path from const object, composed via
  string concatenation / variable indirection (`val path = PAYMENT_PATHS[action]`).

**Frontend** — call sites must resolve through a chain of consts/vars/env, never an inline literal:
- `const GW_BASE = import.meta.env.VITE_GW_BASE`
- `const SVC = { ORDER: 'order', USER: 'user', PAYMENT: 'payment', CATALOG: 'catalog' } as const`
- `const ORDER_PATHS = { CREATE: '/v1/orders', DETAIL: (id) => `/v1/orders/${id}` } as const`
- `API_ROUTES.order.create = `${GW_BASE}/${SVC.ORDER}${ORDER_PATHS.CREATE}``
- Substituted variable indirection: `const path = ORDER_PATHS[action]; return request({ url: path })`.

## Deep call-depth requirement (≥4 hops from screen to HTTP call)

Frontend:  `Page (SCREEN)` → `useXxx() hook` → `redux thunk / store action` → `xxxApi.fn()` →
           `request(cfg)` wrapper → `http.request(cfg.url)` (axios instance, baseURL=env).

Backend:   `Controller` → `AppService` → `DomainService` → `XxxGateway` (port) →
           `XxxClient` (Feign/WebClient/RestTemplate) → external HTTP call.

## Verifier gate (flowmap/tests/check-connectivity.mjs)

DEMO_PROJECTS = `shopflow,shopflow-web`. For demo projects only, FAIL if any of:
1. A demo SCREEN node cannot transitively reach an API/EXTERNAL/CONTROLLER node.
2. A frontend API/EXTERNAL node reachable from a demo SCREEN has no `join` edge to a backend CONTROLLER.
3. A demo backend CONTROLLER endpoint has zero inbound edges (no FE join, no S2S, no internal caller).
4. Any demo node has total degree 0 (orphan).
5. A frontend API node reachable from a demo SCREEN has `confidence != resolved` or a residual `urlPlaceholder`.
Global (non-demo) stats are printed for context but do not fail the gate.
