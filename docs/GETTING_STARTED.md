# Getting Started with KrystalineX

## Prerequisites

- **Node.js** 20+
- **Docker** with Docker Compose
- **npm** 9+

## 5‑Minute Quick Start

```bash
git clone https://github.com/MoebiusX/KrystalineX.git
cd KrystalineX
npm install --legacy-peer-deps
npm run dev
```

This launches:
- **Docker infrastructure**: PostgreSQL, RabbitMQ, Jaeger, Prometheus, Grafana, Loki, Alertmanager, Kong, Redis, OTEL Collector, Ollama, MailDev
- **Node.js services**: Exchange API (port 5000), Payment Processor (matcher), React frontend (port 5173)

Browse to → **http://localhost:5173**

## First Steps

1. **Register** — Click "Start Trading" → enter email + password → verify via [MailDev](http://localhost:1080)
2. **Trade** — Buy 0.001 BTC → watch the live Binance price feed → click the Jaeger trace link in the toast
3. **Observe** — Open [Jaeger](http://localhost:16686) to see 17+ spans across 4 services
4. **Monitor** — Navigate to `/monitor` to see anomaly detection and AI diagnosis

## Key URLs (Local)

| Service | URL |
|---------|-----|
| **App** | http://localhost:5173 |
| **API** | http://localhost:5000/api/v1 |
| **Jaeger** | http://localhost:16686 |
| **Grafana** | http://localhost:3000 (admin/admin) |
| **Prometheus** | http://localhost:9090 |
| **Alertmanager** | http://localhost:9093 |
| **RabbitMQ** | http://localhost:15672 (admin/admin) |
| **MailDev** | http://localhost:1080 |

## Testing

```bash
npm test                          # unit tests (Vitest)
npm run test:e2e:playwright       # E2E tests (Playwright, headless)
npm run check                     # TypeScript type checking
npm run validate:dashboard        # Grafana dashboard validation
```

## Kubernetes Deployment

See the full [K8s deployment guide](operations/02_DEPLOYMENT_K8S.md). Summary:

```bash
# Build and push Docker image
docker build -t moebiusx/krystalinex-server:vX.Y.Z .
docker push moebiusx/krystalinex-server:vX.Y.Z

# Deploy via Helm
cd k8s/charts/krystalinex
helm template kx . --namespace krystalinex -f values.yaml | kubectl apply -n krystalinex -f -
```

## Project Structure

```
client/src/         React 18 SPA (Vite, TailwindCSS, Radix UI)
server/             Express API by domain (auth, trade, wallet, monitor)
shared/schema.ts    Zod schemas shared between client and server
payment-processor/  Order matcher microservice (RabbitMQ consumer)
bayesian-service/   Python Bayesian inference (PyMC + FastAPI)
config/             Prometheus, Alertmanager, Grafana configs
k8s/charts/         Helm chart for full K8s deployment
scripts/            Utilities (load test, dashboard validator, GoAlert provisioning)
tests/              Vitest unit/integration tests
e2e/                Playwright E2E test specs
docs/               Documentation
```

## Next Steps

- Read the [Architecture](architecture/01_ARCHITECTURE.md) for system design details
- Run the [Demo Walkthrough](DEMO.md) for a guided tour
- Explore the [Observability Whitepaper](OBSERVABILITY_WHITEPAPER.md) for the engineering philosophy
