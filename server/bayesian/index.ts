/**
 * Bayesian Inference Module — Index
 *
 * Public API for the Bayesian inference layer.
 */

export { bayesianClient, BayesianClient } from './client';
export { bayesianInference, BayesianInference } from './inference';
export { extractFeatures, extractFeaturesFromBaselines } from './feature-extractor';
export {
    fetchAlertmanagerAlerts,
    clusterAlertsIntoIncidents,
    extractAlertIncidents,
    getCurrentlyFiringAlerts,
} from './alert-extractor';
export type {
    BayesianInsight,
    ServiceInference,
    RootCause,
    InferResponse,
    TrainResponse,
    BayesianHealthResponse,
    ServiceMetrics,
    BayesianDependencyGraph,
    TimeWindow,
    AlertRecord,
    AlertIncident,
    AlertRootCause,
    TrainAlertsResponse,
    InferAlertsResponse,
} from './types';
