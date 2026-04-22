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
from typing import Any, Dict, List, Optional

import incident_store

logger = logging.getLogger(__name__)

BACKEND_COUNT = 8          # VAST provides a pool of virtual IPs
MAX_CONNECTIONS = 500      # Per-backend connection limit (realistic for VAST compute node)
TOTAL_RPS = 12000          # Agoda's data platform generates significant S3 traffic

# Forecast thresholds (leading indicator vs lagging saturation — Kafka capacity playbook)
FORECAST_WARNING_CONN = int(MAX_CONNECTIONS * 0.65)    # 325
FORECAST_CRITICAL_CONN = int(MAX_CONNECTIONS * 0.85)   # 425

VULCAN_NOTE = (
    "This is the manual version of what Vulcan automates. Vulcan integrates Gatekeeper "
    "and historical capacity data to make these decisions automatically across 1,500 services."
)


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

    def get_forecast(self) -> Dict[str, Any]:
        """
        Linear trend on per-backend connection counts / last ≤60 ticks.
        Leading indicator analogue to Agoda Kafka growth-rate planning (vs lagging disk%).
        """
        MIN_TICKS = 5
        with self._lock:
            self._tick()
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

            hw_norm, hc_norm = _hours_pair_for_scenario(float(current), rate_hour, 1.0)
            hw_2, hc_2 = _hours_pair_for_scenario(float(current), rate_hour, 2.0)
            hw_3, hc_3 = _hours_pair_for_scenario(float(current), rate_hour, 3.0)

            if not is_growing:
                hw_norm = hw_2 = hw_3 = hc_norm = hc_2 = hc_3 = None

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
            "vulcan_note": VULCAN_NOTE,
        }
