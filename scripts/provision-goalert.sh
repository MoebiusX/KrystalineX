#!/bin/bash
# GoAlert Provisioning Script
# Idempotently provisions GoAlert with:
#   - Admin user + basic auth
#   - Carlos user (on-call engineer)
#   - KrystalineX service with escalation policy
#   - Alertmanager integration keys (general, critical, security)
#   - Twilio SMS config (if credentials provided)
#
# Usage:
#   Local:  ./scripts/provision-goalert.sh --local
#   K8s:    GOALERT_EXEC="kubectl exec deploy/kx-krystalinex-goalert -n krystalinex -- goalert" \
#           GOALERT_URL="http://..." ./scripts/provision-goalert.sh
#   Custom: GOALERT_EXEC="goalert" GOALERT_URL=http://host:8081 ./scripts/provision-goalert.sh
#
# Environment variables:
#   GOALERT_URL              - GoAlert HTTP base URL (default: http://localhost:8081)
#   GOALERT_EXEC             - Command prefix for GoAlert CLI (default: "docker exec krystalinex-goalert-1 goalert")
#   GOALERT_ADMIN_PASS       - Admin password (default: KrystalineX2026!)
#   GOALERT_CARLOS_PASS      - Carlos password (default: KrystalineX2026!)
#   TWILIO_ACCOUNT_SID       - Twilio Account SID (optional)
#   TWILIO_AUTH_TOKEN         - Twilio Auth Token (optional)
#   TWILIO_FROM_NUMBER        - Twilio phone number (optional)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
GOALERT_URL="${GOALERT_URL:-http://localhost:8081}"
GOALERT_ADMIN_PASS="${GOALERT_ADMIN_PASS:-KrystalineX2026!}"
GOALERT_CARLOS_PASS="${GOALERT_CARLOS_PASS:-KrystalineX2026!}"
GOALERT_EXEC="${GOALERT_EXEC:-docker exec krystalinex-goalert-1 goalert}"

# Handle --local shortcut
MODE="${1:-}"
if [ "$MODE" = "--local" ]; then
  GOALERT_URL="http://localhost:8081"
  GOALERT_EXEC="docker exec krystalinex-goalert-1 goalert"
fi

# Detect working python command (Windows python3 stub may be a fake alias)
PYTHON=""
for cmd in python3 python; do
  if $cmd -c "print('ok')" &>/dev/null; then
    PYTHON="$cmd"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "ERROR: python not found in PATH"
  exit 1
fi

# ── Helpers ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }

COOKIE_JAR=$(mktemp)
trap "rm -f $COOKIE_JAR" EXIT

goalert_cli() {
  # Runs GoAlert CLI commands inside the container (env vars provide DB_URL + encryption key)
  $GOALERT_EXEC "$@" 2>&1
}

gql() {
  local query="$1"
  local cookie=$(cat "$COOKIE_JAR")
  curl -sf -H "Cookie: $cookie" "${GOALERT_URL}/api/graphql" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"$query\"}" 2>&1 || { err "GraphQL request failed"; return 1; }
}

jq_py() {
  # Lightweight JSON extraction using python (no jq dependency)
  $PYTHON -c "import sys,json; d=json.load(sys.stdin); $1" 2>/dev/null
}

# ── Phase 1: CLI Provisioning (direct DB access) ──────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  GoAlert Provisioning"
echo "═══════════════════════════════════════════════════════════"
echo ""

info "Phase 1: CLI provisioning (admin user + config)"

# Create admin user (CLI talks directly to DB via env vars inside container)
if goalert_cli add-user --admin --user admin --pass "$GOALERT_ADMIN_PASS" 2>&1 | grep -q "added"; then
  log "Admin user created"
else
  warn "Admin user already exists (skipped)"
fi

# Enable basic auth + webhooks (idempotent)
CONFIG_JSON='{"Auth.BasicEnable": true, "Webhook.Enable": true}'
if goalert_cli set-config --data "$CONFIG_JSON" 2>&1 | grep -q "Saved"; then
  log "Config set: basic auth + webhooks enabled"
else
  warn "Config may already be set"
fi

# ── Phase 2: Wait for GoAlert API ─────────────────────────────
info "Phase 2: Waiting for GoAlert API at ${GOALERT_URL}..."

for i in $(seq 1 30); do
  if curl -sf "${GOALERT_URL}/health" > /dev/null 2>&1; then
    log "GoAlert API is healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "GoAlert API not reachable after 30 attempts"
    exit 1
  fi
  sleep 2
done

# ── Phase 3: Authenticate ─────────────────────────────────────
info "Phase 3: Authenticating as admin..."

# Extract session cookie from response headers (works even with Secure cookies over HTTP)
AUTH_HEADERS=$(curl -sD - -o /dev/null \
  -X POST "${GOALERT_URL}/api/v2/identity/providers/basic" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Referer: ${GOALERT_REFERER:-${GOALERT_URL}}" \
  -d "username=admin&password=${GOALERT_ADMIN_PASS}" 2>&1)

LOGIN_STATUS=$(echo "$AUTH_HEADERS" | head -1 | sed -n 's/.*\([0-9][0-9][0-9]\).*/\1/p')
SESSION_COOKIE=$(echo "$AUTH_HEADERS" | grep -o 'goalert_session[^;]*' | head -1)

if ([ "$LOGIN_STATUS" = "200" ] || [ "$LOGIN_STATUS" = "302" ]) && [ -n "$SESSION_COOKIE" ]; then
  log "Authenticated as admin"
  # Store cookie for gql() function
  echo "$SESSION_COOKIE" > "$COOKIE_JAR"
else
  err "Authentication failed (HTTP $LOGIN_STATUS)"
  exit 1
fi

# ── Phase 4: Create carlos user ───────────────────────────────
info "Phase 4: Provisioning users..."

# Query existing users (User type has: id, name, email, role — no 'username' field)
USERS_JSON=$(gql "{ users { nodes { id name email role } } }")

CARLOS_ID=$(echo "$USERS_JSON" | jq_py "
users = d.get('data',{}).get('users',{}).get('nodes',[])
carlos = [u for u in users if u.get('name') == 'Carlos']
print(carlos[0]['id'] if carlos else 'NONE')
")

if [ "$CARLOS_ID" = "NONE" ]; then
  CARLOS_RESULT=$(gql "mutation { createUser(input: { username: \\\"carlos\\\", password: \\\"${GOALERT_CARLOS_PASS}\\\", name: \\\"Carlos\\\", email: \\\"carlos@krystaline.io\\\", role: admin }) { id name } }")
  CARLOS_ID=$(echo "$CARLOS_RESULT" | jq_py "print(d['data']['createUser']['id'])" || echo "")
  if [ -n "$CARLOS_ID" ]; then
    log "User 'carlos' created (ID: $CARLOS_ID)"
  else
    err "Failed to create carlos user"
    echo "$CARLOS_RESULT"
  fi
else
  log "User 'carlos' already exists (ID: $CARLOS_ID)"
fi

# Get admin user ID
ADMIN_ID=$(echo "$USERS_JSON" | jq_py "
users = d.get('data',{}).get('users',{}).get('nodes',[])
admin = [u for u in users if u.get('name') == 'admin']
print(admin[0]['id'] if admin else 'NONE')
")
log "Admin user ID: $ADMIN_ID"

# ── Phase 5: Create KrystalineX service ───────────────────────
info "Phase 5: Provisioning KrystalineX service..."

# Check if service already exists
SVC_CHECK=$(gql "{ services { nodes { id name } } }" | jq_py "
svcs = d.get('data',{}).get('services',{}).get('nodes',[])
kx = [s for s in svcs if s.get('name') == 'KrystalineX']
print(kx[0]['id'] if kx else 'NONE')
")

if [ "$SVC_CHECK" = "NONE" ]; then
  # Build escalation targets — include both admin and carlos
  TARGETS="[{id: \\\"${ADMIN_ID}\\\", type: user}"
  if [ "$CARLOS_ID" != "NONE" ] && [ -n "$CARLOS_ID" ]; then
    TARGETS="${TARGETS}, {id: \\\"${CARLOS_ID}\\\", type: user}"
  fi
  TARGETS="${TARGETS}]"

  SVC_RESULT=$(gql "mutation { createService(input: { name: \\\"KrystalineX\\\", description: \\\"KrystalineX Crypto Exchange - Observability Alerts\\\", newEscalationPolicy: { name: \\\"KrystalineX On-Call\\\", description: \\\"Primary escalation for KrystalineX alerts\\\", repeat: 3, steps: [{ delayMinutes: 5, targets: ${TARGETS} }] }, newIntegrationKeys: [{ type: prometheusAlertmanager, name: \\\"Alertmanager - General\\\" }, { type: prometheusAlertmanager, name: \\\"Alertmanager - Critical\\\" }, { type: generic, name: \\\"Alertmanager - Security\\\" }] }) { id name integrationKeys { id name type } escalationPolicy { id name } } }")

  SVC_ID=$(echo "$SVC_RESULT" | jq_py "print(d['data']['createService']['id'])" || echo "")
  if [ -n "$SVC_ID" ]; then
    log "Service 'KrystalineX' created (ID: $SVC_ID)"
    echo "$SVC_RESULT" | jq_py "
svc = d['data']['createService']
print()
print('  Integration Keys:')
for ik in svc.get('integrationKeys', []):
    print(f\"    {ik['name']:30s}  {ik['id']}\")
print(f\"  Escalation Policy: {svc['escalationPolicy']['name']} ({svc['escalationPolicy']['id']})\")
"
  else
    err "Failed to create service"
    echo "$SVC_RESULT" | $PYTHON -m json.tool 2>/dev/null || echo "$SVC_RESULT"
  fi
else
  SVC_ID="$SVC_CHECK"
  log "Service 'KrystalineX' already exists (ID: $SVC_ID)"
  gql "{ service(id: \\\"${SVC_ID}\\\") { integrationKeys { id name type } } }" | jq_py "
svc = d['data']['service']
print('  Integration Keys:')
for ik in svc.get('integrationKeys', []):
    print(f\"    {ik['name']:30s}  {ik['id']}\")
"
fi

# ── Phase 6: Twilio config (optional) ─────────────────────────
if [ -n "${TWILIO_ACCOUNT_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ]; then
  info "Phase 6: Configuring Twilio SMS..."
  TWILIO_CONFIG="{\"Twilio.Enable\": true, \"Twilio.AccountSID\": \"${TWILIO_ACCOUNT_SID}\", \"Twilio.AuthToken\": \"${TWILIO_AUTH_TOKEN}\""
  [ -n "${TWILIO_FROM_NUMBER:-}" ] && TWILIO_CONFIG="${TWILIO_CONFIG}, \"Twilio.FromNumber\": \"${TWILIO_FROM_NUMBER}\""
  TWILIO_CONFIG="${TWILIO_CONFIG}}"

  if goalert_cli set-config --data "$TWILIO_CONFIG" 2>&1 | grep -q "Saved"; then
    log "Twilio SMS configured"
  else
    warn "Twilio config may have failed (check manually)"
  fi
else
  info "Phase 6: Twilio not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)"
fi

# ── Phase 7: Print Alertmanager webhook URLs ──────────────────
echo ""
info "Phase 7: Alertmanager webhook configuration"

if [ -n "$SVC_ID" ]; then
  gql "{ service(id: \\\"${SVC_ID}\\\") { integrationKeys { id name type } } }" | jq_py "
svc = d['data']['service']
print()
print('  Alertmanager receiver URLs:')
print('  ' + '─' * 55)
for ik in svc.get('integrationKeys', []):
    ep = 'prometheusalertmanager' if ik['type'] == 'prometheusAlertmanager' else 'generic'
    print(f\"  {ik['name']}:\")
    print(f\"    http://GOALERT_HOST:8081/api/v2/{ep}/incoming?token={ik['id']}\")
    print()
"
fi

# ── Summary ───────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════"
echo -e "  ${GREEN}GoAlert provisioning complete!${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Admin login:  admin / [configured]"
echo "  Carlos login: carlos / [configured]"
echo "  GoAlert URL:  ${GOALERT_URL}"
echo ""
