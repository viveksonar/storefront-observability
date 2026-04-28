import logging
import os
import socket

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from prometheus_client import (
    Gauge,
    REGISTRY,
    PLATFORM_COLLECTOR,
    PROCESS_COLLECTOR,
    disable_created_metrics,
    make_asgi_app,
)
from starlette.exceptions import HTTPException as StarletteHTTPException

from simulator import MetricSimulator
import incident_store
import uvicorn

logger = logging.getLogger(__name__)

disable_created_metrics()
for collector in (PROCESS_COLLECTOR, PLATFORM_COLLECTOR):
    try:
        REGISTRY.unregister(collector)
    except (KeyError, ValueError):
        pass

storefront_backend_connections = Gauge(
    "storefront_backend_connections",
    "Active connections per VAST backend",
    ["backend_id", "is_cross_dc"],
)
storefront_backend_rps = Gauge(
    "storefront_backend_rps",
    "Requests per second per VAST backend",
    ["backend_id"],
)
storefront_backend_latency_p99_ms = Gauge(
    "storefront_backend_latency_p99_ms",
    "P99 latency milliseconds per VAST backend",
    ["backend_id", "is_cross_dc"],
)
storefront_distribution_score = Gauge(
    "storefront_distribution_score",
    (
        "Load distribution score 0 to 100. 100 equals perfect balance across backends. "
        "Below 80 triggers SLO violation."
    ),
)


def _resolve_listen_port() -> int:
    """Use PORT env if set; otherwise pick first free port in 8000–8009."""
    if env_port := os.environ.get("PORT"):
        return int(env_port)
    for candidate in range(8000, 8010):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("0.0.0.0", candidate))
            except OSError:
                continue
            return candidate
    raise RuntimeError("No free TCP port found in range 8000–8009")

app = FastAPI(title="Storefront Observability API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _configure_tracing(fastapi_app: FastAPI) -> None:
    """
    Enable OpenTelemetry traces when an OTLP endpoint is configured.

    Default endpoint targets the in-cluster collector service installed by
    k8s/install-tracing.sh.
    """
    endpoint = os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "http://otel-collector-opentelemetry-collector.monitoring.svc.cluster.local:4318",
    )
    service_name = os.environ.get("OTEL_SERVICE_NAME", "storefront-obs-backend")
    sample_ratio = float(os.environ.get("OTEL_TRACES_SAMPLER_ARG", "1.0"))
    sample_ratio = min(max(sample_ratio, 0.0), 1.0)

    resource = Resource.create(
        {
            "service.name": service_name,
            "deployment.environment": os.environ.get("ENVIRONMENT", "dev"),
        }
    )
    tracer_provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(sample_ratio)),
    )
    tracer_provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=f"{endpoint.rstrip('/')}/v1/traces",
            )
        )
    )
    trace.set_tracer_provider(tracer_provider)
    FastAPIInstrumentor.instrument_app(
        fastapi_app,
        tracer_provider=tracer_provider,
        excluded_urls="/health,/prometheus-metrics",
    )
    logger.info("Tracing enabled: OTLP HTTP exporter to %s", endpoint)


_configure_tracing(app)


@app.middleware("http")
async def api_errors_return_json(request: Request, call_next):
    """Prevent HTML 500 bodies — frontend fetchJson expects application/json."""
    try:
        return await call_next(request)
    except StarletteHTTPException:
        raise
    except RequestValidationError:
        raise
    except Exception:
        logger.exception("Unhandled server error on %s", request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_server_error",
                "path": str(request.url.path),
                "detail": "Internal Server Error",
            },
        )


sim = MetricSimulator()


def _sync_storefront_prometheus_gauges() -> dict:
    """
    One source of truth for the simulator tick + storefront_* Prometheus gauges.

    Called from GET /metrics/backends and on every /prometheus-metrics scrape so Grafana
    sees the same numbers as the UI even when no browser is open (previously gauges only
    updated when the frontend polled /metrics/backends).
    """
    data = sim.get_backend_metrics()
    backends = data.get("backends", [])

    total_rps = sum(float(b.get("rps", 0.0)) for b in backends)
    n_backends = len(backends)
    ideal_rps = (total_rps / n_backends) if n_backends else 0.0
    if ideal_rps <= 1e-12:
        distribution_score = 100.0
    else:
        max_rps = max(float(b.get("rps", 0.0)) for b in backends)
        distribution_score = round(max(0.0, 100.0 - (max_rps - ideal_rps) / ideal_rps * 100.0), 1)

    for backend in backends:
        backend_id = str(backend.get("id", "unknown"))
        is_cross_dc = str(backend.get("is_cross_dc", False))
        storefront_backend_connections.labels(
            backend_id=backend_id,
            is_cross_dc=is_cross_dc,
        ).set(float(backend.get("connections", 0.0)))
        storefront_backend_rps.labels(backend_id=backend_id).set(float(backend.get("rps", 0.0)))
        storefront_backend_latency_p99_ms.labels(
            backend_id=backend_id,
            is_cross_dc=is_cross_dc,
        ).set(float(backend.get("latency_p99_ms", 0.0)))

    storefront_distribution_score.set(distribution_score)
    return data


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/metrics/backends")
def get_backends():
    """
    Per-backend connection counts, request distribution, and health.
    Mirrors what a TPM owning Storefront would monitor after the
    DNS load-balancing fix (Storefront article, Feb 2026).
    """
    return _sync_storefront_prometheus_gauges()

@app.get("/metrics/anomalies")
def get_anomalies():
    """
    Active anomaly alerts — connection exhaustion, cross-DC throttling,
    expect:continue latency spikes. All three failure modes documented
    in the Storefront engineering article.
    """
    return sim.get_anomalies()

@app.get("/metrics/summary")
def get_summary():
    """
    Aggregate system health: total RPS, cross-DC traffic %,
    IO timeout rate, and overall load distribution score.
    """
    return sim.get_summary()


@app.get("/metrics/clients")
def get_client_metrics():
    """
    Simulated per-client S3 attribution — which internal service drives backend load.
    FINUDP-style single pane (Jan 2026 article): answers 'whose client?' during incidents.
    """
    return sim.get_client_metrics()


@app.get("/metrics/slo")
def get_slo_metrics():
    """
    Storefront SLO burn rate — distribution score budget (99.5% / score>80).
    Translates engineering signals into executive-facing reliability language.
    """
    return sim.get_slo_metrics()


@app.post("/metrics/slo/reset")
def reset_slo_budget_endpoint():
    """
    Reset consumed error budget (demo only). Incident resolve does NOT reset budget.
    """
    return sim.reset_slo_budget()


@app.post("/simulate/{failure_mode}")
def trigger_failure(failure_mode: str):
    """
    Trigger one of the three documented failure modes for demo:
    - dns_stickiness: pre-Storefront state, one backend absorbs 80% traffic
    - connection_exhaustion: bad S3 client not reading responses
    - cross_dc_throttling: backup replication saturating shared VAST nodes
    """
    valid = ["dns_stickiness", "connection_exhaustion", "cross_dc_throttling", "normal"]
    if failure_mode not in valid:
        return {"error": f"Unknown mode. Valid: {valid}"}
    sim.set_mode(failure_mode)
    return {"mode": failure_mode, "message": f"Switched to {failure_mode} mode"}

@app.get("/metrics/history")
def get_history():
    """Last 60 ticks of aggregate metrics for the timeline chart."""
    return sim.get_history()


@app.get("/metrics/forecast")
@app.get("/metrics/forecast/")
def get_forecast():
    """
    Per-backend connection trend (linear regression) and hours to warning/critical.

    Mirrors Agoda's Kafka capacity lesson: saturation is lagging — growth rate is leading.
    Scenarios scale the trend (promotional 2×, major event 3×) like a manual Vulcan preview.
    """
    return sim.get_forecast()


@app.get("/forecast")
def get_forecast_prefix_alias():
    """
    Compatibility: some misconfigured proxies strip the `/metrics` path prefix.
    Prefer GET /metrics/forecast in production.
    """
    return sim.get_forecast()


@app.get("/incidents")
def list_incidents():
    """Last 20 incidents, newest first — persisted post-mortem index."""
    return incident_store.get_incidents(20)


@app.get("/incidents/active")
def active_incident():
    """Current active incident, or JSON null."""
    row = incident_store.get_active_incident()
    return row if row else None


@app.get("/incidents/{incident_id}")
def incident_detail(incident_id: int):
    """Single incident plus ordered event timeline."""
    data = incident_store.get_incident_by_id(incident_id)
    if not data:
        return {"error": "Incident not found"}
    return data


@app.get("/incidents/{incident_id}/report", response_class=PlainTextResponse)
def incident_report(incident_id: int):
    """Auto-generated markdown incident brief for TPM distribution."""
    md = incident_store.build_incident_report_markdown(incident_id)
    if md is None:
        return PlainTextResponse("Incident not found", status_code=404)
    return md


_metrics_asgi = make_asgi_app()


async def _prometheus_metrics_with_gauge_refresh(scope, receive, send):
    if scope.get("type") == "http":
        _sync_storefront_prometheus_gauges()
    await _metrics_asgi(scope, receive, send)


app.mount("/prometheus-metrics", _prometheus_metrics_with_gauge_refresh)


if __name__ == "__main__":
    port = _resolve_listen_port()
    print(f"INFO:     Listening on http://0.0.0.0:{port}")
    if port != 8000:
        print(
            "WARNING:  Port 8000 was busy — API is on :%s. "
            "The Vite dev proxy defaults to http://127.0.0.1:8000. "
            "Either free :8000 and restart, run Vite with "
            "VITE_PROXY_TARGET=http://127.0.0.1:%s, "
            "or use frontend/.env.local → VITE_API_BASE_URL=http://127.0.0.1:%s"
            % (port, port, port),
            flush=True,
        )
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
