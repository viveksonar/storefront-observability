"""
Storefront Metric Simulator
Generates realistic metrics for each of the three failure modes
documented in Agoda's Storefront engineering article (Feb 2026).

The five signals we track, all derived from the article:
1. Connection count per VAST backend (the original DNS stickiness problem)
2. Request distribution across backends (load balancing effectiveness)
3. IO stream timeout events (bad S3 client connection exhaustion fix)
4. Cross-DC vs same-DC traffic split (bandwidth throttling fix)
5. expect:continue header detection rate (latency spike fix)

Incident persistence: lifecycle hooks call incident_store so TPM evidence
survives mode transitions and container restarts (SQLite).
"""

import logging
import random
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import List, Optional

import incident_store

logger = logging.getLogger(__name__)

BACKEND_COUNT = 8          # VAST provides a pool of virtual IPs
MAX_CONNECTIONS = 500      # Per-backend connection limit (realistic for VAST compute node)
TOTAL_RPS = 12000          # Agoda's data platform generates significant S3 traffic


@dataclass
class Backend:
    id: str
    ip: str
    connections: int = 0
    rps: float = 0.0
    latency_p99_ms: float = 0.0
    io_timeouts_per_min: float = 0.0
    is_cross_dc: bool = False
    healthy: bool = True


class MetricSimulator:

    MODES = ["normal", "dns_stickiness", "connection_exhaustion", "cross_dc_throttling"]

    def __init__(self):
        self.mode = "normal"
        self.tick = 0
        self.history: deque = deque(maxlen=60)
        self.backends = self._init_backends()
        self._last_tick_time = time.time()
        self._active_incident_id: Optional[int] = None
        # Parallel HTTP polls call getters concurrently; SQLite + mutable backends must not race.
        self._lock = threading.Lock()

    def _init_backends(self) -> List[Backend]:
        """
        8 VAST virtual IPs. Two are designated cross-DC (used for
        disaster recovery replication). This mirrors Agoda's setup
        where they configured distinct upstream routes per traffic type.
        """
        backends = []
        for i in range(BACKEND_COUNT):
            backends.append(Backend(
                id=f"vast-{i+1:02d}",
                ip=f"10.0.{i+1}.100",
                is_cross_dc=(i >= 6)
            ))
        return backends

    def _noise(self, base: float, pct: float = 0.1) -> float:
        """Add realistic noise — metrics never sit perfectly flat."""
        return base * (1 + random.uniform(-pct, pct))

    def _tick(self):
        """Advance simulation by one time step."""
        now = time.time()
        if now - self._last_tick_time < 1.0 and self.tick > 0:
            return
        self._last_tick_time = now
        self.tick += 1

        if self.mode == "normal":
            self._simulate_normal()
        elif self.mode == "dns_stickiness":
            self._simulate_dns_stickiness()
        elif self.mode == "connection_exhaustion":
            self._simulate_connection_exhaustion()
        elif self.mode == "cross_dc_throttling":
            self._simulate_cross_dc_throttling()

        self._record_history()
        self._persist_incident_peaks()

    def _persist_incident_peaks(self):
        """Every simulated tick during an outage updates SQLite peak columns."""
        if self.mode == "normal" or self._active_incident_id is None:
            return
        try:
            incident_store.record_incident_tick(self._active_incident_id, self)
            if self.tick > 0 and self.tick % 30 == 0:
                incident_store.add_event(
                    self._active_incident_id,
                    "metric_snapshot",
                    f"Sustained degradation — simulation tick {self.tick}, peaks still accumulating",
                )
        except Exception as e:
            # Read-only /app or SQLite busy — metrics API must still return 200.
            logger.warning("incident_store tick failed (non-fatal): %s", e)

    def _simulate_normal(self):
        """
        Post-Storefront steady state: least-inflight-requests routing
        distributes traffic evenly. Connection counts stay well below
        the per-backend limit of ~500 connections.
        """
        base_rps = TOTAL_RPS / BACKEND_COUNT
        for b in self.backends:
            b.rps = self._noise(base_rps, 0.15)
            b.connections = int(self._noise(80, 0.20))
            b.io_timeouts_per_min = self._noise(0.5, 0.5)
            if b.is_cross_dc:
                b.latency_p99_ms = self._noise(55, 0.15)  # Cross-DC adds ~50ms
            else:
                b.latency_p99_ms = self._noise(4, 0.25)
            b.healthy = True

    def _simulate_dns_stickiness(self):
        """
        Pre-Storefront failure mode: DNS caching causes one application
        to resolve a single virtual IP and send ALL requests there.
        Microsoft DNS minimum TTL of 1 second means cache never refreshes
        fast enough under high-volume S3 workloads.

        Source: "Applications tend to cache DNS results for arbitrary
        durations... one application with heavy storage usage might get
        routed to a single backend" — Storefront article, Feb 2026
        """
        hot_backend_idx = 0
        for i, b in enumerate(self.backends):
            if i == hot_backend_idx:
                # This backend absorbs ~78% of all traffic
                b.rps = self._noise(TOTAL_RPS * 0.78, 0.05)
                b.connections = int(self._noise(MAX_CONNECTIONS * 0.94, 0.04))
                b.latency_p99_ms = self._noise(85, 0.15)  # Degrading under load
                b.io_timeouts_per_min = self._noise(4.5, 0.3)
                b.healthy = b.connections < MAX_CONNECTIONS
            else:
                # Others sit nearly idle
                b.rps = self._noise(TOTAL_RPS * 0.032, 0.30)
                b.connections = int(self._noise(8, 0.40))
                b.latency_p99_ms = self._noise(3, 0.20)
                b.io_timeouts_per_min = 0.1
                b.healthy = True

    def _simulate_connection_exhaustion(self):
        """
        Bad S3 client failure: client does not fully read HTTP responses.
        Connections remain open indefinitely waiting to write to a full
        IO stream buffer. Two backends slowly approach the connection limit.

        Source: "Some S3 clients often did not fully read their HTTP
        responses. This caused connections to remain open indefinitely,
        eventually exhausting the backend's connection limits."
        — Storefront article, Feb 2026
        """
        ramp = min(1.0, (self.tick % 120) / 80.0)  # Ramps up over ~80 ticks
        for i, b in enumerate(self.backends):
            base_rps = TOTAL_RPS / BACKEND_COUNT
            b.rps = self._noise(base_rps, 0.12)
            if i in [2, 3]:  # Two backends receiving traffic from the bad client
                b.connections = int(self._noise(
                    80 + (MAX_CONNECTIONS - 80) * ramp * 0.92, 0.05
                ))
                b.io_timeouts_per_min = self._noise(12 * ramp, 0.25)
                b.latency_p99_ms = self._noise(4 + 60 * ramp, 0.20)
                b.healthy = b.connections < int(MAX_CONNECTIONS * 0.90)
            else:
                b.connections = int(self._noise(80, 0.20))
                b.io_timeouts_per_min = self._noise(0.5, 0.5)
                b.latency_p99_ms = self._noise(4, 0.20)
                b.healthy = True

    def _simulate_cross_dc_throttling(self):
        """
        Cross-DC bandwidth throttling: a large backup replication job
        sends data cross-datacenter through the VAST cluster. This saturates
        the two dedicated cross-DC backends AND causes collateral latency
        on all backends sharing the same VAST cluster.

        Source: "Cross data center traffic... throttled, affecting the
        performance of the vast cluster as a whole, even for other requests
        that were not cross data center." — Storefront article, Feb 2026

        The fix (implemented in Storefront) was to configure distinct
        upstream pools for cross-DC traffic, isolating the blast radius.
        """
        cross_dc_load = 0.85  # Backup job is heavy
        for b in self.backends:
            base_rps = TOTAL_RPS / BACKEND_COUNT
            b.rps = self._noise(base_rps, 0.12)
            if b.is_cross_dc:
                b.connections = int(self._noise(MAX_CONNECTIONS * cross_dc_load, 0.06))
                b.latency_p99_ms = self._noise(380, 0.20)  # Severely degraded
                b.io_timeouts_per_min = self._noise(18, 0.30)
                b.healthy = False
            else:
                # Collateral damage: shared VAST cluster still shows elevated latency
                b.connections = int(self._noise(80, 0.20))
                b.latency_p99_ms = self._noise(28, 0.25)  # Elevated from normal 4ms
                b.io_timeouts_per_min = self._noise(2.8, 0.30)
                b.healthy = True

    def _record_history(self):
        total_connections = sum(b.connections for b in self.backends)
        avg_latency = sum(b.latency_p99_ms for b in self.backends) / len(self.backends)
        total_rps = sum(b.rps for b in self.backends)
        io_timeouts = sum(b.io_timeouts_per_min for b in self.backends)

        # Load distribution score: 100 = perfectly even, 0 = all on one backend
        rps_values = [b.rps for b in self.backends]
        max_rps = max(rps_values) if rps_values else 1
        ideal_rps = total_rps / len(self.backends)
        distribution_score = max(0, 100 - (max_rps - ideal_rps) / ideal_rps * 100)

        self.history.append({
            "tick": self.tick,
            "timestamp": time.time(),
            "total_connections": total_connections,
            "avg_latency_p99_ms": round(avg_latency, 1),
            "total_rps": round(total_rps, 0),
            "io_timeouts_per_min": round(io_timeouts, 2),
            "distribution_score": round(distribution_score, 1),
            "mode": self.mode,
        })

    def set_mode(self, mode: str):
        """
        Failure transitions open/close SQLite incidents so TPM timelines remain auditable.
        """
        with self._lock:
            old = self.mode

            if mode == "normal":
                self.mode = mode
                self.tick = 0
                if self._active_incident_id is not None:
                    try:
                        incident_store.resolve_incident(self._active_incident_id, self)
                    except Exception as e:
                        logger.warning("resolve_incident failed: %s", e)
                    self._active_incident_id = None
                return

            if old == "normal":
                self.mode = mode
                self.tick = 0
                try:
                    self._active_incident_id = incident_store.create_incident(mode)
                except Exception as e:
                    logger.warning("create_incident failed: %s", e)
                    self._active_incident_id = None
                return

            if old != mode:
                if self._active_incident_id is not None:
                    try:
                        incident_store.resolve_incident(self._active_incident_id, self)
                    except Exception as e:
                        logger.warning("resolve_incident failed: %s", e)
                    self._active_incident_id = None
                self.mode = mode
                self.tick = 0
                try:
                    self._active_incident_id = incident_store.create_incident(mode)
                except Exception as e:
                    logger.warning("create_incident failed: %s", e)
                    self._active_incident_id = None
                return

            self.mode = mode
            self.tick = 0

    def get_backend_metrics(self) -> dict:
        with self._lock:
            self._tick()
            return {
                "backends": [
                    {
                        "id": b.id,
                        "ip": b.ip,
                        "connections": b.connections,
                        "connection_utilisation_pct": round(b.connections / MAX_CONNECTIONS * 100, 1),
                        "rps": round(b.rps, 1),
                        "latency_p99_ms": round(b.latency_p99_ms, 1),
                        "io_timeouts_per_min": round(b.io_timeouts_per_min, 2),
                        "is_cross_dc": b.is_cross_dc,
                        "healthy": b.healthy,
                        "status": "critical" if b.connections > MAX_CONNECTIONS * 0.85
                                  else "warning" if b.connections > MAX_CONNECTIONS * 0.65
                                  else "healthy",
                    }
                    for b in self.backends
                ],
                "mode": self.mode,
                "max_connections_per_backend": MAX_CONNECTIONS,
            }

    def get_anomalies(self) -> dict:
        with self._lock:
            self._tick()
            alerts = []

            # Check for connection exhaustion
            for b in self.backends:
                if b.connections > MAX_CONNECTIONS * 0.85:
                    alerts.append({
                        "type": "connection_exhaustion",
                        "severity": "critical",
                        "backend": b.id,
                        "message": f"{b.id} at {b.connections}/{MAX_CONNECTIONS} connections — "
                                   f"risk of VAST compute node availability failure",
                        "article_ref": "Storefront article Feb 2026: bad S3 client IO stream exhaustion",
                    })

            total_rps = sum(b.rps for b in self.backends)
            if total_rps > 0:
                for b in self.backends:
                    if b.rps / total_rps > 0.50:
                        alerts.append({
                            "type": "dns_stickiness",
                            "severity": "critical",
                            "backend": b.id,
                            "message": f"{b.id} handling {b.rps/total_rps*100:.0f}% of requests — "
                                       f"DNS cache stickiness suspected",
                            "article_ref": "Storefront article Feb 2026: DNS TTL=1s causing sticky routing",
                        })

            for b in self.backends:
                if b.is_cross_dc and b.latency_p99_ms > 200:
                    alerts.append({
                        "type": "cross_dc_throttling",
                        "severity": "warning",
                        "backend": b.id,
                        "message": f"{b.id} (cross-DC) P99={b.latency_p99_ms:.0f}ms — "
                                   f"backup replication may be saturating this VAST pool",
                        "article_ref": "Storefront article Feb 2026: cross-DC bandwidth throttling",
                    })

            non_cross_dc_elevated = [
                b for b in self.backends
                if not b.is_cross_dc and b.latency_p99_ms > 15
            ]
            if len(non_cross_dc_elevated) >= 3:
                alerts.append({
                    "type": "cross_dc_collateral",
                    "severity": "warning",
                    "backend": "cluster-wide",
                    "message": f"{len(non_cross_dc_elevated)} same-DC backends showing elevated latency "
                               f"— cross-DC traffic may be affecting shared VAST cluster resources",
                    "article_ref": "Storefront article Feb 2026: cross-DC traffic affecting all users in same VAST cluster",
                })

            return {"alerts": alerts, "count": len(alerts)}

    def get_summary(self) -> dict:
        with self._lock:
            self._tick()
            total_rps = sum(b.rps for b in self.backends)
            total_connections = sum(b.connections for b in self.backends)
            cross_dc_rps = sum(b.rps for b in self.backends if b.is_cross_dc)
            cross_dc_pct = round(cross_dc_rps / total_rps * 100, 1) if total_rps > 0 else 0
            total_io_timeouts = sum(b.io_timeouts_per_min for b in self.backends)
            unhealthy = sum(1 for b in self.backends if not b.healthy)

            rps_values = [b.rps for b in self.backends]
            max_rps = max(rps_values) if rps_values else 1
            ideal_rps = total_rps / len(self.backends) if self.backends else 1
            distribution_score = round(max(0, 100 - (max_rps - ideal_rps) / ideal_rps * 100), 1)

            return {
                "total_rps": round(total_rps),
                "total_connections": total_connections,
                "cross_dc_traffic_pct": cross_dc_pct,
                "io_timeouts_per_min": round(total_io_timeouts, 2),
                "unhealthy_backends": unhealthy,
                "load_distribution_score": distribution_score,
                "mode": self.mode,
            }

    def get_history(self) -> dict:
        with self._lock:
            self._tick()
            return {"history": list(self.history)}
