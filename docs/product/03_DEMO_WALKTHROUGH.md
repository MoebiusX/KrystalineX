# KrystalineX Investor Demo Walkthrough

> **Purpose:** Step-by-step guide to demonstrate "Proof of Observability™"  
> **Duration:** 12-15 minutes  
> **Updated:** 2026-03-01  
> **Environment:** Kubernetes (Helm) at `www.krystaline.io`

---

## Pre-Demo Checklist

### Verify Services Running

> **Auth:** Observability endpoints require nginx basic auth — see `values-secrets.yaml` for credentials

| Service | URL | Auth Required |
|---------|-----|---------------|
| **App** | https://www.krystaline.io | No |
| **Grafana** | https://www.krystaline.io/grafana/ | Yes (nginx + Grafana) |
| **Jaeger** | https://www.krystaline.io/jaeger/ | Yes |
| **Prometheus** | https://www.krystaline.io/prometheus/ | Yes |
| **Alertmanager** | https://www.krystaline.io/alertmanager/ | Yes |
| **GoAlert** | https://www.krystaline.io/goalert/ | Yes |

### Pre-Demo Warm-up
```powershell
# Recalculate baselines to ensure fresh K8s metrics
curl -X POST https://www.krystaline.io/api/v1/monitor/recalculate

# Execute 5-10 trades to warm up the trace pipeline
```

---

## Demo Flow

### Act 1: The Promise (2 min)

**Navigate to:** `https://www.krystaline.io` (Landing Page)

**What You'll See:**
- "Proof of Observability™" headline
- Live system status badge
- Performance metrics (P50, P95, P99)
- 100% Transaction Coverage indicator

**Talking Points:**
> "Unlike traditional exchanges where your trade disappears into a black box, Krystaline shows you exactly how every transaction flows through our system."

> "This isn't a dashboard of made-up numbers—every metric comes from real OpenTelemetry instrumentation."

**Known Issues to Avoid:**
- ⚠️ "Traces Collected: 0" if no trades yet—skip past this quickly
- ⚠️ Some font sizes are inconsistent—keep moving

---

### Act 2: User Onboarding (3 min)

**Step 1: Register**
- Click "Start Trading" → `/register`
- Enter: `demo@investor.com` / `Password123`
- Submit → "Check your email"

**Step 2: Verify Email**
- Open new tab: MailDev (if exposed) or check email service
- Find verification email
- Copy 6-digit code

**Step 3: Complete Verification**
- Back to app → Enter code
- Success → Redirected to login

**Step 4: Login**
- Enter credentials
- JWT tokens stored → Redirected to `/portfolio`

**Talking Points:**
> "Real email verification, real JWT tokens with refresh logic, real password hashing with bcrypt—this isn't a mockup."

---

### Act 3: Portfolio Overview (2 min)

**On `/portfolio` (My Wallet):**

**What You'll See:**
- Total balance in USD (calculated with real Binance prices)
- Individual asset cards: BTC, ETH, USDT, USD
- Quick action buttons: Deposit, Withdraw, Convert, Trade
- Real-time price updates every 3 seconds

**Talking Points:**
> "Notice the prices updating live—that's a WebSocket connection to Binance, not fake data."

> "The balance you see is stored in PostgreSQL with proper transaction integrity."

---

### Act 4: Execute a Trade (3 min)

**Navigate to:** `/trade` (Dashboard)

**Step 1: Review the Interface**
- Current BTC/USD price (from Binance)
- Buy/Sell toggle
- Quantity input
- Wallet balance display

**Step 2: Execute a Buy Order**
1. Select "BUY"
2. Enter quantity: `0.001` BTC
3. Click "Place Order"
4. Watch for toast notification

**What Happens Behind the Scenes:**
```
Client → Kong Gateway → Express API → RabbitMQ → Order Matcher → PostgreSQL
   ↓           ↓              ↓            ↓              ↓            ↓
 [Span]     [Span]         [Span]       [Span]        [Span]       [Span]
```

**Step 3: Note the Trace Link**
- Toast shows: "View trace in Jaeger →"
- This is the **Proof of Observability** moment

---

### Act 5: The Transparency Reveal (3 min)

**Option A: Click Trace Link in Toast**
Opens Jaeger directly to this trade's trace

**Option B: Open Jaeger Manually**
- Navigate to: `https://www.krystaline.io/jaeger/` (requires nginx basic auth)\r
- Service: `krystalinex` or `kong`
- Click "Find Traces"
- Select most recent trace

**What to Show in Jaeger:**

1. **Trace Overview**
   - See 10-17 spans in a waterfall
   - Total duration in milliseconds

2. **Span Breakdown**
   | Span | What It Shows |
   |------|---------------|
   | `POST /api/orders` | Initial request through Kong |
   | `kong.request` | API Gateway processing |
   | `pg.query` | Database operations |
   | `amqp.publish` | Message to RabbitMQ |
   | `order.process` | Order matching logic |
   | `wallet.update` | Balance changes |

3. **Drill Into a Span**
   - Click any span
   - Show attributes: `http.method`, `db.statement`, etc.
   - Show timing breakdown

**Talking Points:**
> "This is what no other exchange shows you. Every database query, every message, every service hop—fully traced."

> "If there was ever a dispute, regulators could audit exactly what happened to any transaction."

> "This is powered by OpenTelemetry, the CNCF standard—not proprietary tooling."

---

### Act 6: System Transparency (2 min)

**Navigate to:** `/transparency`

**What You'll See:**
- System status by component
- Service health indicators
- Response time percentiles
- Active anomaly count

**Talking Points:**
> "Users can see system health at any time—not a status page we manually update, but real-time data."

---

### Act 7: Advanced Monitoring (Optional, 2 min)

**Navigate to:** `/monitor`

**What You'll See:**
- Anomaly detection with severity levels (SEV1-5)
- Baseline calculations per operation
- LLM-powered "Analyze" button
- WebSocket streaming for real-time alerts

**Demo the LLM Analysis:**
1. Find any anomaly or slow trace
2. Click "Analyze"
3. Watch streaming analysis from Ollama
4. Show root cause suggestions

**Talking Points:**
> "Our system uses local LLMs to analyze anomalies in real-time—no data leaves our infrastructure."

> "This is the future of observability: AI-assisted diagnosis."

---

## Key Messages to Reinforce

### For Seed Stage
1. **Differentiation:** "First exchange with verifiable transaction transparency"
2. **Trust:** "Users can audit their own trades"
3. **Competence:** "Production-grade security from day one"

### For Series A
1. **Scale:** "OpenTelemetry is the CNCF standard—infinitely scalable"
2. **Compliance:** "Built-in audit trail for regulators"
3. **AI Advantage:** "LLM-powered operations before it's mainstream"

---

## Handling Common Questions

### "Is this real data?"
> "Yes. Prices come from Binance WebSocket. Trades go through a real order matching engine. PostgreSQL stores everything."

### "How many spans per transaction?"
> "Typically 15-20 spans covering: API Gateway, authentication, validation, database reads, message queue, order matching, balance updates."

### "What if there's an anomaly?"
> "Show `/monitor`. Our system detects slowdowns automatically, calculates severity, and can use LLMs to diagnose root causes."

### "Can users see their own traces?"
> "Yes—that's the whole point. Every confirmation includes a link to Jaeger. Full transparency."

---

## Known UI Issues (For Internal Reference)

These exist but shouldn't derail the demo:

| Issue | Location | Workaround |
|-------|----------|------------|
| Font size inconsistency | Landing page metrics | Keep moving, don't dwell |
| "0 Traces" on first load | Landing page | Execute a trade first |
| P50/P95/P99 all show zeros | Fresh install | Show after some trades |
| Conversion to portfolio routing | After login | Expected behavior |

---

## Demo Reset

To start fresh between demos:
```powershell
# Recalculate baselines for fresh metrics
curl -X POST https://www.krystaline.io/api/v1/monitor/recalculate

# Full cluster redeploy (if needed)
helm upgrade kx k8s/charts/krystalinex -f k8s/charts/krystalinex/values-local.yaml -f k8s/charts/krystalinex/values-secrets.yaml -n krystalinex
```

---

## Backup: If Things Go Wrong

### Kong Not Routing
```powershell
node scripts/enable-kong-otel.js
node scripts/enable-kong-cors.js
```

### No Prices Showing
- Check Binance WebSocket in server logs
- Fallback: prices will show as 0, explain connectivity

### Jaeger Empty
- Trades may take 5-10 seconds to appear
- Refresh Jaeger, extend time range

### RabbitMQ Not Connected
- Orders still work (synchronous fallback)
- Explain: "Graceful degradation"

---

*This walkthrough demonstrates real functionality, not mockups. Practice the flow before investor meetings.*  
*Environment: Kubernetes cluster at `www.krystaline.io` — Helm revision 72+ — Updated March 2026*
