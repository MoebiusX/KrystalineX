"""
Hierarchical Bayesian Models for Latency and Error Analysis.

Uses PyMC for probabilistic modeling of:
1. Latency: Hierarchical LogNormal model with global + service-level parameters
2. Errors: Beta-Bernoulli model for per-service error rates
3. Dependency-aware scoring: Propagation of anomaly through service graph
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pymc as pm
import arviz as az

from .schemas import (
    DependencyGraph,
    InferResponse,
    RootCause,
    ServiceInference,
    ServiceMetrics,
    TimeWindow,
)

logger = logging.getLogger("bayesian.models")


@dataclass
class ServicePosterior:
    """Cached posterior parameters for a single service."""

    mu: float
    sigma: float
    error_alpha: float
    error_beta: float
    sample_count: int


@dataclass
class ModelState:
    """Cached model state to avoid retraining on every request."""

    posteriors: dict[str, ServicePosterior] = field(default_factory=dict)
    global_mu: float = 0.0
    global_sigma: float = 1.0
    trained: bool = False
    last_trained: Optional[str] = None
    samples_used: int = 0


class BayesianInferenceEngine:
    """
    Hierarchical Bayesian inference for distributed system observability.

    Training fits a hierarchical model to historical data and caches
    posterior parameters. Inference uses those parameters + current
    observations to produce anomaly probabilities and root cause rankings.
    """

    def __init__(self) -> None:
        self.state = ModelState()

    @property
    def is_trained(self) -> bool:
        return self.state.trained

    # ─── Training ────────────────────────────────────────────────────────

    def train(
        self,
        services: list[ServiceMetrics],
        dependency_graph: DependencyGraph,
        raw_latencies: Optional[dict[str, list[float]]] = None,
    ) -> dict:
        """
        Fit the hierarchical Bayesian model to historical service metrics.

        When raw_latencies is provided (service_name → list of durations),
        the full hierarchical model is sampled with PyMC.  Otherwise, we
        derive conjugate-style posteriors analytically from summary stats.
        """
        start = time.time()

        if raw_latencies and any(len(v) >= 10 for v in raw_latencies.values()):
            self._train_full_model(services, raw_latencies)
        else:
            self._train_from_summary(services)

        self._incorporate_dependency_priors(dependency_graph)

        elapsed = time.time() - start
        self.state.trained = True
        self.state.last_trained = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.state.samples_used = sum(s.latency.sample_count for s in services)

        logger.info(
            "Model trained in %.1fms for %d services (%d samples)",
            elapsed * 1000,
            len(services),
            self.state.samples_used,
        )

        return {
            "services_modeled": list(self.state.posteriors.keys()),
            "samples_used": self.state.samples_used,
            "training_time_ms": round(elapsed * 1000, 1),
        }

    def _train_full_model(
        self,
        services: list[ServiceMetrics],
        raw_latencies: dict[str, list[float]],
    ) -> None:
        """
        Full hierarchical PyMC model:

        Global:
            mu_global     ~ Normal(0, 1)
            sigma_global  ~ HalfNormal(1)
        Per-service:
            mu_service[i]    ~ Normal(mu_global, sigma_global)
            sigma_service[i] ~ HalfNormal(1)
        Observation:
            log(latency) ~ Normal(mu_service[i], sigma_service[i])
        """
        svc_names = [s.service_name for s in services if s.service_name in raw_latencies]
        if not svc_names:
            self._train_from_summary(services)
            return

        # Prepare data: log-transform positive latencies
        svc_indices: list[int] = []
        log_latencies: list[float] = []
        for idx, name in enumerate(svc_names):
            vals = [v for v in raw_latencies[name] if v > 0]
            for v in vals:
                log_latencies.append(np.log(v))
                svc_indices.append(idx)

        if len(log_latencies) < 5:
            self._train_from_summary(services)
            return

        n_services = len(svc_names)
        svc_idx_arr = np.array(svc_indices, dtype=int)
        obs_arr = np.array(log_latencies, dtype=float)

        with pm.Model() as model:
            # Global hyperpriors
            mu_global = pm.Normal("mu_global", mu=np.mean(obs_arr), sigma=1.0)
            sigma_global = pm.HalfNormal("sigma_global", sigma=1.0)

            # Service-level parameters
            mu_service = pm.Normal(
                "mu_service", mu=mu_global, sigma=sigma_global, shape=n_services
            )
            sigma_service = pm.HalfNormal("sigma_service", sigma=1.0, shape=n_services)

            # Likelihood
            pm.Normal(
                "obs",
                mu=mu_service[svc_idx_arr],
                sigma=sigma_service[svc_idx_arr],
                observed=obs_arr,
            )

            # Sample — use fewer samples for speed; we cache posteriors
            trace = pm.sample(
                draws=500,
                tune=200,
                chains=2,
                cores=1,  # single-core for container compatibility
                return_inferencedata=True,
                progressbar=False,
            )

        # Extract posterior summaries
        summary = az.summary(trace, var_names=["mu_global", "sigma_global", "mu_service", "sigma_service"])

        self.state.global_mu = float(summary.loc["mu_global", "mean"])
        self.state.global_sigma = float(summary.loc["sigma_global", "mean"])

        for idx, name in enumerate(svc_names):
            mu_key = f"mu_service[{idx}]"
            sigma_key = f"sigma_service[{idx}]"
            mu_val = float(summary.loc[mu_key, "mean"]) if mu_key in summary.index else 0.0
            sigma_val = float(summary.loc[sigma_key, "mean"]) if sigma_key in summary.index else 1.0

            # Derive error model from observed data
            svc_metrics = next((s for s in services if s.service_name == name), None)
            alpha, beta = self._error_posterior(svc_metrics)

            self.state.posteriors[name] = ServicePosterior(
                mu=mu_val,
                sigma=sigma_val,
                error_alpha=alpha,
                error_beta=beta,
                sample_count=svc_metrics.latency.sample_count if svc_metrics else 0,
            )

    def _train_from_summary(self, services: list[ServiceMetrics]) -> None:
        """
        Analytical conjugate-style posterior from summary statistics.

        For latency (LogNormal):
            mu_service  = log(mean) - 0.5 * log(1 + (std/mean)^2)
            sigma_service = sqrt(log(1 + (std/mean)^2))

        For errors (Beta-Bernoulli with weak prior Beta(1,1)):
            alpha = 1 + error_count
            beta  = 1 + (request_count - error_count)
        """
        all_log_means: list[float] = []

        for svc in services:
            lat = svc.latency
            mean_val = max(lat.mean, 0.01)
            std_val = max(lat.std_dev, 0.01)

            cv_sq = (std_val / mean_val) ** 2
            mu_log = np.log(mean_val) - 0.5 * np.log(1 + cv_sq)
            sigma_log = np.sqrt(np.log(1 + cv_sq))

            all_log_means.append(mu_log)

            alpha, beta = self._error_posterior_from_counts(
                svc.error_count, svc.request_count
            )

            self.state.posteriors[svc.service_name] = ServicePosterior(
                mu=float(mu_log),
                sigma=float(sigma_log),
                error_alpha=alpha,
                error_beta=beta,
                sample_count=lat.sample_count,
            )

        if all_log_means:
            self.state.global_mu = float(np.mean(all_log_means))
            self.state.global_sigma = float(np.std(all_log_means)) if len(all_log_means) > 1 else 1.0

    def _error_posterior(self, svc: Optional[ServiceMetrics]) -> tuple[float, float]:
        if svc is None:
            return 1.0, 1.0
        return self._error_posterior_from_counts(svc.error_count, svc.request_count)

    @staticmethod
    def _error_posterior_from_counts(errors: int, total: int) -> tuple[float, float]:
        """Beta posterior with uniform prior Beta(1,1)."""
        return 1.0 + errors, 1.0 + max(total - errors, 0)

    def _incorporate_dependency_priors(self, graph: DependencyGraph) -> None:
        """
        Adjust posteriors based on dependency graph.

        If a downstream service has high error/latency, propagate
        increased uncertainty to upstream services.
        """
        children_of: dict[str, list[str]] = {}
        for edge in graph.edges:
            children_of.setdefault(edge.parent, []).append(edge.child)

        for parent, children in children_of.items():
            if parent not in self.state.posteriors:
                continue
            parent_post = self.state.posteriors[parent]

            child_sigmas: list[float] = []
            child_error_rates: list[float] = []
            for child in children:
                if child in self.state.posteriors:
                    cp = self.state.posteriors[child]
                    child_sigmas.append(cp.sigma)
                    child_error_rates.append(
                        cp.error_alpha / (cp.error_alpha + cp.error_beta)
                    )

            if child_sigmas:
                # Widen parent sigma by max downstream uncertainty (dampened)
                max_child_sigma = max(child_sigmas)
                parent_post.sigma = np.sqrt(
                    parent_post.sigma ** 2 + 0.25 * max_child_sigma ** 2
                )

            if child_error_rates:
                # Shift parent error prior toward higher error if children are failing
                max_child_err = max(child_error_rates)
                if max_child_err > 0.1:
                    parent_post.error_alpha += max_child_err * 2

    # ─── Inference ───────────────────────────────────────────────────────

    def infer(
        self,
        services: list[ServiceMetrics],
        dependency_graph: DependencyGraph,
        time_windows: Optional[list[TimeWindow]] = None,
    ) -> InferResponse:
        """
        Produce anomaly probabilities and root cause rankings
        from current observations against trained posteriors.
        """
        start = time.time()
        results: list[ServiceInference] = []

        # Build adjacency for root-cause propagation
        parents_of: dict[str, list[str]] = {}
        for edge in dependency_graph.edges:
            parents_of.setdefault(edge.child, []).append(edge.parent)

        children_of: dict[str, list[str]] = {}
        for edge in dependency_graph.edges:
            children_of.setdefault(edge.parent, []).append(edge.child)

        # Per-service anomaly scores
        anomaly_scores: dict[str, float] = {}
        error_scores: dict[str, float] = {}

        for svc in services:
            lat_prob = self._latency_anomaly_probability(svc)
            err_prob = self._error_anomaly_probability(svc)
            anomaly_scores[svc.service_name] = lat_prob
            error_scores[svc.service_name] = err_prob

        # Incorporate time-window trends
        trend_multipliers = self._compute_trend_multipliers(time_windows) if time_windows else {}

        for svc in services:
            name = svc.service_name
            lat_prob = anomaly_scores.get(name, 0.0)
            err_prob = error_scores.get(name, 0.0)

            # Apply trend multiplier
            if name in trend_multipliers:
                lat_prob = min(1.0, lat_prob * trend_multipliers[name])

            # Rank root causes: look at downstream dependencies
            root_causes = self._rank_root_causes(
                name, children_of, anomaly_scores, error_scores, services
            )

            # Confidence based on sample count and model state
            posterior = self.state.posteriors.get(name)
            confidence = self._compute_confidence(posterior, svc)

            results.append(
                ServiceInference(
                    service=name,
                    latency_anomaly_probability=round(lat_prob, 4),
                    error_anomaly_probability=round(err_prob, 4),
                    likely_root_causes=root_causes,
                    confidence=round(confidence, 4),
                    posterior_latency_mean=round(posterior.mu, 4) if posterior else None,
                    posterior_latency_std=round(posterior.sigma, 4) if posterior else None,
                    posterior_error_rate=round(
                        posterior.error_alpha / (posterior.error_alpha + posterior.error_beta), 4
                    ) if posterior else None,
                )
            )

        elapsed_ms = (time.time() - start) * 1000

        return InferResponse(
            results=results,
            model_trained=self.state.trained,
            inference_time_ms=round(elapsed_ms, 2),
        )

    def _latency_anomaly_probability(self, svc: ServiceMetrics) -> float:
        """
        P(anomaly | observed_latency) using the LogNormal posterior.

        Computes the probability that the observed mean latency exceeds
        the posterior predictive distribution's 95th percentile.
        """
        posterior = self.state.posteriors.get(svc.service_name)
        if not posterior:
            return self._fallback_latency_score(svc)

        observed_mean = max(svc.latency.mean, 0.01)
        log_obs = np.log(observed_mean)

        # Z-score in log-space against posterior
        if posterior.sigma < 0.001:
            return 0.0

        z = (log_obs - posterior.mu) / posterior.sigma

        # Convert to probability using sigmoid for smooth [0,1] mapping
        # z > 2 means observed is well above posterior expectation
        # Clip exponent to prevent numpy overflow
        exponent = np.clip(-1.5 * (z - 1.5), -700, 700)
        prob = float(1.0 / (1.0 + np.exp(exponent)))
        return min(1.0, max(0.0, prob))

    def _error_anomaly_probability(self, svc: ServiceMetrics) -> float:
        """
        P(error_rate_anomalous) using Beta posterior.

        Compares observed error rate against the posterior Beta
        distribution's expected value and spread.
        """
        posterior = self.state.posteriors.get(svc.service_name)
        if not posterior:
            return min(1.0, svc.error_rate * 5)  # crude fallback

        expected_rate = posterior.error_alpha / (posterior.error_alpha + posterior.error_beta)
        total = posterior.error_alpha + posterior.error_beta

        if total < 2.1:
            # Weak prior — rely more on observed
            return min(1.0, svc.error_rate * 3)

        # Compute how extreme the observed rate is vs posterior
        variance = (posterior.error_alpha * posterior.error_beta) / (
            total ** 2 * (total + 1)
        )
        std = np.sqrt(variance) if variance > 0 else 0.01

        if std < 0.0001:
            return 1.0 if svc.error_rate > expected_rate + 0.05 else 0.0

        z = (svc.error_rate - expected_rate) / std
        exponent = np.clip(-1.0 * (z - 2.0), -700, 700)
        prob = float(1.0 / (1.0 + np.exp(exponent)))
        return min(1.0, max(0.0, prob))

    def _fallback_latency_score(self, svc: ServiceMetrics) -> float:
        """Heuristic score when no posterior is available."""
        if svc.latency.std_dev < 0.01:
            return 0.0
        z = (svc.latency.mean - svc.latency.p50) / max(svc.latency.std_dev, 0.01)
        return min(1.0, max(0.0, z / 5.0))

    def _rank_root_causes(
        self,
        service: str,
        children_of: dict[str, list[str]],
        anomaly_scores: dict[str, float],
        error_scores: dict[str, float],
        services: list[ServiceMetrics],
    ) -> list[RootCause]:
        """
        Rank downstream services as likely root causes.

        A downstream service is a likely root cause if:
        1. It has a high anomaly score
        2. It has a high error rate
        3. It is in the dependency path of the current service
        """
        children = children_of.get(service, [])
        if not children:
            # Self is the leaf — if anomalous, self is root cause
            self_score = anomaly_scores.get(service, 0.0)
            if self_score > 0.3:
                return [
                    RootCause(
                        service=service,
                        probability=round(self_score, 4),
                        evidence="Leaf service with elevated latency",
                    )
                ]
            return []

        candidates: list[RootCause] = []

        for child in children:
            lat_score = anomaly_scores.get(child, 0.0)
            err_score = error_scores.get(child, 0.0)

            # Combined score: weighted average
            combined = 0.6 * lat_score + 0.4 * err_score
            if combined < 0.1:
                continue

            # Build evidence string
            svc_metrics = next((s for s in services if s.service_name == child), None)
            evidence_parts: list[str] = []
            if lat_score > 0.3:
                evidence_parts.append(f"latency_anomaly={lat_score:.2f}")
            if err_score > 0.3:
                evidence_parts.append(f"error_anomaly={err_score:.2f}")
            if svc_metrics:
                evidence_parts.append(f"p99={svc_metrics.latency.p99:.1f}ms")
                if svc_metrics.error_rate > 0.01:
                    evidence_parts.append(f"err_rate={svc_metrics.error_rate:.1%}")

            # Recurse one level: check if child's children are the actual root cause
            grandchild_scores: list[float] = []
            for grandchild in children_of.get(child, []):
                gc_score = anomaly_scores.get(grandchild, 0.0)
                if gc_score > combined:
                    grandchild_scores.append(gc_score)

            # If grandchild is more anomalous, dampen child's score
            if grandchild_scores:
                combined *= 0.7

            candidates.append(
                RootCause(
                    service=child,
                    probability=round(min(1.0, combined), 4),
                    evidence="; ".join(evidence_parts) if evidence_parts else "downstream dependency",
                )
            )

        # Sort by probability descending, limit to top 5
        candidates.sort(key=lambda x: x.probability, reverse=True)
        return candidates[:5]

    def _compute_trend_multipliers(
        self, time_windows: list[TimeWindow]
    ) -> dict[str, float]:
        """
        Detect worsening trends across time windows.

        If a service's latency is increasing across windows (5m > 15m > 1h),
        that amplifies the anomaly probability.
        """
        # Group by service, ordered by window size (smallest first)
        svc_window_means: dict[str, list[tuple[str, float]]] = {}

        sorted_windows = sorted(time_windows, key=lambda w: w.end_epoch_ms - w.start_epoch_ms)
        for window in sorted_windows:
            for svc in window.services:
                svc_window_means.setdefault(svc.service_name, []).append(
                    (window.window_name, svc.latency.mean)
                )

        multipliers: dict[str, float] = {}
        for name, windows in svc_window_means.items():
            if len(windows) < 2:
                continue
            # Check if mean is monotonically increasing (worsening)
            means = [m for _, m in windows]
            increasing_count = sum(
                1 for i in range(1, len(means)) if means[i] > means[i - 1] * 1.1
            )
            if increasing_count >= len(means) - 1:
                multipliers[name] = 1.3  # 30% boost for worsening trend
            elif increasing_count > 0:
                multipliers[name] = 1.1  # 10% boost for partial trend

        return multipliers

    @staticmethod
    def _compute_confidence(
        posterior: Optional[ServicePosterior], svc: ServiceMetrics
    ) -> float:
        """
        Confidence score [0, 1] based on data quality.

        Higher when:
        - More training samples
        - Tighter posterior (low sigma)
        - Current observation has reasonable sample count
        """
        if posterior is None:
            return 0.3  # Low confidence without posterior

        # Sample count factor: saturates around 1000 samples
        sample_factor = min(1.0, posterior.sample_count / 1000)

        # Precision factor: tighter posterior = higher confidence
        precision_factor = 1.0 / (1.0 + posterior.sigma)

        # Current data factor
        current_factor = min(1.0, svc.latency.sample_count / 50)

        confidence = 0.4 * sample_factor + 0.35 * precision_factor + 0.25 * current_factor
        return min(1.0, max(0.1, confidence))
