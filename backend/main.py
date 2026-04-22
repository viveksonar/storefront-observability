import logging
import os
import socket

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from simulator import MetricSimulator
import incident_store
import uvicorn

logger = logging.getLogger(__name__)


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
    return sim.get_backend_metrics()

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
