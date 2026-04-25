# Storefront Observability
 
**Live:** https://agoda.viveksonar.in
 
Agoda published an engineering article in February 2026 describing how they built Storefront - a Rust-based reverse proxy that fixes S3 load balancing failures on their VAST storage cluster. The article describes three specific failure modes they encountered and the fixes they implemented.
 
What the article did not describe is what we monitor to know those fixes are holding, or to catch the next failure before it becomes an incident.
 
This project is the observability layer for Storefront. It's not a reimplementation of what Agoda built, it's what I would build on top of it to make sure it stays healthy in production.

---
 
## The product problem
 
There are two different problems here and it matters to keep them separate.
 
**The engineering problem**: is Storefront routing S3 traffic correctly right now? That is a monitoring problem. It has a well-known solution - metrics, dashboards, alerts.
 
**The product problem** is a TPM owning Storefront needs to answer questions that monitoring alone cannot answer:
 
- When connection exhaustion fires on vast-03, whose S3 client is causing it? Without attribution, the TPM manually asks every team. With attribution, they walk into the conversation with evidence.
- When an incident clears, what did it cost in terms of reliability commitments? A distribution score of 0 means something to engineers. "We burned 43% of our monthly error budget in one incident" means something to stakeholders.
- At the current rate of connection growth, when does the first backend hit its limit? The Kafka team documented that disk % was a lagging indicator, by the time it triggered, they were already degraded. Connection count has the same problem.
- How do I explain last night's incident to my director without spending an hour reconstructing what happened from Slack messages?
The monitoring layer answers the first question. The other four require a product layer built on top of monitoring. That is what this dashboard attempts to be.
 
---
## What is actually running
 
The project has four layers, each one building on the last.
 
**Monitoring** - live health of 8 VAST backends: connection utilisation, requests per second, P99 latency, IO timeout rate. Distribution score (0–100) as the north star metric. A score of 100 means perfectly balanced load. A score of 0 means one backend is absorbing everything — which is the DNS stickiness failure mode documented in the Storefront article.
 
**Incident reporting** - every mode change persists to SQLite. When a failure mode is triggered and resolved, the system records start time, end time, peak metrics, and affected backends. One button generates a structured post-mortem. This removes the 20-minute war room debrief that Agoda's own OpenTelemetry article named as the primary cost of poor observability.
 
**Capacity forecasting** - linear trend projection per backend, three scenarios (normal / 2× traffic / 3× traffic), confidence level based on data point count. The Kafka team learned that disk percentage is a lagging indicator. Connection count is the equivalent lagging indicator for Storefront. Growth rate is the leading indicator. This tab is a simplified version of what Vulcan — Agoda's unpublished capacity management system, first mentioned in June 2024 — would automate across 1,500 services.
 
**SLO burn rate** - translation layer between engineering metrics and business commitments. SLO: 99.5% of S3 requests complete with distribution score above 80. Error budget: 21.6 minutes per month. Burn rate tracks how fast that budget is being consumed. Burn rate above 14.4× means the monthly budget exhausts in two days. This is the number you put in front of leadership, not the P99.
 
**Client attribution** - which internal service is causing backend degradation. Eight simulated Agoda services (booking-api, search-results-svc, finudp-spark-job, kafka-mirror-svc, legacy-etl-job, and others). In connection exhaustion mode, legacy-etl-job is surfaced as the bad S3 client with a direct routing recommendation to the Data Platform team. The three-panel sequence — alert fires, backend identified, client attributed — is the complete incident diagnosis flow. Without the third step, a TPM still has to manually find the owner.
 
---
 
## Architecture
 
```
storefront-observability/
├── backend/                                FastAPI, uvicorn (Python 3.x)
│   ├── main.py                             REST API - health, metrics, forecast, simulate, incidents, SLO
│   ├── simulator.py                        Metric + failure-mode simulation; forecast & SLO burn logic
│   ├── incident_store.py                   SQLite persistence (incidents, timelines)
│   ├── requirements.txt                    fastapi, uvicorn
│   └── Dockerfile
├── frontend/                               React 18, Vite 5, Recharts
│   ├── public/
│   │   └── favicon.png                     Tab / apple-touch icon
│   ├── src/
│   │   ├── main.jsx                        App bootstrap
│   │   ├── App.jsx                         Tabs, polling, failure-mode triggers
│   │   ├── api.js                          fetch helpers, API base URL
│   │   ├── index.css                       Global styles, failure-dropdown nudge/hint
│   │   ├── data/
│   │   │   └── failureModes.js             Failure mode metadata for dropdown
│   │   └── components/
│   │       ├── SummaryBar.jsx              Headline cluster metrics
│   │       ├── BackendGrid.jsx             8 VAST backend cards
│   │       ├── AnomalyPanel.jsx            Active anomaly alerts
│   │       ├── ClientAttributionPanel.jsx  Per-client S3-style attribution
│   │       ├── FailureModeDropdown.jsx     Scenario simulator (dropdown + nudge)
│   │       ├── TimelineChart.jsx           Rolling history chart
│   │       ├── IncidentPanel.jsx           Incident list & drill-down
│   │       ├── ReportModal.jsx             Markdown incident report
│   │       ├── ForecastTab.jsx             Capacity forecast / scenarios
│   │       └── SLOTab.jsx                  Error budget / burn view
│   ├── index.html                          Title, fonts, favicon links
│   ├── vite.config.js                      Dev proxy → FastAPI
│   ├── nginx.conf                          SPA + proxy /metrics, /incidents, … to backend
│   ├── env.example                         Optional VITE_API_BASE_URL
│   └── Dockerfile                          Multi-stage: node:20-alpine → nginx:alpine
├── k8s/
│   ├── namespace.yaml
│   ├── backend.yaml                        Deployment + Service (port 8000)
│   ├── frontend.yaml                       Deployment + Service (port 80)
│   ├── ingress.yaml                        ingress-nginx paths → frontend / backend
│   ├── kustomization.yaml                  Kustomize entry + replacements
│   ├── deploy.env.example                  Host / TLS / image placeholders
│   ├── ssl-params.env                      SSL-related replacements (gitignored pattern)
│   ├── apply.sh                            kubectl apply helper
│   └── install-ingress-nginx.sh            Ingress controller install notes/script
├── scripts/
│   └── dev-local.sh                        Local uvicorn on fixed port
└── .github/
    └── workflows/
        └── deploy-main.yml                 CI deploy workflow
```
 
The backend runs on FastAPI because the workload is IO-bound and stateless between requests, there is no JVM off-heap problem, no GC pause risk, no reason to reach for a heavier runtime. The frontend polls four endpoints simultaneously via `Promise.all` - single round-trip per three-second interval rather than four sequential fetches.
 
---

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Liveness - `{"status": "ok"}` |
| GET | `/metrics/backends` | Per-backend connections, RPS, P99 latency, IO timeouts, health |
| GET | `/metrics/summary` | Fleet totals - RPS, connections, cross-DC %, timeouts, unhealthy count, distribution score, mode |
| GET | `/metrics/anomalies` | Active anomaly alerts (connection, cross-DC, latency, etc.) |
| GET | `/metrics/clients` | Per-client S3 attribution / traffic drivers |
| GET | `/metrics/history` | ~60-tick rolling history for timeline chart |
| GET | `/metrics/forecast` | Capacity forecast - per-backend trends, Normal / 2× / 3× scenarios, `simulator_mode`, fleet summary |
| GET | `/metrics/forecast/` | Same as `/metrics/forecast` |
| GET | `/forecast` | Alias for `/metrics/forecast` (for proxies that drop `/metrics`) |
| GET | `/metrics/slo` | SLO burn - distribution-score budget, windows, narrative fields |
| POST | `/metrics/slo/reset` | Reset consumed error budget (demo) |
| POST | `/simulate/{failure_mode}` | Set simulator: `normal`, `dns_stickiness`, `connection_exhaustion`, `cross_dc_throttling` |
| GET | `/incidents` | Last 20 incidents (newest first) |
| GET | `/incidents/active` | Active incident or JSON `null` |
| GET | `/incidents/{incident_id}` | One incident + event timeline |
| GET | `/incidents/{incident_id}/report` | Markdown post-mortem (`text/plain`) |

---

## Failure modes (For simulator)
 
All three are sourced directly from the Storefront engineering article (February 2026).
 
**DNS stickiness** - the original problem that motivated Storefront. Applications cache DNS results for arbitrary durations. Agoda's internal DNS (Microsoft implementation) has a minimum TTL of one second. Under high-volume S3 workloads, an application resolves one virtual IP at startup and sends all traffic there for the session. vast-01 absorbs 76–78% of requests. Distribution score drops to zero. Two critical alerts fire.
 
**Connection exhaustion** - a bad S3 client does not fully read HTTP responses. Connections remain open waiting for the client to drain the response buffer. The client never does. Connections accumulate on vast-03 and vast-04 over approximately 80 seconds. The ramp is gradual, which is why the timeline chart matters. The point-in-time backend cards show a problem. The 60-tick trend line shows the failure pattern that would have allowed early intervention.
 
**Cross-DC throttling** - a large backup replication job saturates the two dedicated cross-DC VAST backends (vast-07, vast-08). The non-obvious failure: same-DC backends not involved in cross-DC traffic still show elevated P99 latency — from 4ms to 28ms - because they share VAST cluster resources with the saturated nodes. The `cross_dc_collateral` alert fires when three or more same-DC backends show P99 above 15ms. This is the failure a naive dashboard misses entirely.
 
---
## What this would look like in production
 
Right now the backend generates simulated metrics. In a real deployment, you would replace the simulator with scrapers reading from actual Storefront telemetry.
 
Storefront exposes internal metrics via its Pingora-based proxy layer. A Prometheus exporter would scrape connection counts, request rates, and latency histograms per backend. The FastAPI backend would become a thin aggregation and alerting layer on top of those real metrics, the alert logic, the SLO calculation, and the incident persistence would remain unchanged.
 
Agoda adopted OpenTelemetry as their tracing standard in June 2024 - described as "just beginning" at that point. The OTel article describes trace ID injection in browser responses for customer service agents. Storefront's S3 proxy could emit trace spans for each request, which would enable request-level attribution rather than simulated client traffic patterns.
 
Grafana dashboards would replace or augment the React frontend for on-call engineers. The React dashboard serves a different user - a TPM reviewing system health, preparing a weekly status report, or briefing a director after an incident. These are not the same user as an engineer responding to a 3am page.

---

## Kubernetes deployment

Deployed on **DigitalOcean Kubernetes**, **Singapore** region (**for lower latency to the user visiting from thailand**). 
**HTTPS** via **cert-manager** with **Let's Encrypt**. **Ingress-nginx** exposes **one LoadBalancer IP**; DNS targets that IP. API and UI share a hostname with **path-based routing** (`ingress.yaml`): `/metrics`, `/forecast`, `/simulate`, `/incidents`, `/health` → backend Service; `/` → nginx frontend.

Every configuration decision in the deployment manifests is intentional.

<img alt="Kubernetes" src="https://github.com/user-attachments/assets/d689681b-8e9f-4e76-bb9c-f0403644dc63" />




### Backend (`storefront-obs-backend`)

**CPU requests equal limits (`250m` both).** Agoda’s Kubernetes migration article described a service hitting **CFS throttling at ~43% CPU utilisation** because **limits exceeded requests**, creating burst headroom inside the quota window; under load, threads still stalled. **`requests == limits`** removes that burst gap for the FastAPI process. Source: *Private Cloud and You*, Agoda Engineering, November 2022.

**Memory limit at 2× request (`128Mi` request, `256Mi` limit).** Python has **no JVM-style off-heap** footprint (Metaspace, JIT arenas, etc.), so we do **not** apply JVM-specific headroom recipes. A conventional **2× limit over request** leaves room for Python allocator growth and spikes without implying heap tuning from the JVM migration story.

**Replicas set to `1`.** The **MetricSimulator state is in-process memory**: one Python process owns simulation + SQLite-backed incidents tied to that process’s lifecycle. With multiple replicas behind a plain round-robin, **`POST /simulate` on pod A** and **`GET /metrics/forecast` on pod B** would look like the UI “lost” the failure mode. The manifests document scaling to **2+** only together with **session affinity or shared state**. The backend Service sets **`sessionAffinity: ClientIP`** (`10800s`) so if you scale up later, the same client tends to stick to one backend **from the frontend pod’s outbound IP** pattern, still not a substitute for externalizing state in production.

**Readiness/liveness on `GET /health`.** Keeps draining and restarts bounded to pods that actually serve traffic.

---

### Frontend (`storefront-obs-frontend`)

**CPU request `50m`, limit `200m` - burstable.** Static nginx + SPA assets rarely need sustained CPU; a **low request** preserves scheduling density on small nodes; a **higher limit** allows short bursts (gzip, spikes) without clamping requests to limits the way we do on the backend. This is **not** the same policy as FastAPI on purpose.

**Memory `64Mi` request, `128Mi` limit (2×).** Fits nginx worker RSS with headroom for buffers; keeps the footprint small on a demo cluster.

**Replicas `1`.** Stateless UI; scaling out is trivial later. A single replica avoids extra image pulls and aligns with **demo/minimal footprint** unless you require HA.

---

### Ingress & TLS

**cert-manager** annotations wire **Let's Encrypt** issuers via Kustomize replacements (`replaceme-*` placeholders in `ingress.yaml`). **Prefix paths** send API traffic to the backend without exposing a second hostname-browser calls same origin from the SPA where nginx proxies in Docker; in K8s the Ingress does the split explicitly.

---

### Namespace — Istio (`namespace.yaml`)

**`istio-injection: enabled` is commented out.** When Istio is installed, uncommenting **`istio-injection`** matches how Agoda’s fleet can attach **Envoy** for patterns like External Processor / Gatekeeper-style enforcement. The label is **documented in-repo** and stays off until the mesh exists so pods are not stuck `Pending` on missing sidecars.

---

### Trade-offs you should know

| Choice | Why |
|--------|-----|
| Backend **1** replica | Correctness of in-memory simulator + SQLite path with minimal moving parts |
| Backend **CPU rq=lim** | Predictable scheduling, avoids CFS surprise throttling for **this** workload story |
| Frontend **CPU rq≠lim** | Cheap scheduling + burst for nginx |
| Path-based Ingress | Single TLS hostname, clear split UI vs API |

---
## Running locally
### Backend
From the repo root (recommended - pins **8000** so it matches the Vite proxy):
```bash
chmod +x scripts/dev-local.sh   # once, if needed
./scripts/dev-local.sh
```
API base: http://127.0.0.1:8000 (health check: GET http://127.0.0.1:8000/health).

### Frontend (second terminal)
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 - the Vite dev server proxies /metrics, /forecast, /simulate, /incidents, /health to http://127.0.0.1:8000 (frontend/vite.config.js).

If the API is not on 8000:
```
# frontend/.env.local
VITE_PROXY_TARGET=http://127.0.0.1:<port> npm run dev
```
(restart npm run dev after changing env.)

---
## Prometheus & Grafana

```bash
# Install kube-prometheus-stack
helm repo add prometheus-community \
  https://prometheus-community.github.io/helm-charts
helm repo update

# Values live in repo: k8s/helm-monitoring-kps-values.yaml — uses the block key
# grafana.grafana.ini (not a nested grafana: key) so /grafana subpath and redirects
# (e.g. /grafana/login) stay on-path instead of redirecting the browser to /login
# and the SPA. Add --skip-crds only if Prometheus operator CRDs are already in the
# cluster (e.g. from a prior install or the CI pre-apply).
helm upgrade --install monitoring \
  prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  -f k8s/helm-monitoring-kps-values.yaml \
  --wait --timeout=15m

# The three false flags are critical — without them Prometheus
# ignores ServiceMonitors, PodMonitors, and PrometheusRules
# outside the monitoring namespace.

# Apply Storefront monitoring config
kubectl apply -k k8s

# If `kubectl apply -k k8s` errors with "no matches for kind ServiceMonitor / PrometheusRule",
# the cluster does not have Prometheus Operator CRDs yet. Install kube-prometheus-stack first
# (recommended), or apply the upstream CRDs for those two kinds. The GitHub Actions deploy
# workflow applies the pinned CRD manifests automatically before `kubectl apply -k k8s/`.

# Verify Prometheus is scraping the backend
kubectl port-forward -n monitoring svc/monitoring-prometheus 9090:9090
# Visit localhost:9090/targets — storefront-obs-backend should show UP

# Import Grafana dashboard
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
# Visit localhost:3000 (admin/storefront123)
# Dashboards → Import → paste k8s/grafana-dashboard.json

# In-cluster URL (single host, path routing via ingress):
# https://agoda.viveksonar.in/grafana
```

`k8s/grafana-proxy-service.yaml` is required for `/grafana`: the main Ingress lives in
`storefront-obs` but the real Grafana Service is in `monitoring` —Kubernetes Ingress
cannot cross namespaces, so a same-namespace `ExternalName` Service points at
`monitoring-grafana.monitoring.svc.cluster.local`. If you used a different Helm
release name than `monitoring`, change that FQDN to `<release-grafana>.monitoring.svc.cluster.local`.

**503 on `/grafana`:** usually the Ingress had no in-namespace backend, Grafana pods
in `monitoring` are not ready, or the Helm FQDN above does not match your release name.

**Redirect to `/login` (main site) instead of `/grafana/login`:** Grafana was not
given a valid `grafana.ini` `root_url` + `serve_from_sub_path` (a wrong `helm --set`
path is a common cause). After fixing with `k8s/helm-monitoring-kps-values.yaml` and
`helm upgrade`, `https://agoda.viveksonar.in/grafana/login` should return 200 on
that path, not 302 to `/login`.

---
## Every design decision and its source

| Decision | Reasoning | Source |
|----------|-----------|--------|
| 8 VAST backends in the pool | Realistic pool size for a VAST cluster at Agoda's data scale | [Storefront article, Feb 2026](https://medium.com/agoda-engineering/how-agoda-built-its-own-s3-compatible-proxy-dubbed-storefront-bfab78f34ef8) |
| 500 connection limit per backend | Hard limit on VAST compute nodes documented in the article | [Storefront article, Feb 2026](https://medium.com/agoda-engineering/how-agoda-built-its-own-s3-compatible-proxy-dubbed-storefront-bfab78f34ef8) |
| 60ms cross-DC P99 baseline | Realistic inter-DC round-trip latency between Asian datacenters | [Inside Agoda's Private Cloud, 2023](https://newsletter.pragmaticengineer.com/p/inside-agodas-private-cloud) |
| Distribution score as north star | Single metric answering "is Storefront working right now?" | [Storefront article, Feb 2026](https://medium.com/agoda-engineering/how-agoda-built-its-own-s3-compatible-proxy-dubbed-storefront-bfab78f34ef8) |
| `cross_dc_collateral` alert (3+ same-DC backends at P99 >15ms) | Catches blast radius that per-backend alert would miss | [Storefront article, Feb 2026](https://medium.com/agoda-engineering/how-agoda-built-its-own-s3-compatible-proxy-dubbed-storefront-bfab78f34ef8) |
| 80-tick connection exhaustion ramp | Matches gradual accumulation pattern of the real failure | [Storefront article, Feb 2026](https://medium.com/agoda-engineering/how-agoda-built-its-own-s3-compatible-proxy-dubbed-storefront-bfab78f34ef8) |
| SLO: 99.5% of requests, 30-day window | Standard SRE error budget calculation | [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/) |
| Burn rate >14.4× = 2-day exhaustion | Fast burn rate threshold | [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/) |
| Capacity forecast: growth rate not utilisation | Agoda documented that disk % was a lagging indicator for Kafka | [Agoda Kafka article, 2023](https://medium.com/agoda-engineering/how-agoda-manages-1-8-trillion-events-per-day-on-kafka-1d6c3f4a7ad1) |
| Client attribution: 8 named internal services | Makes failure actionable - gives TPM a team to call | [FINUDP article, Jan 2026](https://www.infoq.com/news/2026/01/agoda-unified-data-pipeline/) |
| War room reduction as primary metric | Explicitly named as the cost of poor observability | [OTel article, June 2024](https://medium.com/agoda-engineering/enhancing-developer-efficiency-our-journey-with-opentelemetry-tracing-7c440f99b625) |
| Vulcan note in forecast tab | Unpublished capacity system - still active work | [Load shedding article, June 2024](https://medium.com/agoda-engineering/load-shedding-private-cloud-first-81ddd5ab53ac) |
| CPU requests == limits (250m) | Eliminates CFS burst throttling - service hit 43% CPU, still throttled | [Private Cloud and You, Nov 2022](https://medium.com/agoda-engineering/private-cloud-and-you-736d8d99a51e) |
| Memory limit at 2× request | Python has no JVM off-heap footprint - no jemalloc needed | [Private Cloud and You, Nov 2022](https://medium.com/agoda-engineering/private-cloud-and-you-736d8d99a51e) |
| replicas: 2 | Mirrors Agoda's active-active DC deployment pattern | [Retry storms article, Aug 2024](https://medium.com/agoda-engineering/load-shedding-private-cloud-first-81ddd5ab53ac) |
| Incident auto-report feature | Torq case study confirmed MTTR reduction is active company priority | [Torq case study, Nov 2025](https://torq.io/resources/agoda-travel-services/) |

---

## Engineering blog references

Every architectural decision, metric threshold, and failure scenario in this project traces back to a specific Agoda engineering publication.

- [Storefront: S3-compatible reverse proxy](https://medium.com/agoda-engineering/how-agoda-built-its-own-s3-compatible-proxy-dubbed-storefront-bfab78f34ef8) - Agoda Engineering, February 2026
- [How Agoda Handles Load Shedding in Private Cloud](https://medium.com/agoda-engineering/load-shedding-private-cloud-first-81ddd5ab53ac) (Gatekeeper v2, Vulcan) - Agoda Engineering, June 2024
- [Enhancing Developer Efficiency: Our Journey with OpenTelemetry](https://medium.com/agoda-engineering/enhancing-developer-efficiency-our-journey-with-opentelemetry-tracing-7c440f99b625) - Agoda Engineering, June 2024
- [How Agoda Transitioned to Private Cloud](https://medium.com/agoda-engineering/private-cloud-and-you-736d8d99a51e) (CFS throttling, K8s resource config) - Agoda Engineering, November 2022
- [How Agoda manages 1.8 trillion Events per day on Kafka](https://medium.com/agoda-engineering/how-agoda-manages-1-8-trillion-events-per-day-on-kafka-1d6c3f4a7ad1) (capacity planning, lagging indicators) - Agoda Engineering, 2023
- [How Agoda Handles Kafka Consumer Failover Across Data Centers](https://medium.com/agoda-engineering/how-agoda-handles-kafka-consumer-failover-across-data-centers-a3edbacef6d0) - Agoda Engineering, June 2025
- [Financial Unified Data Pipeline (FINUDP)](https://www.infoq.com/news/2026/01/agoda-unified-data-pipeline/) - Agoda Engineering / InfoQ, January 2026
- [Inside Agoda's Private Cloud](https://newsletter.pragmaticengineer.com/p/inside-agodas-private-cloud) - The Pragmatic Engineer, May 2023
- [Agoda Accelerates Security Incident Response](https://torq.io/resources/agoda-travel-services/) (Torq MTTR case study) - Torq, November 2025
- [Agoda scales AI strategy, opens new APAC tech hub](https://www.computerweekly.com/news/366640804/Agoda-scales-AI-strategy-opens-new-APAC-tech-hub) (1M CPU cores, 4T Kafka messages/day) - Computer Weekly, April 2026

---
