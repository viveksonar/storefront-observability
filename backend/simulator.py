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

import hashlib
import logging
import math
import random
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import incident_store

logger = logging.getLogger(__name__)

BACKEND_COUNT = 8          # VAST provides a pool of virtual IPs
MAX_CONNECTIONS = 500      # Per-backend connection limit (realistic for VAST compute node)
TOTAL_RPS = 12000          # Agoda's data platform generates significant S3 traffic

# Forecast thresholds (leading indicator vs lagging saturation — Kafka capacity playbook)
FORECAST_WARNING_CONN = int(MAX_CONNECTIONS * 0.65)    # 325
FORECAST_CRITICAL_CONN = int(MAX_CONNECTIONS * 0.85)   # 425
# Under steady baseline sim, connection regression is near-flat — use a floor rate so 2×/3×
# what-if scenarios still produce distinct stress runway (Normal tab stays stable).
FORECAST_WHATIF_MIN_CONN_PER_HOUR = 2.0

# SLO: 99.5% good traffic → 0.5% error budget ≈ 21.6 minutes per 30-day month (Google SRE workbook style).
SLO_DISTRIBUTION_THRESHOLD = 80.0
SLO_MONTHLY_BUDGET_SECONDS = 21.6 * 60.0  # 1296
SLO_MONTH_SECONDS = 30 * 24 * 3600

VULCAN_NOTE = (
    "This is the manual version of what Vulcan automates. Vulcan integrates Gatekeeper "
    "and historical capacity data to make these decisions automatically across 1,500 services."
)

# Simulated internal Agoda services — FINUDP-style single source of truth for attribution (Jan 2026 article).
CLIENT_REGISTRY: List[Dict[str, Any]] = [
    {"client_id": "booking-api", "team_owner": "Checkout", "traffic_pattern": "High, steady", "base_weight": 0.25, "is_cross_dc_heavy": False},
    {"client_id": "search-results-svc", "team_owner": "Search", "traffic_pattern": "Spiky", "base_weight": 0.20, "is_cross_dc_heavy": False},
    {"client_id": "hotel-content-cache", "team_owner": "Supply", "traffic_pattern": "Moderate, regular", "base_weight": 0.18, "is_cross_dc_heavy": False},
    {"client_id": "finudp-spark-job", "team_owner": "Data Platform", "traffic_pattern": "Batch, heavy", "base_weight": 0.12, "is_cross_dc_heavy": False},
    {"client_id": "kafka-mirror-svc", "team_owner": "Data Infra", "traffic_pattern": "Cross-DC, steady", "base_weight": 0.10, "is_cross_dc_heavy": True},
    {"client_id": "ml-feature-store", "team_owner": "ML Platform", "traffic_pattern": "Moderate", "base_weight": 0.08, "is_cross_dc_heavy": False},
    {"client_id": "promo-engine", "team_owner": "Marketing", "traffic_pattern": "Low→extreme spike", "base_weight": 0.03, "is_cross_dc_heavy": False},
    {"client_id": "legacy-etl-job", "team_owner": "Data Platform", "traffic_pattern": "Erratic", "base_weight": 0.04, "is_cross_dc_heavy": False},
]


def _stable_slot(client_id: str) -> int:
    h = hashlib.md5(client_id.encode()).hexdigest()
    return int(h[:8], 16) % BACKEND_COUNT


def _linear_slope_and_r2(ys: List[float]) -> tuple[Optional[float], float]:
    """
    OLS slope and R² (y vs x = 0..n-1, one sample per simulated tick ≈ 1 second).
    slope = (n*sum(x*y) - sum(x)*sum(y)) / (n*sum(x^2) - sum(x)^2)
    R² uses Pearson correlation squared (simple linear regression).
    """
    n = len(ys)
    if n < 2:
        return None, 0.0
    xs = list(range(n))
    sx = float(sum(xs))
    sy = float(sum(ys))
    sxx = float(sum(x * x for x in xs))
    sxy = float(sum(x * y for x, y in zip(xs, ys)))
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-18:
        return None, 0.0
    slope = (n * sxy - sx * sy) / denom

    mx = sx / n
    my = sy / n
    ss_xy = sum((float(x) - mx) * (float(y) - my) for x, y in zip(xs, ys))
    ss_xx = sum((float(x) - mx) ** 2 for x in xs)
    ss_yy = sum((float(y) - my) ** 2 for y in ys)
    if ss_xx <= 1e-18 or ss_yy <= 1e-18:
        r2 = 0.0 if ss_yy <= 1e-18 else 1.0
    else:
        r = ss_xy / ((ss_xx ** 0.5) * (ss_yy ** 0.5))
        r = max(-1.0, min(1.0, r))
        r2 = r * r

    return slope, r2


def _forecast_confidence_label(n_ticks: int) -> str:
    if n_ticks < 5:
        return "insufficient"
    if n_ticks < 10:
        return "low"
    if n_ticks < 30:
        return "medium"
    return "high"


def _hours_pair_for_scenario(
    current: float,
    rate_per_hour: float,
    multiplier: float,
) -> tuple[Optional[float], Optional[float]]:
    """
    Hours until warning (325 conn) and critical (425 conn) connection counts.
    If rate <= 0 or effective growth <= 0, returns (None, None).
    """
    if rate_per_hour <= 0:
        return None, None
    eff = rate_per_hour * multiplier
    if eff <= 0:
        return None, None

    def level_hours(threshold: int) -> float:
        if current >= threshold:
            return 0.0
        return round((threshold - current) / eff, 1)

    return (
        level_hours(FORECAST_WARNING_CONN),
        level_hours(FORECAST_CRITICAL_CONN),
    )


def _slo_failure_title(failure_type: str) -> str:
    return {
        "dns_stickiness": "DNS Stickiness",
        "connection_exhaustion": "Connection Exhaustion",
        "cross_dc_throttling": "Cross-DC Throttling",
    }.get(failure_type, failure_type.replace("_", " ").title())


def _fleet_recommendation(
    mins: Dict[str, Optional[float]],
    most_backend: Optional[str],
) -> str:
    """Scenario-aware TPM-facing copy — mirrors Agoda Kafka leading-indicator narrative."""
    n_n = mins.get("normal")
    n2 = mins.get("spike_2x")
    n3 = mins.get("spike_3x")
    finite = [(k, v) for k, v in mins.items() if v is not None]
    if not finite:
        return (
            "Fleet-wide connection growth is flat or declining — leading indicator is stable. "
            "Pair with Gatekeeper traffic limits before peak; saturation is a lagging signal "
            "(Agoda Kafka engineering: disk % fired too late)."
        )

    worst_key, worst_val = min(finite, key=lambda kv: kv[1])
    label = {"normal": "baseline traffic", "spike_2x": "2× promotional spike", "spike_3x": "3× major event"}.get(
        worst_key, worst_key
    )
    who = f" ({most_backend})" if most_backend else ""
    if worst_val < 24:
        return (
            f"Minimum time to critical under {label}{who} is under 24h — escalate capacity review "
            "and load-shedding options now. This manual view matches what Vulcan automates against "
            "historical Gatekeeper data across services."
        )
    if worst_val <= 72:
        return (
            f"Minimum time to critical under {label}{who} is within ~3 days — schedule mitigation "
            "before peak. Growth rate beats lagging connection % alone (Kafka capacity lesson)."
        )
    return (
        f"Fleet minimum hours to critical under {label}{who} are comfortable (>72h) at current "
        "trends — keep monitoring growth rate as the leading indicator."
    )


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
        # SLO error budget (seconds of violation against distribution score — persists across incident resolve).
        self.slo_budget_used_seconds: float = 0.0
        self.slo_monthly_budget_seconds: float = float(SLO_MONTHLY_BUDGET_SECONDS)
        self.slo_last_score: float = 100.0
        # UI-facing burn multipliers — exponential decay toward steady state when mode is normal
        # (avoids snapping 5× → 0× on POST /simulate/normal).
        self._slo_display_burn_1h: float = 0.0
        self._slo_display_burn_6h: float = 0.0
        self._slo_smooth_last_ts: float = 0.0  # 0 = not yet seeded by _update_slo_display_smoothing
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
        self._update_slo_display_smoothing()
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
        # Previous ramp (tick/80) left vast-03/04 near baseline for ~30s while client attribution
        # already showed legacy-etl-job + copy naming those nodes — looked broken. Use a faster ramp
        # with a floor so the grid clearly reflects the two hot shards as soon as this mode is active.
        t = max(1, self.tick)
        ramp_linear = min(1.0, t / 22.0)
        ramp = min(1.0, max(ramp_linear, 0.34))
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
        n_b = len(self.backends)
        ideal_rps = (total_rps / n_b) if n_b else 0.0
        if ideal_rps <= 1e-12:
            distribution_score = 100.0
        else:
            distribution_score = max(0, 100 - (max_rps - ideal_rps) / ideal_rps * 100)

        self.slo_last_score = round(float(distribution_score), 1)
        if distribution_score < SLO_DISTRIBUTION_THRESHOLD:
            self.slo_budget_used_seconds += 1.0

        self.history.append({
            "tick": self.tick,
            "timestamp": time.time(),
            "total_connections": total_connections,
            "connections_per_backend": [b.connections for b in self.backends],
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
                try:
                    incident_store.resolve_all_active_incidents(self)
                except Exception as e:
                    logger.warning("resolve_all_active_incidents failed: %s", e)
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
            n_b = len(self.backends)
            ideal_rps = (total_rps / n_b) if n_b else 0.0
            if ideal_rps <= 1e-12:
                distribution_score = 100.0
            else:
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

    def get_forecast(self) -> Dict[str, Any]:
        """
        Linear trend on per-backend connection counts / last ≤60 ticks.
        Leading indicator analogue to Agoda Kafka growth-rate planning (vs lagging disk%).
        """
        MIN_TICKS = 5
        with self._lock:
            self._tick()
            simulator_mode = self.mode
            history_snapshot = list(self.history)
            backends_snap = [
                {
                    "id": b.id,
                    "connections": b.connections,
                    "is_cross_dc": b.is_cross_dc,
                }
                for b in self.backends
            ]

        usable: List[Dict[str, Any]] = []
        for row in history_snapshot:
            cpb = row.get("connections_per_backend")
            if isinstance(cpb, list) and len(cpb) == BACKEND_COUNT:
                usable.append(row)

        n_ticks = len(usable)
        ticks_reported = min(n_ticks, 60)

        if n_ticks < MIN_TICKS:
            return {
                "forecasts": [],
                "fleet_summary": {
                    "most_at_risk_backend": None,
                    "min_hours_to_critical_normal": None,
                    "min_hours_to_critical_spike_2x": None,
                    "min_hours_to_critical_spike_3x": None,
                    "recommendation": (
                        "Need at least five one-second samples with per-backend connection counts "
                        "before regression is meaningful. Wait ~5 seconds after startup or refresh."
                    ),
                },
                "data_confidence": "insufficient",
                "ticks_available": n_ticks,
                "simulator_mode": simulator_mode,
                "message": (
                    "Insufficient history: linear regression requires at least 5 ticks of "
                    "per-backend connection samples (~5 seconds of simulator uptime)."
                ),
                "vulcan_note": VULCAN_NOTE,
            }

        conf_label = _forecast_confidence_label(n_ticks)

        forecasts: List[Dict[str, Any]] = []

        for j in range(BACKEND_COUNT):
            ys = [float(row["connections_per_backend"][j]) for row in usable]
            slope, r2 = _linear_slope_and_r2(ys)
            current = backends_snap[j]["connections"]
            util_pct = round(current / MAX_CONNECTIONS * 100, 1)

            if slope is None:
                growth_rate_per_hour = 0.0
                rate_hour = 0.0
            else:
                rate_hour = slope * 3600.0
                growth_rate_per_hour = round(rate_hour, 1)

            # R² filters spurious slopes on random-walk connection noise (flat normal mode).
            is_growing = (
                slope is not None
                and slope > 0
                and r2 >= 0.08
                and rate_hour >= 2.0
            )

            # Normal scenario: raw regression. 2×/3×: same slope, but under baseline sim use a
            # minimum drift so flat noise still yields comparable stress hours (tabs react visibly).
            hw_norm, hc_norm = _hours_pair_for_scenario(float(current), rate_hour, 1.0)
            if simulator_mode == "normal":
                spike_rate = max(rate_hour, FORECAST_WHATIF_MIN_CONN_PER_HOUR)
            else:
                spike_rate = rate_hour
            hw_2, hc_2 = _hours_pair_for_scenario(float(current), spike_rate, 2.0)
            hw_3, hc_3 = _hours_pair_for_scenario(float(current), spike_rate, 3.0)

            at_warning = current >= FORECAST_WARNING_CONN
            at_critical = current >= FORECAST_CRITICAL_CONN

            forecasts.append({
                "backend_id": backends_snap[j]["id"],
                "current_connections": current,
                "connection_utilisation_pct": util_pct,
                "growth_rate_per_hour": growth_rate_per_hour,
                "is_growing": is_growing,
                "hours_to_warning": {
                    "normal": hw_norm,
                    "spike_2x": hw_2,
                    "spike_3x": hw_3,
                },
                "hours_to_critical": {
                    "normal": hc_norm,
                    "spike_2x": hc_2,
                    "spike_3x": hc_3,
                },
                "confidence": conf_label,
                "is_cross_dc": backends_snap[j]["is_cross_dc"],
                "already_at_risk": at_warning or at_critical,
                "already_at_risk_level": "critical" if at_critical else ("warning" if at_warning else None),
            })

        # Baseline sim: hide only the "Normal traffic" runway — 2×/3× stay populated for what-if.
        if simulator_mode == "normal":
            for f in forecasts:
                f["hours_to_warning"]["normal"] = None
                f["hours_to_critical"]["normal"] = None
                f["is_growing"] = False
                f["growth_rate_per_hour"] = 0.0

        def _finite_min(vals: List[Optional[float]]) -> Optional[float]:
            nums = [v for v in vals if v is not None]
            if not nums:
                return None
            return min(nums)

        hc_normal_list = [f["hours_to_critical"]["normal"] for f in forecasts]
        hc_2_list = [f["hours_to_critical"]["spike_2x"] for f in forecasts]
        hc_3_list = [f["hours_to_critical"]["spike_3x"] for f in forecasts]

        min_norm = _finite_min(hc_normal_list)
        min_2 = _finite_min(hc_2_list)
        min_3 = _finite_min(hc_3_list)

        scored: List[tuple[float, str]] = []
        for f in forecasts:
            trip = [
                f["hours_to_critical"]["normal"],
                f["hours_to_critical"]["spike_2x"],
                f["hours_to_critical"]["spike_3x"],
            ]
            finite_trip = [t for t in trip if t is not None]
            if not finite_trip:
                continue
            scored.append((min(finite_trip), f["backend_id"]))
        scored.sort(key=lambda x: (x[0], x[1]))
        most_b = scored[0][1] if scored else None

        recommendation = _fleet_recommendation(
            {"normal": min_norm, "spike_2x": min_2, "spike_3x": min_3},
            most_b,
        )

        return {
            "forecasts": forecasts,
            "fleet_summary": {
                "most_at_risk_backend": most_b,
                "min_hours_to_critical_normal": min_norm,
                "min_hours_to_critical_spike_2x": min_2,
                "min_hours_to_critical_spike_3x": min_3,
                "recommendation": recommendation,
            },
            "data_confidence": conf_label,
            "ticks_available": ticks_reported,
            "simulator_mode": simulator_mode,
            "vulcan_note": VULCAN_NOTE,
        }

    def reset_slo_budget(self) -> Dict[str, Any]:
        """Explicit monthly budget reset (does not run on POST /simulate/normal)."""
        with self._lock:
            self.slo_budget_used_seconds = 0.0
            rem_m = round(self.slo_monthly_budget_seconds / 60.0, 1)
            return {
                "ok": True,
                "message": "SLO error budget reset — consumed seconds cleared",
                "slo_budget_used_seconds": 0.0,
                "budget_minutes_remaining": rem_m,
            }

    def _slo_build_window_data(self, budget_minutes_used: float) -> tuple[List[Dict[str, Any]], float]:
        """
        Rolling 30-day heatmap: cell minutes sum to budget_minutes_used (same accounting as slo_budget_used_seconds).

        Previously cells used random demo values while the headline budget came from real tick burn — totals disagreed.
        """
        rows = incident_store.get_incidents(40)
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

        # Relative weights per cell (index 0 = oldest day, 29 = today)
        weights: List[float] = [1.0] * 30

        by_date: Dict[str, Dict[str, Any]] = {}
        for inc in rows:
            try:
                st = float(inc.get("start_time") or 0)
                if st <= 0:
                    continue
                d = datetime.fromtimestamp(st).replace(hour=0, minute=0, second=0, microsecond=0)
                dk = d.strftime("%Y-%m-%d")
                by_date[dk] = {"failure_type": inc.get("failure_type"), "id": inc.get("id")}
                dur = float(inc.get("duration_seconds") or 0)
                bump = max(2.0, min(dur / 60.0, 120.0)) if dur > 0 else 4.0
                for idx in range(30):
                    day_offset = 29 - idx
                    dt_cell = today - timedelta(days=day_offset)
                    if dt_cell.strftime("%Y-%m-%d") == dk:
                        weights[idx] += bump
            except (TypeError, ValueError, OSError):
                continue

        if self.mode != "normal":
            weights[29] += 6.0

        wsum = sum(weights)
        if wsum <= 1e-12:
            wsum = 30.0
            weights = [1.0] * 30

        raw: List[float] = []
        bu = max(0.0, float(budget_minutes_used))
        if bu <= 1e-12:
            rounded = [0.0] * 30
        else:
            for wi in weights:
                raw.append(bu * (wi / wsum))
            rounded = [round(x, 2) for x in raw]
            drift = bu - sum(rounded)
            if rounded:
                rounded[-1] = round(rounded[-1] + drift, 2)

        window: List[Dict[str, Any]] = []
        total_minutes = round(sum(rounded), 1) if rounded else 0.0

        for i in range(30):
            day_offset = 29 - i
            dt = today - timedelta(days=day_offset)
            key = dt.strftime("%Y-%m-%d")
            date_label = f"{dt.strftime('%b')} {dt.day}"
            day_num = i + 1

            incident_info = by_date.get(key)
            active_today = self.mode != "normal" and day_offset == 0

            had_incident = incident_info is not None or active_today
            inc_type = None
            if incident_info:
                ft = str(incident_info.get("failure_type") or "")
                inc_type = _slo_failure_title(ft)
            elif active_today:
                inc_type = _slo_failure_title(self.mode)

            window.append({
                "day": day_num,
                "date_label": date_label,
                "minutes_consumed": rounded[i],
                "had_incident": had_incident,
                "incident_type": inc_type,
            })

        return window, total_minutes

    def _slo_incident_budget_impact(self) -> List[Dict[str, Any]]:
        rows = incident_store.get_incidents(12)
        month_minutes = self.slo_monthly_budget_seconds / 60.0
        out: List[Dict[str, Any]] = []
        for inc in rows[:5]:
            dur = inc.get("duration_seconds")
            bid = int(inc.get("id") or 0)
            if dur is None or float(dur) <= 0:
                minutes_burned = round(min(4.5, max(0.6, 1.1 + (bid % 17) / 7.0)), 1)
            else:
                minutes_burned = round(min(float(dur) / 60.0, month_minutes * 0.95), 1)
            pct = round(min(100.0, (minutes_burned / month_minutes) * 100.0), 1)
            if pct >= 15:
                severity = "high"
            elif pct >= 7:
                severity = "medium"
            else:
                severity = "low"
            st = float(inc.get("start_time") or 0)
            try:
                dt = datetime.fromtimestamp(st)
                date_str = f"{dt.strftime('%b')} {dt.day}"
            except (OSError, ValueError, OverflowError):
                date_str = "—"
            out.append({
                "incident_id": f"INC-{bid:03d}",
                "date": date_str,
                "type": _slo_failure_title(str(inc.get("failure_type") or "")),
                "minutes_burned": minutes_burned,
                "pct_of_budget": pct,
                "severity": severity,
            })
        out.sort(key=lambda x: x["pct_of_budget"], reverse=True)
        return out

    def _compute_raw_slo_burn_rates(self) -> tuple[float, float, float]:
        """
        Instantaneous burn multipliers from the rolling history (same mode filter as /metrics/slo).
        Returns (burn_rate_1h, burn_rate_6h, actual_violations_per_second_equiv).
        """
        hist_list = list(self.history)
        recent_violations = sum(
            1 for row in hist_list
            if float(row.get("distribution_score", 100)) < SLO_DISTRIBUTION_THRESHOLD
            and row.get("mode") == self.mode
        )
        actual_rate_last_hour = recent_violations / 60.0
        budget_per_second = self.slo_monthly_budget_seconds / float(SLO_MONTH_SECONDS)
        burn_rate_1h = actual_rate_last_hour / budget_per_second if budget_per_second > 1e-18 else 0.0
        burn_rate_6h = round(burn_rate_1h * 0.7, 2)
        return burn_rate_1h, burn_rate_6h, actual_rate_last_hour

    def _update_slo_display_smoothing(self) -> None:
        """Ease displayed burn/exhaustion toward steady state instead of snapping when switching to normal."""
        raw_1h, raw_6h, _ = self._compute_raw_slo_burn_rates()
        now = time.time()

        if self._slo_smooth_last_ts <= 0:
            self._slo_smooth_last_ts = now
            if self.mode != "normal":
                self._slo_display_burn_1h = raw_1h
                self._slo_display_burn_6h = raw_6h
            return

        dt = max(0.05, min(45.0, now - self._slo_smooth_last_ts))
        self._slo_smooth_last_ts = now

        if self.mode != "normal":
            self._slo_display_burn_1h = raw_1h
            self._slo_display_burn_6h = raw_6h
            return

        # Relax toward 0× / baseline — faster after long gaps (tab resume) via capped dt
        blend = 1.0 - math.exp(-0.28 * dt)
        blend = min(1.0, blend)
        self._slo_display_burn_1h += (0.0 - self._slo_display_burn_1h) * blend
        self._slo_display_burn_6h += (0.0 - self._slo_display_burn_6h) * blend
        if self._slo_display_burn_1h < 0.02:
            self._slo_display_burn_1h = 0.0
        if self._slo_display_burn_6h < 0.02:
            self._slo_display_burn_6h = 0.0

    def get_slo_metrics(self) -> Dict[str, Any]:
        with self._lock:
            self._tick()

            budget_per_second = self.slo_monthly_budget_seconds / float(SLO_MONTH_SECONDS)

            budget_pct_remaining = max(
                0.0,
                min(100.0, (1.0 - self.slo_budget_used_seconds / self.slo_monthly_budget_seconds) * 100.0),
            )

            budget_minutes_used = round(self.slo_budget_used_seconds / 60.0, 1)
            budget_minutes_total = round(self.slo_monthly_budget_seconds / 60.0, 1)
            budget_minutes_remaining = round(max(0.0, budget_minutes_total - budget_minutes_used), 1)

            if self.mode == "normal":
                burn_rate_1h = round(self._slo_display_burn_1h, 2)
                burn_rate_6h = round(self._slo_display_burn_6h, 2)
                smooth_actual = self._slo_display_burn_1h * budget_per_second if budget_per_second > 1e-18 else 0.0
                if burn_rate_1h > 1 and smooth_actual > 1e-12:
                    rem_secs = max(0.0, self.slo_monthly_budget_seconds - self.slo_budget_used_seconds)
                    hours_to_exhaustion = round(rem_secs / smooth_actual / 3600.0, 1)
                else:
                    hours_to_exhaustion = None
            else:
                burn_rate_1h, burn_rate_6h, actual_rate_last_hour = self._compute_raw_slo_burn_rates()
                burn_rate_1h = round(burn_rate_1h, 2)
                if burn_rate_1h > 1 and actual_rate_last_hour > 1e-12:
                    rem_secs = max(0.0, self.slo_monthly_budget_seconds - self.slo_budget_used_seconds)
                    hours_to_exhaustion = round(rem_secs / actual_rate_last_hour / 3600.0, 1)
                else:
                    hours_to_exhaustion = None

            if budget_pct_remaining < 20 or burn_rate_1h > 5:
                status = "critical"
            elif budget_pct_remaining < 50 or burn_rate_1h >= 2:
                status = "at_risk"
            else:
                status = "healthy"

            window_data, heatmap_total_minutes = self._slo_build_window_data(budget_minutes_used)
            incident_budget_impact = self._slo_incident_budget_impact()

            return {
                "slo_target": 99.5,
                "slo_definition": "99.5% of S3 requests complete with distribution score > 80",
                "simulator_mode": self.mode,
                "budget_minutes_total": budget_minutes_total,
                "budget_minutes_used": budget_minutes_used,
                "budget_minutes_remaining": budget_minutes_remaining,
                "budget_pct_remaining": round(budget_pct_remaining, 1),
                "burn_rate_1h": round(burn_rate_1h, 2),
                "burn_rate_6h": burn_rate_6h,
                "hours_to_exhaustion": hours_to_exhaustion,
                "status": status,
                "status_thresholds": {
                    "healthy": "budget_pct > 50 AND burn_rate_1h < 2",
                    "at_risk": "budget_pct 20–50 OR burn_rate_1h 2–5",
                    "critical": "budget_pct < 20 OR burn_rate_1h > 5",
                },
                "window_data": window_data,
                "heatmap_minutes_total": heatmap_total_minutes,
                "incident_budget_impact": incident_budget_impact,
                "sre_note": (
                    "Burn rate >1× = spending budget faster than you can afford. "
                    "Burn rate >14.4× = monthly budget exhausted in 2 days. "
                    "Source: Google SRE Workbook."
                ),
            }

    def _client_primary_backends_normal(self, client_id: str) -> List[str]:
        i = _stable_slot(client_id)
        j = (i + 3) % BACKEND_COUNT
        return [f"vast-{i + 1:02d}", f"vast-{j + 1:02d}"]

    def get_client_metrics(self) -> Dict[str, Any]:
        """
        Per-client attribution: which internal service owns degradation (FINUDP-style single pane).
        Behaviour is coupled to failure mode simulation (DNS stickiness → booking-api,
        exhaustion → legacy-etl-job, cross-DC throttle → kafka-mirror-svc).
        """
        with self._lock:
            self._tick()
            bs = self.backends
            mode = self.mode
            total_rps = sum(b.rps for b in bs)
            tr = total_rps if total_rps > 1e-9 else 1e-9
            total_conn = sum(b.connections for b in bs)
            total_io = sum(b.io_timeouts_per_min for b in bs)

            rows: List[Dict[str, Any]] = []
            flagged: Optional[Dict[str, str]] = None

            def append_row(
                reg: Dict[str, Any],
                *,
                rps: float,
                conn: int,
                io_r: float,
                health: str,
                anomaly: Optional[Dict[str, Any]],
                prim: List[str],
            ) -> None:
                pct = round(100 * rps / tr, 1)
                rows.append({
                    "client_id": reg["client_id"],
                    "team_owner": reg["team_owner"],
                    "traffic_pattern": reg["traffic_pattern"],
                    "rps": round(rps, 1),
                    "rps_pct": pct,
                    "connections": max(0, conn),
                    "primary_backends": prim,
                    "io_timeout_rate": round(max(0.0, io_r), 2),
                    "connection_health": health,
                    "anomaly": anomaly,
                    "is_cross_dc_heavy": reg["is_cross_dc_heavy"],
                })

            if mode == "normal":
                for reg in CLIENT_REGISTRY:
                    w = reg["base_weight"]
                    rps_v = total_rps * w * self._noise(1.0, 0.06)
                    conn_v = max(1, int(total_conn * w * self._noise(1.0, 0.1)))
                    io_v = max(0.0, total_io * w * 0.08 * self._noise(1.0, 0.35))
                    append_row(
                        reg,
                        rps=rps_v,
                        conn=conn_v,
                        io_r=io_v,
                        health="ok",
                        anomaly=None,
                        prim=self._client_primary_backends_normal(reg["client_id"]),
                    )

            elif mode == "dns_stickiness":
                hot = bs[0]
                for reg in CLIENT_REGISTRY:
                    w = reg["base_weight"]
                    rps_v = total_rps * w * self._noise(1.0, 0.04)
                    if reg["client_id"] == "booking-api":
                        conn_v = max(1, int(hot.connections * 0.48 + total_conn * w * 0.28))
                        io_v = max(0.5, hot.io_timeouts_per_min * 0.42)
                        anomaly = {
                            "type": "dns_stickiness",
                            "message": (
                                "booking-api pinned to vast-01 (~78% of fleet RPS via cached DNS VIP)—load stays "
                                "sticky until caches refresh or processes restart."
                            ),
                            "recommendation": (
                                "Contact: Checkout team · Recommendation: Restart or roll booking-api workers to pick "
                                "up fresh VIP resolution, or shorten DNS TTL at the edge (coordinate with edge/network)."
                            ),
                            "severity": "warning",
                            "article_ref": "Storefront article Feb 2026 — DNS TTL=1s causing sticky routing",
                        }
                        append_row(
                            reg,
                            rps=rps_v,
                            conn=conn_v,
                            io_r=io_v,
                            health="warning",
                            anomaly=anomaly,
                            prim=["vast-01"],
                        )
                        flagged = {"client_id": "booking-api", "team": "Checkout"}
                    else:
                        conn_v = max(1, int(total_conn * w * self._noise(0.78, 0.12)))
                        io_v = max(0.0, total_io * w * 0.06)
                        append_row(
                            reg,
                            rps=rps_v,
                            conn=conn_v,
                            io_r=io_v,
                            health="ok",
                            anomaly=None,
                            prim=self._client_primary_backends_normal(reg["client_id"]),
                        )

            elif mode == "connection_exhaustion":
                bad_conn_sum = bs[2].connections + bs[3].connections
                bad_io_sum = bs[2].io_timeouts_per_min + bs[3].io_timeouts_per_min
                remainder_weight = sum(r["base_weight"] for r in CLIENT_REGISTRY if r["client_id"] != "legacy-etl-job")

                for reg in CLIENT_REGISTRY:
                    w = reg["base_weight"]
                    rps_v = total_rps * w * self._noise(1.0, 0.06)
                    if reg["client_id"] == "legacy-etl-job":
                        conn_v = max(1, int(bad_conn_sum * 0.9 + total_conn * 0.015))
                        io_v = min(22.0, round(bad_io_sum * 0.88 + 4.0, 2))
                        anomaly = {
                            "type": "connection_exhaustion",
                            "message": (
                                "legacy-etl-job accumulating stale connections on vast-03 / vast-04—not fully reading "
                                "HTTP responses, so sockets stay occupied and IO stream timeouts climb."
                            ),
                            "recommendation": (
                                "Contact: Data Platform team · Recommendation: Apply the IO stream timeout / full-drain "
                                "fix—read each S3 response body to completion before reusing connections; add bounded "
                                "read timeouts where missing."
                            ),
                            "severity": "critical",
                            "article_ref": "Storefront article Feb 2026 — bad S3 client IO stream exhaustion fix",
                        }
                        append_row(
                            reg,
                            rps=rps_v,
                            conn=conn_v,
                            io_r=max(15.0, io_v),
                            health="exhausting",
                            anomaly=anomaly,
                            prim=["vast-03", "vast-04"],
                        )
                        flagged = {"client_id": "legacy-etl-job", "team": "Data Platform"}
                    else:
                        scale = (w / remainder_weight) if remainder_weight > 1e-12 else w
                        pool_other = max(1, total_conn - int(bad_conn_sum * 0.88))
                        conn_v = max(1, int(pool_other * scale * self._noise(1.0, 0.08)))
                        io_v = max(0.0, total_io * w * 0.12)
                        append_row(
                            reg,
                            rps=rps_v,
                            conn=conn_v,
                            io_r=io_v,
                            health="ok",
                            anomaly=None,
                            prim=self._client_primary_backends_normal(reg["client_id"]),
                        )

            elif mode == "cross_dc_throttling":
                dc_io = bs[6].io_timeouts_per_min + bs[7].io_timeouts_per_min
                for reg in CLIENT_REGISTRY:
                    w = reg["base_weight"]
                    if reg["client_id"] == "kafka-mirror-svc":
                        rps_v = min(total_rps * 0.42, total_rps * w * 3.05 * self._noise(1.0, 0.04))
                        conn_v = max(
                            1,
                            int((bs[6].connections + bs[7].connections) * 0.52 + total_conn * w * 0.22),
                        )
                        io_v = dc_io * 0.48
                        anomaly = {
                            "type": "cross_dc_throttling",
                            "message": (
                                "kafka-mirror-svc driving a cross-DC replication spike—saturating the vast-07 / vast-08 "
                                "pool and raising collateral latency on shared VAST capacity."
                            ),
                            "recommendation": (
                                "Contact: Data Infra team · Recommendation: Throttle or reschedule the mirror job and "
                                "split cross-DC traffic into dedicated upstream pools (see Storefront cross-DC "
                                "bandwidth throttling article)."
                            ),
                            "severity": "warning",
                            "article_ref": "Storefront article Feb 2026 — cross-DC bandwidth throttling",
                        }
                        append_row(
                            reg,
                            rps=rps_v,
                            conn=conn_v,
                            io_r=io_v,
                            health="warning",
                            anomaly=anomaly,
                            prim=["vast-07", "vast-08"],
                        )
                        flagged = {"client_id": "kafka-mirror-svc", "team": "Data Infra"}
                    else:
                        rps_v = total_rps * w * self._noise(0.92, 0.1)
                        conn_v = max(1, int(total_conn * w * self._noise(0.82, 0.1)))
                        io_v = max(0.0, total_io * w * 0.25)
                        append_row(
                            reg,
                            rps=rps_v,
                            conn=conn_v,
                            io_r=io_v,
                            health="ok",
                            anomaly=None,
                            prim=self._client_primary_backends_normal(reg["client_id"]),
                        )

            else:
                for reg in CLIENT_REGISTRY:
                    w = reg["base_weight"]
                    rps_v = total_rps * w * self._noise(1.0, 0.06)
                    conn_v = max(1, int(total_conn * w * self._noise(1.0, 0.1)))
                    io_v = max(0.0, total_io * w * 0.08)
                    append_row(
                        reg,
                        rps=rps_v,
                        conn=conn_v,
                        io_r=io_v,
                        health="ok",
                        anomaly=None,
                        prim=self._client_primary_backends_normal(reg["client_id"]),
                    )

            rows.sort(key=lambda x: x["connections"], reverse=True)

            return {
                "clients": rows,
                "flagged_client": flagged,
            }
