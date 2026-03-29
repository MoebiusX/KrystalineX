"""
Autonomous Alert Poller — Pulls alerts from Alertmanager, enriches with
Prometheus exemplar trace IDs, clusters into incidents, and automatically
trains/infers using the Noisy-OR Bayesian model.

Runs as a background asyncio task inside the FastAPI application.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .models import AlertCorrelationEngine
from .schemas import AlertRecord, AlertIncident

logger = logging.getLogger("bayesian.poller")

ALERTMANAGER_URL = os.environ.get("ALERTMANAGER_URL", "http://localhost:9093")
PROMETHEUS_URL = os.environ.get("PROMETHEUS_URL", "http://localhost:9090")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "30"))
CLUSTER_WINDOW_SEC = 300  # 5-minute clustering window

# Map alert names to metric selectors that carry exemplars
ALERT_TO_EXEMPLAR_METRIC: dict[str, str] = {
    "HighLatencyP99": "http_request_duration_seconds_bucket",
    "HighLatencyP99Critical": "http_request_duration_seconds_bucket",
    "HighErrorRate": "http_request_duration_seconds_bucket",
    "OrderProcessingFailures": "order_processing_duration_seconds_bucket",
    "AnomalyDetected": "http_request_duration_seconds_bucket",
}


@dataclass
class PollerState:
    """Tracks poller state across poll cycles."""

    # Fingerprints of alerts we've already processed (to avoid re-training)
    seen_fingerprints: set[str] = field(default_factory=set)
    # Resolved incidents used for training (keep last N)
    trained_incident_ids: set[str] = field(default_factory=set)
    # Latest inference result (for GET /alert-rca)
    latest_rca: Optional[dict] = None
    last_poll_at: Optional[float] = None
    poll_count: int = 0
    error_count: int = 0


class AutonomousPoller:
    """Polls Alertmanager and drives alert correlation autonomously."""

    def __init__(self, engine: AlertCorrelationEngine) -> None:
        self.engine = engine
        self.state = PollerState()
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def latest_rca(self) -> Optional[dict]:
        return self.state.latest_rca

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._client = httpx.AsyncClient(timeout=10.0)
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(
            "Autonomous poller started: Alertmanager=%s, Prometheus=%s, interval=%ds",
            ALERTMANAGER_URL, PROMETHEUS_URL, POLL_INTERVAL,
        )

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._client:
            await self._client.aclose()
        logger.info("Autonomous poller stopped")

    async def _poll_loop(self) -> None:
        # Initial delay to let services stabilize
        await asyncio.sleep(10)

        while self._running:
            try:
                await self._poll_cycle()
                self.state.poll_count += 1
                self.state.last_poll_at = time.time()
            except asyncio.CancelledError:
                break
            except Exception:
                self.state.error_count += 1
                logger.exception("Poll cycle failed")

            await asyncio.sleep(POLL_INTERVAL)

    async def _poll_cycle(self) -> None:
        """Single poll: fetch alerts → enrich → cluster → train/infer."""
        assert self._client is not None

        # 1. Fetch all alerts from Alertmanager
        alerts = await self._fetch_alerts()
        if not alerts:
            # No alerts → clear latest RCA
            if self.state.latest_rca is not None:
                self.state.latest_rca = None
                logger.debug("No alerts firing, cleared latest RCA")
            return

        # 2. Enrich with Prometheus exemplar trace IDs
        alerts = await self._enrich_with_exemplars(alerts)

        # 3. Separate firing vs resolved
        firing = [a for a in alerts if a.resolved_at is None]
        resolved = [a for a in alerts if a.resolved_at is not None]

        # 4. Auto-train on resolved incidents (new ones only)
        if resolved:
            incidents = self._cluster_alerts(resolved)
            new_incidents = [
                inc for inc in incidents
                if inc.id not in self.state.trained_incident_ids
            ]
            if new_incidents:
                result = self.engine.train(incidents=new_incidents)
                for inc in new_incidents:
                    self.state.trained_incident_ids.add(inc.id)
                logger.info(
                    "Auto-trained on %d resolved incidents (%d total learned)",
                    len(new_incidents), result["incidents_learned"],
                )
                # Cap memory: keep only last 500 incident IDs
                if len(self.state.trained_incident_ids) > 500:
                    excess = len(self.state.trained_incident_ids) - 500
                    it = iter(self.state.trained_incident_ids)
                    for _ in range(excess):
                        self.state.trained_incident_ids.discard(next(it))

        # 5. Auto-infer on firing alerts (2+ alerts = potential storm)
        if len(firing) >= 2:
            results = self.engine.infer(alerts=firing)
            self.state.latest_rca = {
                "probable_root_causes": results,
                "incident_size": len(firing),
                "model_incidents_learned": self.engine.incidents_learned,
                "polled_at": time.time(),
                "firing_alerts": [
                    {"alertname": a.alertname, "service": a.service, "severity": a.severity}
                    for a in firing
                ],
            }
            if results:
                logger.info(
                    "Alert RCA: %d firing, top cause=%s (%.1f%%)",
                    len(firing),
                    results[0]["alert_key"],
                    results[0]["probability"] * 100,
                )
        elif len(firing) == 1:
            # Single alert — no storm to analyze, but report it
            a = firing[0]
            self.state.latest_rca = {
                "probable_root_causes": [{
                    "alert_key": f"{a.alertname}:{a.service}",
                    "alertname": a.alertname,
                    "service": a.service,
                    "probability": 1.0,
                    "evidence": "Single firing alert — no storm correlation needed",
                    "trace_id": a.trace_id,
                }],
                "incident_size": 1,
                "model_incidents_learned": self.engine.incidents_learned,
                "polled_at": time.time(),
                "firing_alerts": [
                    {"alertname": a.alertname, "service": a.service, "severity": a.severity}
                ],
            }

    # ─── Alertmanager Fetch ──────────────────────────────────────────────────

    async def _fetch_alerts(self) -> list[AlertRecord]:
        """Fetch all alerts from Alertmanager v2 API."""
        assert self._client is not None
        try:
            resp = await self._client.get(f"{ALERTMANAGER_URL}/api/v2/alerts")
            resp.raise_for_status()
            raw = resp.json()
        except Exception:
            logger.debug("Could not reach Alertmanager at %s", ALERTMANAGER_URL)
            return []

        alerts: list[AlertRecord] = []
        for a in raw:
            labels = a.get("labels", {})
            starts_at = a.get("startsAt", "")
            ends_at = a.get("endsAt", "")

            fired_at = self._parse_iso(starts_at)
            if fired_at is None:
                continue

            resolved_at = self._parse_iso(ends_at)
            # Alertmanager uses "0001-01-01T00:00:00Z" for still-firing
            if resolved_at is not None and resolved_at < 100:
                resolved_at = None

            alerts.append(AlertRecord(
                alertname=labels.get("alertname", "unknown"),
                service=labels.get("service", labels.get("job", labels.get("instance", ""))),
                severity=labels.get("severity", "warning"),
                fired_at=fired_at,
                resolved_at=resolved_at,
                labels=labels,
                fingerprint=a.get("fingerprint", ""),
                trace_id=None,
            ))

        return alerts

    # ─── Prometheus Exemplar Enrichment ──────────────────────────────────────

    async def _enrich_with_exemplars(self, alerts: list[AlertRecord]) -> list[AlertRecord]:
        """Enrich alerts with trace IDs from Prometheus exemplars API."""
        assert self._client is not None
        enriched: list[AlertRecord] = []

        for alert in alerts:
            metric_selector = ALERT_TO_EXEMPLAR_METRIC.get(alert.alertname)
            if not metric_selector:
                enriched.append(alert)
                continue

            trace_id = await self._query_exemplar_trace_id(
                metric_selector, alert.fired_at,
            )
            if trace_id:
                alert = alert.model_copy(update={"trace_id": trace_id})
                logger.debug("Enriched %s with traceId=%s", alert.alertname, trace_id)

            enriched.append(alert)

        enriched_count = sum(1 for a in enriched if a.trace_id)
        if enriched_count:
            logger.info("Enriched %d/%d alerts with exemplar traceIds", enriched_count, len(alerts))

        return enriched

    async def _query_exemplar_trace_id(
        self, metric_selector: str, around_epoch: float, window_sec: float = 300,
    ) -> Optional[str]:
        """Query Prometheus exemplars API for the nearest traceId."""
        assert self._client is not None
        start_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(around_epoch - window_sec))
        end_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(around_epoch + window_sec))

        try:
            resp = await self._client.get(
                f"{PROMETHEUS_URL}/api/v1/query_exemplars",
                params={"query": metric_selector, "start": start_iso, "end": end_iso},
            )
            if resp.status_code != 200:
                return None

            body = resp.json()
            if body.get("status") != "success" or not body.get("data"):
                return None

            best_trace_id: Optional[str] = None
            best_dist = float("inf")

            for series in body["data"]:
                for ex in series.get("exemplars", []):
                    trace_id = ex.get("labels", {}).get("traceID") or ex.get("labels", {}).get("trace_id")
                    if not trace_id:
                        continue
                    dist = abs(ex.get("timestamp", 0) - around_epoch)
                    if dist < best_dist:
                        best_dist = dist
                        best_trace_id = trace_id

            return best_trace_id
        except Exception:
            return None

    # ─── Clustering ──────────────────────────────────────────────────────────

    def _cluster_alerts(self, alerts: list[AlertRecord]) -> list[AlertIncident]:
        """Cluster alerts into incidents by time proximity."""
        if not alerts:
            return []

        sorted_alerts = sorted(alerts, key=lambda a: a.fired_at)
        incidents: list[AlertIncident] = []
        current: list[AlertRecord] = [sorted_alerts[0]]
        cluster_start = sorted_alerts[0].fired_at

        for i in range(1, len(sorted_alerts)):
            alert = sorted_alerts[i]
            if alert.fired_at - cluster_start <= CLUSTER_WINDOW_SEC:
                current.append(alert)
            else:
                incidents.append(self._build_incident(current, len(incidents)))
                current = [alert]
                cluster_start = alert.fired_at

        if current:
            incidents.append(self._build_incident(current, len(incidents)))

        return incidents

    @staticmethod
    def _build_incident(alerts: list[AlertRecord], index: int) -> AlertIncident:
        sorted_alerts = sorted(alerts, key=lambda a: a.fired_at)
        return AlertIncident(
            id=f"auto-{int(time.time())}-{index}",
            alerts=sorted_alerts,
            root_cause_alert=None,  # Model uses temporal ordering
            started_at=sorted_alerts[0].fired_at,
            ended_at=sorted_alerts[-1].fired_at,
        )

    @staticmethod
    def _parse_iso(iso_str: str) -> Optional[float]:
        """Parse ISO 8601 timestamp to epoch seconds. Returns None on failure."""
        if not iso_str:
            return None
        try:
            from datetime import datetime, timezone
            # Handle Z suffix and fractional seconds
            s = iso_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            return dt.replace(tzinfo=timezone.utc).timestamp() if dt.tzinfo is None else dt.timestamp()
        except (ValueError, OSError):
            return None
