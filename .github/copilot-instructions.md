# Copilot Instructions — KrystalineX

## Build, Test, and Lint

```bash
npm install --legacy-peer-deps    # required flag for peer dep conflicts
npm run check                     # TypeScript type checking (tsc --noEmit)
npm run build                     # Vite frontend build + esbuild server bundle
npm run dev                       # Full dev stack (Docker infra + native Node services)

# Unit tests (Vitest)
npm test                          # run all unit tests
npx vitest run tests/auth.test.ts # run a single test file
npx vitest run -t "test name"     # run a single test by name

# E2E tests (Playwright — requires dev stack running)
npm run test:e2e:playwright       # headless
npm run test:e2e:headed           # visible browser
npm run test:e2e:ui               # Playwright interactive UI

# Pre-commit checks
npm run precommit                 # tsc + secret scan + confidential doc check
```

## Architecture

KrystalineX is a full-stack TypeScript monorepo (React + Express) for an institutional-grade crypto exchange with a "Proof of Observability" philosophy.

### Monorepo Layout

- **`client/src/`** — React 18 SPA (Vite, Wouter routing, TanStack React Query, shadcn/ui + Tailwind)
- **`server/`** — Express API organized by domain: `auth/`, `trade/`, `wallet/`, `monitor/`, `api/`
- **`shared/schema.ts`** — Single source of truth for Zod schemas shared between client and server. Types are inferred via `z.infer<>`.
- **`payment-processor/`** — Standalone microservice for order matching; consumes/publishes via RabbitMQ
- **`config/`** — Observability stack configs (Prometheus, Alertmanager, Loki, Grafana, OTEL Collector)
- **`e2e/`** — Playwright E2E test specs
- **`tests/`** — Vitest unit/integration tests

### Key Architectural Patterns

**Storage layer** — Repository pattern with an `IStorage` interface (`server/storage.ts`) and a PostgreSQL implementation (`server/db/postgres-storage.ts`) using raw `pg` queries (not Drizzle query builder at runtime). Drizzle ORM is used only for schema definition (`server/db/schema.ts`) and migrations (`drizzle-kit push`).

**Middleware chain** — Order matters. Applied in `server/index.ts`: Prometheus metrics → health checks → Helmet security headers → rate limiting → request timeout (30s) → correlation ID logging → body parsers → CORS → domain routes → global error handler.

**Error handling** — Custom error hierarchy in `server/lib/errors.ts` extending `AppError`. Domain errors (`OrderError`, `WalletError`, `InsufficientFundsError`) and HTTP errors (`ValidationError`, `UnauthorizedError`, etc.) are all caught by the global error handler middleware which formats responses and hides internal details in production.

**Distributed tracing** — All services emit OpenTelemetry spans. W3C trace context propagates through RabbitMQ message headers (`traceparent`, `tracestate`), enabling end-to-end trace reconstruction across the exchange API, matcher, and gateway.

**Anomaly detection** — Time-aware latency baselines per `service:operation` using Welford's online algorithm across 168 hourly buckets. Anomalies trigger severity classification (SEV 1–5) and optional LLM-powered root-cause analysis streamed over WebSocket.

### Client Patterns

- **Routing**: Wouter (lightweight). Routes defined in `client/src/App.tsx`.
- **State**: TanStack React Query for server state. No global client state library.
- **Components**: shadcn/ui (New York style) with Radix UI primitives. Config in `components.json`. Aliases: `@/components`, `@/ui`, `@/hooks`, `@/lib`.
- **i18n**: i18next with `en` and `es` locales. Translations bundled at build time in `client/src/i18n/`. Language key stored in localStorage as `krystaline-language`.

### Path Aliases

Configured in both `tsconfig.json` and `vite.config.ts`:
- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`

## Conventions

- **Commit messages**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- **Validation**: Zod schemas for all API input/output. Define schemas in `shared/schema.ts` when shared, or colocate with the server route when server-only.
- **Database**: PostgreSQL on port 5433. Schema changes go through Drizzle (`server/db/schema.ts`) and are applied with `npm run db:push`.
- **Secrets**: Never commit `.env` files. Run `npm run security:secrets` to scan. JWT_SECRET must be 32+ chars; DB_PASSWORD 12+ chars.
- **Testing**: Unit tests mock the storage layer and external services (RabbitMQ, wallet service, price service, logger, OTEL). Integration tests use `supertest` with a `createTestApp()` factory. Test setup is in `tests/setup.ts`.
- **Security middleware**: Three-tier rate limiting — general (300/min), auth (60/min), sensitive (15/min).
- **Docker**: Infrastructure services (Postgres, RabbitMQ, Jaeger, Prometheus, Grafana, etc.) run in Docker Compose. Node.js services run natively on host for faster iteration.
