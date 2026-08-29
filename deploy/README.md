# flowmap — Kubernetes 배포

flowmap 은 **정적 웹앱**(nginx)과 그 데이터를 만드는 **분석 파이프라인**(배치)으로 나뉜다.
k8s 에선 두 워크로드로 매핑한다.

```
┌─────────────┐  write   ┌──────────────┐  read   ┌──────────────┐
│ CronJob     │ ───────▶ │  PVC         │ ◀────── │ web (nginx)  │
│ (JDK+Node)  │          │ flowmap-data │         │ Deployment   │
│ 분석 파이프 │          │  = web/data  │         │  + Ingress   │
└─────────────┘          └──────────────┘         └──────────────┘
```

| 이미지 | Dockerfile | 내용 | k8s 워크로드 |
|---|---|---|---|
| `flowmap/web` | `Dockerfile.web` | nginx + 정적파일(index.html·web/) | Deployment + Service + Ingress |
| `flowmap/pipeline` | `Dockerfile.pipeline` | JDK17 + Node20 + git, 분석기 3종 빌드 | CronJob (+ 최초 seed Job) |

데이터(`web/data`)는 이미지에 굽지 않고 PVC 로 공유한다 — CronJob 이 쓰고 web 이 읽는다.

---

## 1. 이미지 빌드 (저장소 루트에서)

```bash
# 웹 (정적)
docker build -f deploy/Dockerfile.web \
  -t registry.corp.example.com/flowmap/web:$(git rev-parse --short HEAD) \
  -t registry.corp.example.com/flowmap/web:latest .

# 파이프라인 (JDK+Node, 분석기 사전 빌드)
docker build -f deploy/Dockerfile.pipeline \
  -t registry.corp.example.com/flowmap/pipeline:$(git rev-parse --short HEAD) \
  -t registry.corp.example.com/flowmap/pipeline:latest .
```

> 빌드 컨텍스트는 **저장소 루트**(분석기 3종이 형제 디렉터리로 있어야 함). `deploy/.dockerignore`
> 가 `web/data`·`node_modules`·`.git`·`.repo` 등 무거운/생성물 경로를 제외한다.

### 폐쇄망(사내) 빌드 — 미러로 교체할 지점
| 대상 | 어떻게 |
|---|---|
| 베이스 이미지 | `--build-arg BASE_JDK=registry.corp/library/eclipse-temurin:17-jdk-jammy` / `BASE_NGINX=...` |
| apt / NodeSource | `Dockerfile.pipeline` 의 apt source·`NODESOURCE_URL` 을 사내 미러로 |
| npm | `--build-arg NPM_REGISTRY=https://nexus.corp/repository/npm/` |
| gradle | `GRADLE_USER_HOME` 에 mirror init script 주입(사내 Nexus maven proxy) |

---

## 2. 레지스트리 푸시

```bash
docker push registry.corp.example.com/flowmap/web:latest
docker push registry.corp.example.com/flowmap/pipeline:latest
```

폐쇄망이면 외부에서 받은 베이스 이미지를 `docker pull → docker tag → push` 로 사내 미러에 먼저 올린다.

---

## 3. 배포

매니페스트의 `registry.corp.example.com`, `storageClassName`, ingress `host`,
`20-config.yaml`(분석 대상 REPO·git 토큰)을 **사내 값으로 교체한 뒤**:

```bash
kubectl apply -f deploy/k8s/00-namespace.yaml
kubectl apply -f deploy/k8s/10-pvc.yaml
kubectl apply -f deploy/k8s/20-config.yaml

# 최초 데이터 시드(web 띄우기 전에 1회) — 끝날 때까지 대기
kubectl apply -f deploy/k8s/41-seed-job.yaml
kubectl -n flowmap wait --for=condition=complete job/flowmap-pipeline-seed --timeout=60m

# 웹 + 주기 파이프라인
kubectl apply -f deploy/k8s/30-web-deployment.yaml
kubectl apply -f deploy/k8s/31-web-service.yaml
kubectl apply -f deploy/k8s/32-web-ingress.yaml
kubectl apply -f deploy/k8s/40-pipeline-cronjob.yaml
```

---

## 짚어둘 점

- **PVC 접근모드**: CronJob(write)·web(read)이 다른 노드에 뜰 수 있어 **RWX** 가 필요하다
  (사내 NFS/CephFS 등). RWX 불가 시 두 워크로드를 같은 노드로 고정(nodeAffinity)하고 RWO.
- **분석 대상 소스**: 파이프라인이 `REPO=` 경로의 소스를 git pull/분석한다. 폐쇄망에선
  `40-pipeline-cronjob.yaml` 의 `sources` 볼륨을 사내 소스 PVC 로 바꾸거나, pull 단계가 사내
  git 에서 `/sources` 아래로 clone 하도록 `20-config.yaml` 의 REPO/자격증명을 맞춘다.
- **`.gz` 산출물**: 앱이 fetch 후 JS `DecompressionStream` 으로 직접 푼다 → nginx 가 gzip
  transfer-encoding 을 덧씌우면 안 됨(`nginx.conf` 에서 `.gz` 처리 분리, `gzip_static` 미사용).
- **캐시 버스팅**: 정적 자산은 `index.html` 의 `?v=` 쿼리로 관리(CLAUDE.md). 데이터는
  `nginx.conf` 에서 `no-cache`.
- **더 단순한 대안**: 파이프라인을 CI(GitHub Actions)에서 돌려 `web/data` 를 이미지에 굽고
  web Deployment 하나만 두면 PVC/RWX·CronJob 이 전부 빠진다. (이번 구성은 "분석도 k8s" 요구에 맞춤.)
```
