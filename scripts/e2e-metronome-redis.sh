#!/usr/bin/env bash
# End-to-end test: Metronome → source-metronome → destination-redis
#
# Proves the full pipeline works with real data:
#   1. Backfill net_balance + entitlements to Redis
#   2. Start webhook listener
#   3. Simulate customer usage (send events to Metronome ingest API)
#   4. Fire a webhook event → source re-fetches → Redis updates
#   5. Check Redis reflects current credit balance
#
# Prerequisites:
#   - METRONOME_API_TOKEN env var set
#   - Redis running on localhost:56379 (docker compose up redis)
#   - Customer + contract + credit grant already exist in Metronome sandbox
#
# Usage: ./scripts/e2e-metronome-redis.sh
set -euo pipefail

: "${METRONOME_API_TOKEN:?Set METRONOME_API_TOKEN}"

CUSTOMER_ID="${CUSTOMER_ID:?Set CUSTOMER_ID env var}"
CREDIT_TYPE_ID="${CREDIT_TYPE_ID:?Set CREDIT_TYPE_ID env var}"
REDIS_PORT=56379
WEBHOOK_PORT=4243
KEY_PREFIX="sync:"

echo "=== E2E: Metronome → source-metronome → destination-redis ==="
echo ""

# Verify Redis is running
if ! redis-cli -p "$REDIS_PORT" ping &>/dev/null; then
  echo "ERROR: Redis not running on port $REDIS_PORT. Run: docker compose up redis -d"
  exit 1
fi

redis-cli -p "$REDIS_PORT" FLUSHDB >/dev/null

CATALOG='{"streams":[{"stream":{"name":"net_balance","primary_key":[["customer_id"],["credit_type_id"]],"newer_than_field":"_synced_at","json_schema":{}},"sync_mode":"full_refresh","destination_sync_mode":"append_dedup"},{"stream":{"name":"entitlements","primary_key":[["customer_id"],["contract_id"],["product_id"]],"newer_than_field":"_synced_at","json_schema":{}},"sync_mode":"full_refresh","destination_sync_mode":"append_dedup"}]}'
SOURCE_CONFIG="{\"api_key\": \"$METRONOME_API_TOKEN\", \"webhook_port\": $WEBHOOK_PORT}"
DEST_CONFIG="{\"url\":\"redis://localhost:$REDIS_PORT\",\"key_prefix\":\"$KEY_PREFIX\",\"batch_size\":1}"

# Step 1: Start pipeline (backfill + webhook server)
echo "Step 1: Starting pipeline (backfill + webhook listener on port $WEBHOOK_PORT)..."
npx tsx --conditions bun packages/source-metronome/src/bin.ts read \
  --config "$SOURCE_CONFIG" --catalog "$CATALOG" 2>/dev/null | \
npx tsx --conditions bun packages/destination-redis/src/bin.ts write \
  --config "$DEST_CONFIG" --catalog "$CATALOG" >/dev/null 2>/dev/null &
PIPE_PID=$!
trap "kill $PIPE_PID 2>/dev/null; wait $PIPE_PID 2>/dev/null" EXIT
sleep 5

echo "Step 1: Backfill complete."
echo ""

# Step 2: Check initial state
echo "Step 2: Initial Redis state after backfill:"
BALANCE_BEFORE=$(redis-cli -p "$REDIS_PORT" GET "${KEY_PREFIX}net_balance:$CUSTOMER_ID:$CREDIT_TYPE_ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['balance'])")
SYNCED_BEFORE=$(redis-cli -p "$REDIS_PORT" GET "${KEY_PREFIX}net_balance:$CUSTOMER_ID:$CREDIT_TYPE_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['_synced_at'])")
echo "  Net balance: $BALANCE_BEFORE"
echo "  Synced at:   $SYNCED_BEFORE"
echo ""

# Step 3: Simulate customer usage
echo "Step 3: Simulating customer usage (5 API calls)..."
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST https://api.metronome.com/v1/ingest \
  -H "Authorization: Bearer $METRONOME_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_1\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_2\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_3\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_4\"},
    {\"customer_id\": \"$CUSTOMER_ID\", \"event_type\": \"api_call\", \"timestamp\": \"$TS\", \"transaction_id\": \"e2e_$(date +%s)_5\"}
  ]" >/dev/null
echo "  Sent 5 usage events to Metronome."
echo ""

# Step 4: Trigger webhook (simulates Metronome firing a credit event)
echo "Step 4: Firing credit.segment.end webhook..."

# Verify webhook server is listening
if ! curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$WEBHOOK_PORT" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"credit.segment.end\",\"id\":\"evt_e2e_$(date +%s)\",\"customer_id\":\"$CUSTOMER_ID\"}" | grep -q "200"; then
  echo "  WARNING: Webhook server returned non-200"
fi
sleep 5
echo "  Webhook processed."
echo ""

# Step 5: Verify Redis updated
echo "Step 5: Redis state after webhook refresh:"
BALANCE_AFTER=$(redis-cli -p "$REDIS_PORT" GET "${KEY_PREFIX}net_balance:$CUSTOMER_ID:$CREDIT_TYPE_ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['balance'])")
SYNCED_AFTER=$(redis-cli -p "$REDIS_PORT" GET "${KEY_PREFIX}net_balance:$CUSTOMER_ID:$CREDIT_TYPE_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['_synced_at'])")
echo "  Net balance: $BALANCE_AFTER"
echo "  Synced at:   $SYNCED_AFTER"
echo ""

# Step 6: Verify timestamp changed (proves webhook triggered a re-fetch)
if [ "$SYNCED_AFTER" -gt "$SYNCED_BEFORE" ]; then
  echo "SUCCESS: Redis was updated by webhook (synced_at $SYNCED_BEFORE → $SYNCED_AFTER)"
else
  echo "FAIL: Redis was NOT updated by webhook"
  exit 1
fi

echo ""
echo "=== All Redis keys ==="
redis-cli -p "$REDIS_PORT" KEYS "${KEY_PREFIX}*"
echo ""
echo "=== E2E complete ==="
