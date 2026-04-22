"""
SQLite persistence for incident lifecycle (TPM post-mortem layer).

Incidents survive process restarts. Mode transitions open/close rows;
ticks update peak metrics without emitting an event every second.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

_lock = threading.Lock()


def _db_path() -> Path:
    env = os.environ.get("INCIDENT_DB_PATH")
    if env:
        return Path(env)
    app_dir = Path("/app")
    if app_dir.is_dir():
        return app_dir / "incidents.db"
    return Path(__file__).resolve().parent / "incidents.db"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _init_schema(conn)
    return conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            failure_type TEXT NOT NULL,
            start_time REAL NOT NULL,
            end_time REAL,
            duration_seconds REAL,
            peak_connections INTEGER NOT NULL DEFAULT 0,
            peak_latency_p99_ms REAL NOT NULL DEFAULT 0,
            min_distribution_score REAL NOT NULL DEFAULT 100,
            backends_affected TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            incident_id INTEGER NOT NULL,
            timestamp REAL NOT NULL,
            event_type TEXT NOT NULL,
            description TEXT NOT NULL,
            backend_id TEXT,
            metric_value REAL,
            FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_events_incident ON events(incident_id);
        CREATE INDEX IF NOT EXISTS idx_incidents_start ON incidents(start_time DESC);
        """
    )
    conn.commit()


def _snapshot_from_simulator(sim: Any) -> Dict[str, Any]:
    max_conn_one = max((b.connections for b in sim.backends), default=0)
    peak_latency = max((b.latency_p99_ms for b in sim.backends), default=0.0)

    total_rps = sum(b.rps for b in sim.backends)
    rps_values = [b.rps for b in sim.backends]
    max_rps = max(rps_values) if rps_values else 1.0
    ideal_rps = total_rps / len(sim.backends) if sim.backends else 1.0
    distribution_score = max(0.0, 100 - (max_rps - ideal_rps) / ideal_rps * 100)

    affected = [b.id for b in sim.backends if not b.healthy or b.connections > 500 * 0.65]

    return {
        "max_backend_connections": int(max_conn_one),
        "peak_latency_p99_ms": float(peak_latency),
        "distribution_score": round(distribution_score, 1),
        "backends_affected": affected,
    }


def create_incident(failure_type: str) -> int:
    """Create active incident row + detection event."""
    with _lock:
        conn = _connect()
        try:
            now = time.time()
            cur = conn.execute(
                """
                INSERT INTO incidents (
                    failure_type, start_time, end_time, duration_seconds,
                    peak_connections, peak_latency_p99_ms, min_distribution_score,
                    backends_affected, status
                ) VALUES (?, ?, NULL, NULL, 0, 0, 100, '[]', 'active')
                """,
                (failure_type, now),
            )
            conn.commit()
            incident_id = int(cur.lastrowid)
            conn.execute(
                """
                INSERT INTO events (incident_id, timestamp, event_type, description, backend_id, metric_value)
                VALUES (?, ?, ?, ?, NULL, NULL)
                """,
                (
                    incident_id,
                    now,
                    "incident_detected",
                    f"Incident detected: {failure_type} triggered",
                ),
            )
            conn.commit()
            return incident_id
        finally:
            conn.close()


def record_incident_tick(incident_id: int, sim: Any) -> None:
    """Advance peak metrics during an active incident."""
    with _lock:
        conn = _connect()
        try:
            snap = _snapshot_from_simulator(sim)
            row = conn.execute(
                """
                SELECT peak_connections, peak_latency_p99_ms, min_distribution_score, backends_affected
                FROM incidents WHERE id = ? AND status = 'active'
                """,
                (incident_id,),
            ).fetchone()
            if not row:
                return

            peak_c = max(int(row["peak_connections"]), snap["max_backend_connections"])
            peak_l = max(float(row["peak_latency_p99_ms"]), snap["peak_latency_p99_ms"])
            min_score = min(float(row["min_distribution_score"]), snap["distribution_score"])
            prev_backends = set(json.loads(row["backends_affected"]))
            merged = sorted(prev_backends | set(snap["backends_affected"]))

            conn.execute(
                """
                UPDATE incidents SET
                    peak_connections = ?,
                    peak_latency_p99_ms = ?,
                    min_distribution_score = ?,
                    backends_affected = ?
                WHERE id = ? AND status = 'active'
                """,
                (peak_c, peak_l, min_score, json.dumps(merged), incident_id),
            )
            conn.commit()
        finally:
            conn.close()


def resolve_incident(incident_id: int, sim: Any) -> None:
    """Close incident with final peaks + resolved event."""
    with _lock:
        conn = _connect()
        try:
            snap = _snapshot_from_simulator(sim)
            row = conn.execute(
                "SELECT start_time, status FROM incidents WHERE id = ?",
                (incident_id,),
            ).fetchone()
            if not row or row["status"] != "active":
                return

            cur_row = conn.execute(
                """
                SELECT peak_connections, peak_latency_p99_ms, min_distribution_score, backends_affected
                FROM incidents WHERE id = ?
                """,
                (incident_id,),
            ).fetchone()

            peak_c = max(int(cur_row["peak_connections"]), snap["max_backend_connections"])
            peak_l = max(float(cur_row["peak_latency_p99_ms"]), snap["peak_latency_p99_ms"])
            min_score = min(float(cur_row["min_distribution_score"]), snap["distribution_score"])
            merged = sorted(
                set(json.loads(cur_row["backends_affected"])) | set(snap["backends_affected"])
            )

            now = time.time()
            duration = max(0.0, now - float(row["start_time"]))

            conn.execute(
                """
                UPDATE incidents SET
                    end_time = ?,
                    duration_seconds = ?,
                    peak_connections = ?,
                    peak_latency_p99_ms = ?,
                    min_distribution_score = ?,
                    backends_affected = ?,
                    status = 'resolved'
                WHERE id = ?
                """,
                (
                    now,
                    duration,
                    peak_c,
                    peak_l,
                    min_score,
                    json.dumps(merged),
                    incident_id,
                ),
            )
            conn.execute(
                """
                INSERT INTO events (incident_id, timestamp, event_type, description, backend_id, metric_value)
                VALUES (?, ?, ?, ?, NULL, NULL)
                """,
                (
                    incident_id,
                    now,
                    "incident_resolved",
                    "Incident resolved: system returned to normal",
                ),
            )
            conn.commit()
        finally:
            conn.close()


def add_event(
    incident_id: int,
    event_type: str,
    description: str,
    backend_id: Optional[str] = None,
    metric_value: Optional[float] = None,
) -> int:
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute(
                """
                INSERT INTO events (incident_id, timestamp, event_type, description, backend_id, metric_value)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (incident_id, time.time(), event_type, description, backend_id, metric_value),
            )
            conn.commit()
            return int(cur.lastrowid)
        finally:
            conn.close()


def _row_incident(r: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": r["id"],
        "failure_type": r["failure_type"],
        "start_time": r["start_time"],
        "end_time": r["end_time"],
        "duration_seconds": r["duration_seconds"],
        "peak_connections": r["peak_connections"],
        "peak_latency_p99_ms": r["peak_latency_p99_ms"],
        "min_distribution_score": r["min_distribution_score"],
        "backends_affected": json.loads(r["backends_affected"]),
        "status": r["status"],
    }


def _incident_detail(conn: sqlite3.Connection, incident_id: int) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT * FROM incidents WHERE id = ?", (incident_id,)).fetchone()
    if not row:
        return None
    ev = conn.execute(
        "SELECT * FROM events WHERE incident_id = ? ORDER BY timestamp ASC",
        (incident_id,),
    ).fetchall()
    base = _row_incident(row)
    base["events"] = [
        {
            "id": e["id"],
            "timestamp": e["timestamp"],
            "event_type": e["event_type"],
            "description": e["description"],
            "backend_id": e["backend_id"],
            "metric_value": e["metric_value"],
        }
        for e in ev
    ]
    return base


def get_incidents(limit: int = 20) -> List[Dict[str, Any]]:
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT * FROM incidents ORDER BY start_time DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [_row_incident(r) for r in rows]
        finally:
            conn.close()


def get_incident_by_id(incident_id: int) -> Optional[Dict[str, Any]]:
    with _lock:
        conn = _connect()
        try:
            return _incident_detail(conn, incident_id)
        finally:
            conn.close()


def get_active_incident() -> Optional[Dict[str, Any]]:
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                """
                SELECT id FROM incidents WHERE status = 'active' ORDER BY start_time DESC LIMIT 1
                """
            ).fetchone()
            if not row:
                return None
            return _incident_detail(conn, int(row["id"]))
        finally:
            conn.close()


def _fmt_clock(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M:%S")


def _severity_for(failure_type: str) -> str:
    if failure_type in ("dns_stickiness", "connection_exhaustion"):
        return "CRITICAL"
    return "WARNING"


def _fmt_duration(seconds: Optional[float]) -> tuple:
    if seconds is None:
        return (0, 0)
    sec = int(seconds)
    return (sec // 60, sec % 60)


def _root_cause(failure_type: str) -> str:
    if failure_type == "dns_stickiness":
        return (
            "DNS TTL caching caused application instances to reuse a single resolved VAST virtual IP far longer "
            "than expected under bursty S3 workloads. Despite Storefront distributing traffic fairly at the load "
            "balancer, clients pinned to one backend until OS-level DNS caches refreshed — producing pre-Storefront "
            "stickiness identical to the classic Microsoft DNS minimum TTL behaviour described in Agoda's Storefront "
            "engineering article."
        )
    if failure_type == "connection_exhaustion":
        return (
            "An S3 client workload failed to fully drain HTTP response bodies. Connections stayed attached to IO "
            "streams waiting on full buffers, which prevented fresh requests from acquiring slots on the affected "
            "VAST backends — the bad client IO pattern Storefront documented as the root cause of connection "
            "pool exhaustion."
        )
    if failure_type == "cross_dc_throttling":
        return (
            "Cross-datacenter replication traffic saturated dedicated cross-DC VAST endpoints and throttled bandwidth "
            "shared across the cluster. Same-datacenter workloads experienced collateral latency because they contend "
            "for the same VAST cluster resources."
        )
    return (
        "Operational stress on the Storefront-monitored backend pool exceeded normal bounds; "
        "review simulator mode and correlated metrics for specifics."
    )


def _what_storefront_did(failure_type: str) -> str:
    if failure_type == "dns_stickiness":
        return (
            "Storefront's least-inflight-requests algorithm continued steering new TCP connections toward healthier "
            "virtual IPs as soon as DNS refresh exposed them, but could not migrate existing client sockets still "
            "bound to the sticky resolution until cache expiry."
        )
    if failure_type == "connection_exhaustion":
        return (
            "Storefront's least-inflight-requests algorithm continued routing new connections to available backends, "
            "but could not drain existing stale connections until IO stream timeouts fired for the misbehaving client."
        )
    if failure_type == "cross_dc_throttling":
        return (
            "Storefront isolated cross-DC upstream pools where configured, reducing blast radius for backup traffic; "
            "without separation, cross-DC saturation still elevates latency on shared VAST nodes."
        )
    return (
        "Storefront continued to apply least-inflight-requests balancing, prioritising backends with spare capacity "
        "while unhealthy nodes recovered."
    )


def _recommended_actions(failure_type: str) -> str:
    if failure_type == "dns_stickiness":
        return (
            "- Tune application DNS caching / JVM DNS TTL so clients refresh before hot spots develop.\n"
            "- Shard bursty S3 workloads across resolver namespaces or pods to avoid single-VIP pinning.\n"
            "- Confirm Storefront telemetry shows even per-backend RPS within one refresh window."
        )
    if failure_type == "connection_exhaustion":
        return (
            "- Patch S3 SDK usage to fully consume HTTP bodies or bound streaming reads.\n"
            "- Enable aggressive idle timeouts on misbehaving clients and alert on backend connection utilisation >65%.\n"
            "- Stage traffic via canary accounts before scaling batch jobs."
        )
    if failure_type == "cross_dc_throttling":
        return (
            "- Schedule cross-DC replication jobs into maintenance windows with bandwidth headroom.\n"
            "- Split backup replication across distinct upstream pools / cross-DC routes per Agoda's DR design.\n"
            "- Alert when cross-DC latency exceeds SLO while same-DC latency climbs in tandem."
        )
    return (
        "- Review correlating dashboards for Storefront routing decisions during the window.\n"
        "- Capture client SDK versions and workload tags for replay in staging.\n"
    )


def build_incident_report_markdown(incident_id: int) -> Optional[str]:
    data = get_incident_by_id(incident_id)
    if not data:
        return None

    ft = data["failure_type"]
    status = data["status"].upper()
    mins, secs = _fmt_duration(data["duration_seconds"])
    if status == "ACTIVE":
        mins, secs = _fmt_duration(time.time() - float(data["start_time"]))

    sev = _severity_for(ft)

    min_score = float(data["min_distribution_score"])
    peak_lat = float(data["peak_latency_p99_ms"])
    peak_conn = int(data["peak_connections"])
    affected = data["backends_affected"]
    acount = len(affected)

    baseline_score = 90.0
    baseline_lat = 4.0
    baseline_conn = 80

    d_score = max(0.0, baseline_score - min_score)
    d_lat = max(0.0, peak_lat - baseline_lat)
    d_conn = max(0, peak_conn - baseline_conn)

    lines = []
    lines.append("---")
    lines.append(f"# Incident Report — {ft.upper().replace('_', ' ')}")
    lines.append(f"**Incident ID:** INC-{incident_id}  ")
    lines.append(f"**Status:** {status}  ")
    lines.append(f"**Duration:** {mins} minutes {secs} seconds  ")
    lines.append(f"**Severity:** {sev}")
    lines.append("")
    lines.append("## Timeline")
    events = data.get("events") or []
    if not events:
        ts = float(data["start_time"])
        lines.append(f"- {_fmt_clock(ts)} — Incident detected: {ft} triggered")
    else:
        for e in events:
            lines.append(f"- {_fmt_clock(float(e['timestamp']))} — {e['description']}")
    lines.append("")
    lines.append("## Impact Summary")
    lines.append("| Metric | Peak Value | Normal Baseline | Delta |")
    lines.append("|--------|-----------|-----------------|-------|")
    lines.append(
        f"| Distribution Score | {min_score:.1f} | {baseline_score:.0f} | -{d_score:.1f} |"
    )
    lines.append(
        f"| P99 Latency | {peak_lat:.1f}ms | {baseline_lat:.0f}ms | +{d_lat:.1f}ms |"
    )
    lines.append(
        f"| Max Connections | {peak_conn} | {baseline_conn} | +{d_conn} |"
    )
    lines.append(f"| Backends Affected | {acount} | 0 | — |")
    lines.append("")
    lines.append("## Root Cause")
    lines.append(_root_cause(ft))
    lines.append("")
    lines.append("## What Storefront Did")
    lines.append(_what_storefront_did(ft))
    lines.append("")
    lines.append("## Recommended Actions")
    lines.append(_recommended_actions(ft))
    lines.append("")
    lines.append("## Reference")
    lines.append("Source: Agoda Storefront Engineering Article, February 2026")
    lines.append("---")
    return "\n".join(lines)
