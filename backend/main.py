import os
import socket

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from simulator import MetricSimulator
import uvicorn


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

if __name__ == "__main__":
    port = _resolve_listen_port()
    print(f"INFO:     Listening on http://0.0.0.0:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
