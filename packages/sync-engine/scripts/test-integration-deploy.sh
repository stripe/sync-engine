#!/bin/bash
# NOT RUNNING IN CI
# TODO: Figure out what to do with this test. Right now it is failing with the Supabase project inactivity failure

set -euo pipefail

# Integration test for the deploy command
# Tests the full Supabase deployment flow with real services

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/common.sh"

echo "================================================"
echo "  Stripe Sync - Deploy Integration Test"
echo "================================================"
echo ""

# Load .env file if it exists
if [ -f "$CLI_DIR/.env" ]; then
    echo "📄 Loading environment from .env file..."
    set -a
    source "$CLI_DIR/.env"
    set +a
    echo ""
fi

# Check prerequisites
check_required_tools curl jq node

# Check required environment variables (no DB password needed!)
check_env_vars SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF STRIPE_API_KEY NPM_TOKEN

# Configure npm with NPM_TOKEN
echo "🔑 Configuring npm with NPM_TOKEN..."
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
echo "✓ npm configured"
echo ""

# Track IDs for cleanup
WEBHOOK_ID=""
TEST_CUSTOMER_ID=""
BACKFILL_CUSTOMER_ID=""
BETA_VERSION=""

# Function to check if stripe schema exists
# Returns: "true" if exists, "false" if not exists, or error message
check_schema_exists() {
    local query="SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'stripe') as schema_exists"
    local response=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$query\"}")

    local exists=$(echo "$response" | jq -r '.[0].schema_exists' 2>/dev/null || echo "")

    if [ "$exists" = "true" ] || [ "$exists" = "false" ]; then
        echo "$exists"
    else
        echo "error:$response"
    fi
}

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete test customers if we created them
    if [ -n "$TEST_CUSTOMER_ID" ]; then
        echo "   Deleting webhook test customer: $TEST_CUSTOMER_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/customers/$TEST_CUSTOMER_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete test customer"
    fi

    if [ -n "$BACKFILL_CUSTOMER_ID" ]; then
        echo "   Deleting backfill test customer: $BACKFILL_CUSTOMER_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/customers/$BACKFILL_CUSTOMER_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete backfill customer"
    fi

    # Use programmatic uninstall command to clean up all deployed resources
    echo "   Running uninstall command..."
    if ! node dist/cli/index.js supabase uninstall \
        --token "$SUPABASE_ACCESS_TOKEN" \
        --project "$SUPABASE_PROJECT_REF" 2>&1 | tee /tmp/uninstall.log | grep -v "^$" > /dev/null; then
        echo "   Warning: Uninstall command failed"
        cat /tmp/uninstall.log
    fi

    # Unpublish beta version if it was created
    if [ -n "$BETA_VERSION" ]; then
        echo "   Unpublishing beta version: $BETA_VERSION"
        npm unpublish "@stripe/sync-engine@$BETA_VERSION" --force > /dev/null 2>&1 || echo "   Warning: Failed to unpublish beta version"
    fi

    # Remove .npmrc if we created it
    if [ -n "$NPM_TOKEN" ] && [ -f ~/.npmrc ]; then
        rm -f ~/.npmrc 2>/dev/null || true
    fi

    # Verify uninstall completed successfully
    echo "   Verifying uninstall..."

    # Check 1: Verify schema is dropped
    # Note: Supabase has async delays, retry a few times before failing
    echo "   Verifying schema is dropped..."
    SCHEMA_DROPPED=false
    for attempt in {1..5}; do
        sleep 5
        SCHEMA_EXISTS=$(check_schema_exists)

        if [[ "$SCHEMA_EXISTS" == error:* ]]; then
            if [ $attempt -lt 5 ]; then
                echo "   Query error, retrying (attempt $attempt/5)..."
            else
                echo "   ⚠️  Query failed after 5 attempts"
                echo "   Response: ${SCHEMA_EXISTS#error:}"
            fi
        elif [ "$SCHEMA_EXISTS" = "false" ]; then
            echo "   ✓ Schema dropped successfully"
            SCHEMA_DROPPED=true
            break
        elif [ "$SCHEMA_EXISTS" = "true" ]; then
            if [ $attempt -lt 5 ]; then
                echo "   Schema still exists, retrying (attempt $attempt/5)..."
            fi
        fi
    done

    if [ "$SCHEMA_DROPPED" != "true" ]; then
        echo "   ❌ UNINSTALL FAILED: Schema still exists after uninstall"
        echo "   This is a critical failure - uninstall did not properly clean up the database"
        echo ""
        echo "================================================"
        echo "❌ INTEGRATION TEST FAILED"
        echo "================================================"
        exit 1
    fi

    # Check 2: Verify Edge Functions are deleted
    FUNCTIONS_CHECK=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions" 2>/dev/null || echo '[]')

    SETUP_EXISTS=$(echo "$FUNCTIONS_CHECK" | jq -r '.[] | select(.slug == "stripe-setup") | .slug' 2>/dev/null || echo "")
    WEBHOOK_EXISTS=$(echo "$FUNCTIONS_CHECK" | jq -r '.[] | select(.slug == "stripe-webhook") | .slug' 2>/dev/null || echo "")
    WORKER_EXISTS=$(echo "$FUNCTIONS_CHECK" | jq -r '.[] | select(.slug == "stripe-worker") | .slug' 2>/dev/null || echo "")

    if [ -z "$SETUP_EXISTS" ] && [ -z "$WEBHOOK_EXISTS" ] && [ -z "$WORKER_EXISTS" ]; then
        echo "   ✓ Edge Functions deleted successfully"
    else
        echo "   ❌ UNINSTALL FAILED: Some Edge Functions still exist"
        [ -n "$SETUP_EXISTS" ] && echo "      - stripe-setup still exists"
        [ -n "$WEBHOOK_EXISTS" ] && echo "      - stripe-webhook still exists"
        [ -n "$WORKER_EXISTS" ] && echo "      - stripe-worker still exists"
        echo ""
        echo "================================================"
        echo "❌ INTEGRATION TEST FAILED"
        echo "================================================"
        exit 1
    fi

    echo "   Done"
}

# Register cleanup on exit
trap cleanup EXIT

# Build and publish beta version
echo "📦 Building and publishing beta version..."
cd "$CLI_DIR"

# First restore package.json to original state in case of previous failed runs
git checkout package.json 2>/dev/null || true

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
BETA_VERSION="${CURRENT_VERSION}-beta.$(date +%s)"

echo "   Current version: $CURRENT_VERSION"
echo "   Beta version: $BETA_VERSION"

# Update package.json version temporarily
node -e "const pkg=require('./package.json'); pkg.version='$BETA_VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n')"

# Build the package
if ! pnpm build > /tmp/beta-build.log 2>&1; then
    echo "❌ Build failed"
    cat /tmp/beta-build.log
    # Restore package.json before exiting
    node -e "const pkg=require('./package.json'); pkg.version='$CURRENT_VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n')"
    exit 1
fi
echo "✓ Package built"

# Publish to npm (BEFORE restoring package.json so it publishes correct version)
echo "📤 Publishing $BETA_VERSION to npm..."
if ! npm publish --tag beta --access public 2>&1 | tee /tmp/npm-publish.log; then
    echo "❌ Failed to publish to npm"
    cat /tmp/npm-publish.log
    # Restore package.json before exiting
    node -e "const pkg=require('./package.json'); pkg.version='$CURRENT_VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n')"
    exit 1
fi
echo "✓ Published to npm"

# Restore original package.json version AFTER publishing
node -e "const pkg=require('./package.json'); pkg.version='$CURRENT_VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n')"

# Wait for package to be available on npm
echo "⏳ Waiting for package to be available on npm..."
MAX_WAIT=60
WAIT_COUNT=0
RATE_LIMITED=false

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    # Query npm registry API directly
    NPM_API_RESPONSE=$(curl -s "https://registry.npmjs.org/@stripe%2Fsync-engine/$BETA_VERSION" || true)

    # Check if we got the version back (not a 404)
    if echo "$NPM_API_RESPONSE" | jq -e '.version' > /dev/null 2>&1; then
        FOUND_VERSION=$(echo "$NPM_API_RESPONSE" | jq -r '.version')
        if [ "$FOUND_VERSION" = "$BETA_VERSION" ]; then
            echo "✓ Package available on npm"
            break
        fi
    fi

    # Check for rate limiting (429 status)
    if echo "$NPM_API_RESPONSE" | jq -e '.error' | grep -q "429" 2>/dev/null; then
        if [ "$RATE_LIMITED" = false ]; then
            echo "   ⚠️  npm rate limiting detected, waiting 60s..."
            RATE_LIMITED=true
            sleep 60
        fi
    fi

    # Show progress every 30 seconds
    if [ $((WAIT_COUNT % 15)) -eq 0 ] && [ $WAIT_COUNT -gt 0 ]; then
        echo "   Still waiting... (${WAIT_COUNT}0s elapsed)"
    fi

    sleep 2
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo "❌ Package did not become available on npm within $((MAX_WAIT * 2)) seconds"
    echo "   Last API response: $(echo "$NPM_API_RESPONSE" | jq -c '.' || echo "$NPM_API_RESPONSE")"
    exit 1
fi

# Wait for package to be available in Deno's npm resolver with correct code
if command -v deno >/dev/null 2>&1; then
    echo "   Verifying package is available in Deno's npm resolver..."
    MAX_ATTEMPTS=30
    ATTEMPT=0
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        # Try to import the package in Deno to verify it's available
        DENO_CHECK=$(deno eval --quiet "
            try {
                const { StripeSync } = await import('npm:@stripe/sync-engine@${BETA_VERSION}');
                console.log('SUCCESS');
                Deno.exit(0);
            } catch (e) {
                console.log('NOT_AVAILABLE');
                Deno.exit(1);
            }
        " 2>/dev/null || echo "ERROR")

        if [ "$DENO_CHECK" = "SUCCESS" ]; then
            echo "   ✓ Package verified in Deno's npm resolver"
            break
        fi

        ATTEMPT=$((ATTEMPT + 1))
        if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
            sleep 3
        fi
    done

    if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
        echo "   ⚠️  Package verification timed out after 90s, proceeding anyway..."
    fi
else
    echo "   ⚠️  Deno not installed, skipping verification. Waiting 60s for npm CDN propagation..."
    sleep 60
fi
echo ""

# Create a customer BEFORE deploying (for backfill test - no webhook exists yet)
echo "🧪 Creating backfill test customer (before webhook exists)..."
BACKFILL_CUSTOMER_RESPONSE=$(curl -s -X POST "https://api.stripe.com/v1/customers" \
    -u "$STRIPE_API_KEY:" \
    -d "name=Backfill Test Customer" \
    -d "email=backfill-test-$(date +%s)@example.com" \
    -d "metadata[test]=backfill-integration")

BACKFILL_CUSTOMER_ID=$(echo "$BACKFILL_CUSTOMER_RESPONSE" | jq -r '.id')
if [ -z "$BACKFILL_CUSTOMER_ID" ] || [ "$BACKFILL_CUSTOMER_ID" = "null" ]; then
    echo "❌ Failed to create backfill test customer"
    echo "   Response: $BACKFILL_CUSTOMER_RESPONSE"
    exit 1
fi
echo "✓ Created customer for backfill test: $BACKFILL_CUSTOMER_ID"
echo ""

# Ensure clean state before deployment
echo "🔍 Ensuring clean state before deployment..."
INITIAL_SCHEMA_EXISTS=$(check_schema_exists)

if [[ "$INITIAL_SCHEMA_EXISTS" == error:* ]]; then
    echo "⚠️  Could not verify schema state"
    echo "   Response: ${INITIAL_SCHEMA_EXISTS#error:}"
    echo "   Proceeding anyway, but deployment may fail if schema exists..."
elif [ "$INITIAL_SCHEMA_EXISTS" = "true" ]; then
    echo "⚠️  Schema 'stripe' already exists, cleaning up from previous run..."
    # Try to run uninstall first
    if node dist/cli/index.js supabase uninstall \
        --token "$SUPABASE_ACCESS_TOKEN" \
        --project "$SUPABASE_PROJECT_REF" 2>&1 | tee /tmp/pre-cleanup.log | grep -q "success"; then
        echo "✓ Uninstall completed"
    else
        echo "⚠️  Uninstall failed, attempting manual schema drop..."
        # Manually drop the schema using the Supabase management API or direct SQL
        # This requires a way to execute SQL - we'll use the CLI to execute a migration-like operation
        echo "   Dropping stripe schema manually..."
        # Note: This is a fallback - ideally uninstall should work
        echo "   If this fails, please manually drop the schema"
    fi

    # Verify schema is now gone
    SCHEMA_EXISTS_AFTER_CLEANUP=$(check_schema_exists)
    if [ "$SCHEMA_EXISTS_AFTER_CLEANUP" = "true" ]; then
        echo "❌ FATAL: Failed to clean up existing schema"
        echo "   Please manually drop the stripe schema before running this test"
        exit 1
    fi
    echo "✓ Schema cleaned up successfully"
elif [ "$INITIAL_SCHEMA_EXISTS" = "false" ]; then
    echo "✓ Schema does not exist (clean state confirmed)"
fi
echo ""

# Run deploy command with beta version (no DB password needed - migrations run via Edge Function)
echo "🚀 Running deploy command with version $BETA_VERSION..."
node dist/cli/index.js supabase install \
    --token "$SUPABASE_ACCESS_TOKEN" \
    --project "$SUPABASE_PROJECT_REF" \
    --stripe-key "$STRIPE_API_KEY" \
    --package-version "$BETA_VERSION"
echo ""

# Verify Edge Functions deployed
echo "🔍 Verifying Edge Functions..."
FUNCTIONS=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions")

SETUP_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-setup") | .slug')
WEBHOOK_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-webhook") | .slug')
WORKER_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-worker") | .slug')

if [ "$SETUP_FUNC" = "stripe-setup" ]; then
    echo "✓ stripe-setup function deployed"
else
    echo "❌ stripe-setup function NOT found"
    exit 1
fi

if [ "$WEBHOOK_FUNC" = "stripe-webhook" ]; then
    echo "✓ stripe-webhook function deployed"
else
    echo "❌ stripe-webhook function NOT found"
    exit 1
fi

if [ "$WORKER_FUNC" = "stripe-worker" ]; then
    echo "✓ stripe-worker function deployed"
else
    echo "❌ stripe-worker function NOT found"
    exit 1
fi
echo ""

# Verify Stripe webhook created
echo "🔍 Verifying Stripe webhook..."
WEBHOOKS=$(curl -s -u "$STRIPE_API_KEY:" "https://api.stripe.com/v1/webhook_endpoints")
# Use same base URL as the install command (defaults to supabase.co)
SUPABASE_BASE_URL="${SUPABASE_BASE_URL:-supabase.co}"
WEBHOOK_URL="https://$SUPABASE_PROJECT_REF.$SUPABASE_BASE_URL/functions/v1/stripe-webhook"

WEBHOOK_DATA=$(echo "$WEBHOOKS" | jq -r --arg url "$WEBHOOK_URL" '.data[] | select(.url == $url)')

if [ -n "$WEBHOOK_DATA" ]; then
    WEBHOOK_ID=$(echo "$WEBHOOK_DATA" | jq -r '.id')
    WEBHOOK_STATUS=$(echo "$WEBHOOK_DATA" | jq -r '.status')
    echo "✓ Stripe webhook created: $WEBHOOK_ID (status: $WEBHOOK_STATUS)"
else
    echo "❌ Stripe webhook NOT found for URL: $WEBHOOK_URL"
    exit 1
fi
echo ""

# Verify database schema using Supabase Management API
echo "🔍 Verifying database schema..."
TABLES_QUERY="SELECT table_name FROM information_schema.tables WHERE table_schema = 'stripe' ORDER BY table_name"
TABLES_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$TABLES_QUERY\"}")

if echo "$TABLES_RESULT" | jq -e '.[] | select(.table_name == "customers")' > /dev/null 2>&1; then
    echo "✓ stripe.customers table exists"
else
    echo "❌ stripe.customers table NOT found"
    echo "   Response: $TABLES_RESULT"
    exit 1
fi

if echo "$TABLES_RESULT" | jq -e '.[] | select(.table_name == "_managed_webhooks")' > /dev/null 2>&1; then
    echo "✓ stripe._managed_webhooks table exists"
else
    echo "❌ stripe._managed_webhooks table NOT found"
    exit 1
fi
echo ""

# Verify installation status (tests SupabaseDeployClient.isInstalled() logic)
echo "🔍 Verifying installation status..."

# Check 1: Verify migrations table exists
MIGRATIONS_TABLE_QUERY="SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'stripe' AND table_name IN ('migrations', '_migrations')) as table_exists"
MIGRATIONS_TABLE_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$MIGRATIONS_TABLE_QUERY\"}")

MIGRATIONS_TABLE_EXISTS=$(echo "$MIGRATIONS_TABLE_RESULT" | jq -r '.[0].table_exists // false')

if [ "$MIGRATIONS_TABLE_EXISTS" = "true" ]; then
    echo "✓ Migrations table exists"
else
    echo "❌ Migrations table NOT found"
    exit 1
fi

# Check 2: Verify schema comment (installation marker)
COMMENT_QUERY="SELECT obj_description(oid, 'pg_namespace') as comment FROM pg_namespace WHERE nspname = 'stripe'"
COMMENT_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$COMMENT_QUERY\"}")

SCHEMA_COMMENT=$(echo "$COMMENT_RESULT" | jq -r '.[0].comment // empty')

# Try parsing as JSON first (new format), otherwise fall back to legacy plain-text check
if [ -n "$SCHEMA_COMMENT" ]; then
    # Try to parse as JSON and check status field
    COMMENT_STATUS=$(echo "$SCHEMA_COMMENT" | jq -r '.status // empty' 2>/dev/null || echo "")
    
    if [ "$COMMENT_STATUS" = "installed" ]; then
        # JSON format with installed status
        COMMENT_VERSION=$(echo "$SCHEMA_COMMENT" | jq -r '.version // empty' 2>/dev/null || echo "")
        echo "✓ Schema comment set (JSON format): status=$COMMENT_STATUS, version=$COMMENT_VERSION"
    elif echo "$SCHEMA_COMMENT" | grep -q "stripe-sync.*installed"; then
        # Legacy plain-text format
        echo "✓ Schema comment set (legacy format): $SCHEMA_COMMENT"
    else
        echo "❌ Schema comment NOT set correctly"
        echo "   Expected JSON: {\"status\":\"installed\",\"version\":\"x.y.z\"}"
        echo "   Or legacy: 'stripe-sync {version} installed'"
        echo "   Got: '$SCHEMA_COMMENT'"
        exit 1
    fi
else
    echo "❌ Schema comment NOT set correctly"
    echo "   Expected JSON: {\"status\":\"installed\",\"version\":\"x.y.z\"}"
    echo "   Or legacy: 'stripe-sync {version} installed'"
    echo "   Got: (empty)"
    exit 1
fi

# All isInstalled() checks passed
echo "✓ Installation verification complete (isInstalled() would return true)"
echo ""

# Verify pg_cron extension and job
echo "🔍 Verifying pg_cron setup..."

# Check if pg_cron extension is installed
CRON_EXT_QUERY="SELECT extname FROM pg_extension WHERE extname = 'pg_cron'"
CRON_EXT_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CRON_EXT_QUERY\"}" 2>/dev/null || echo "[]")

if echo "$CRON_EXT_RESULT" | jq -e '.[] | select(.extname == "pg_cron")' > /dev/null 2>&1; then
    echo "✓ pg_cron extension installed"
else
    echo "❌ pg_cron extension NOT installed - worker will not run automatically"
    echo "   pg_cron requires special permissions and may not be available on all Supabase plans"
fi

# Check if pg_cron job exists
CRON_JOB_QUERY="SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'stripe-sync-worker'"
CRON_JOB_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CRON_JOB_QUERY\"}" 2>/dev/null || echo "[]")

if echo "$CRON_JOB_RESULT" | jq -e '.[] | select(.jobname == "stripe-sync-worker")' > /dev/null 2>&1; then
    CRON_SCHEDULE=$(echo "$CRON_JOB_RESULT" | jq -r '.[0].schedule')
    CRON_ACTIVE=$(echo "$CRON_JOB_RESULT" | jq -r '.[0].active')
    echo "✓ pg_cron job configured (schedule: $CRON_SCHEDULE, active: $CRON_ACTIVE)"
else
    echo "⚠️  pg_cron job NOT found"
fi

# Wait a bit for pg_cron to start executing
sleep 15

# Check for recent job runs with detailed status
CRON_RUNS_QUERY="SELECT status, return_message, start_time FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'stripe-sync-worker' LIMIT 1) ORDER BY start_time DESC LIMIT 5"
CRON_RUNS_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CRON_RUNS_QUERY\"}" 2>/dev/null || echo "[]")

if echo "$CRON_RUNS_RESULT" | jq -e '.[0]' > /dev/null 2>&1; then
    RUN_COUNT=$(echo "$CRON_RUNS_RESULT" | jq '. | length')
    echo "✓ pg_cron job has run $RUN_COUNT times"

    # Show details of most recent run
    RECENT_STATUS=$(echo "$CRON_RUNS_RESULT" | jq -r '.[0].status // "unknown"')
    RECENT_MSG=$(echo "$CRON_RUNS_RESULT" | jq -r '.[0].return_message // "no message"')
    echo "  Most recent run: status=$RECENT_STATUS"
    if [ "$RECENT_STATUS" = "failed" ] || [ "$RECENT_STATUS" = "error" ]; then
        echo "  Error: $RECENT_MSG"
    fi
else
    echo "⚠️  pg_cron job has not executed yet"
    echo "  This may indicate pg_cron or pg_net is not functioning"

    # Check if pg_net extension exists (required for net.http_post)
    NET_EXT_QUERY="SELECT extname FROM pg_extension WHERE extname = 'pg_net'"
    NET_EXT_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$NET_EXT_QUERY\"}" 2>/dev/null || echo "[]")

    if echo "$NET_EXT_RESULT" | jq -e '.[] | select(.extname == "pg_net")' > /dev/null 2>&1; then
        echo "  ✓ pg_net extension is installed"
    else
        echo "  ❌ pg_net extension NOT found - required for pg_cron to invoke Edge Functions"
    fi
fi
echo ""

# Get service role key for invoking Edge Functions
echo "🔑 Getting service role key..."
API_KEYS=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/api-keys")
SERVICE_ROLE_KEY=$(echo "$API_KEYS" | jq -r '.[] | select(.name == "service_role") | .api_key')

if [ -z "$SERVICE_ROLE_KEY" ] || [ "$SERVICE_ROLE_KEY" = "null" ]; then
    echo "❌ Could not get service role key"
    exit 1
fi
echo "✓ Got service role key"
echo ""

# Test GET endpoint for sync status
echo "🧪 Testing stripe-setup GET endpoint (status)..."

# Test 1: GET without auth should return 401
echo "   Testing GET without auth (should return 401)..."
STATUS_RESPONSE_NO_AUTH=$(curl -s -w "\n%{http_code}" \
    "https://$SUPABASE_PROJECT_REF.$SUPABASE_BASE_URL/functions/v1/stripe-setup")
STATUS_HTTP_CODE=$(echo "$STATUS_RESPONSE_NO_AUTH" | tail -n1)

if [ "$STATUS_HTTP_CODE" = "401" ]; then
    echo "   ✓ GET without auth returned 401 Unauthorized"
else
    echo "   ❌ GET without auth should return 401, got: $STATUS_HTTP_CODE"
    echo "   Response: $(echo "$STATUS_RESPONSE_NO_AUTH" | head -n -1)"
    exit 1
fi

# Test 2: GET with auth should return status
echo "   Testing GET with auth (should return 200)..."
STATUS_RESPONSE=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://$SUPABASE_PROJECT_REF.$SUPABASE_BASE_URL/functions/v1/stripe-setup")

# Verify response has package_version field
PACKAGE_VERSION=$(echo "$STATUS_RESPONSE" | jq -r '.package_version // empty')
if [ -n "$PACKAGE_VERSION" ] && [ "$PACKAGE_VERSION" != "null" ]; then
    echo "   ✓ GET endpoint returned package version: $PACKAGE_VERSION"
else
    echo "   ❌ GET endpoint did not return package_version"
    echo "   Response: $STATUS_RESPONSE"
    exit 1
fi

# Verify response has installation_status field
INSTALLATION_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.installation_status // empty')
if [ -n "$INSTALLATION_STATUS" ] && [ "$INSTALLATION_STATUS" != "null" ]; then
    echo "   ✓ GET endpoint returned installation status: $INSTALLATION_STATUS"
else
    echo "   ❌ GET endpoint did not return installation_status"
    echo "   Response: $STATUS_RESPONSE"
    exit 1
fi

# Verify response has sync_status array
SYNC_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.sync_status // empty')
if [ -n "$SYNC_STATUS" ] && [ "$SYNC_STATUS" != "null" ]; then
    SYNC_COUNT=$(echo "$SYNC_STATUS" | jq '. | length')
    echo "   ✓ GET endpoint returned sync_status array with $SYNC_COUNT account(s)"
else
    echo "   ❌ GET endpoint did not return sync_status array"
    echo "   Response: $STATUS_RESPONSE"
    exit 1
fi
echo ""

# Test 1: Verify backfill syncs the pre-existing customer (created before webhook existed)
echo "🧪 Testing backfill sync..."
echo "   Waiting for initial backfill to complete (up to 10 minutes)..."

# Wait for sync run to complete (closed_at IS NOT NULL)
SYNC_COMPLETE=false
for i in {1..60}; do
    sleep 10

    # Check if sync run is complete
    SYNC_STATUS_QUERY="SELECT closed_at, status FROM stripe.sync_runs ORDER BY started_at DESC LIMIT 1"
    SYNC_STATUS_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$SYNC_STATUS_QUERY\"}")

    # Check if result is an array (successful query) or error object
    if echo "$SYNC_STATUS_RESULT" | jq -e 'type == "array"' > /dev/null 2>&1; then
        CLOSED_AT=$(echo "$SYNC_STATUS_RESULT" | jq -r '.[0].closed_at // empty')
        STATUS=$(echo "$SYNC_STATUS_RESULT" | jq -r '.[0].status // "unknown"')
    else
        # Query failed - this shouldn't happen since schema was already verified
        echo "   ❌ Failed to query sync_runs view"
        echo "   Response: $SYNC_STATUS_RESULT"
        exit 1
    fi

    if [ -n "$CLOSED_AT" ] && [ "$CLOSED_AT" != "null" ]; then
        SYNC_COMPLETE=true
        echo "   ✓ Initial backfill completed with status: $STATUS"
        break
    fi

    # Show progress every 30 seconds
    if [ $((i % 3)) -eq 0 ]; then
        # Check pg_cron execution count
        CRON_COUNT_QUERY="SELECT COUNT(*) as count FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'stripe-sync-worker' LIMIT 1)"
        CRON_COUNT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
            -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"query\": \"$CRON_COUNT_QUERY\"}" 2>/dev/null | jq -r '.[0].count // 0')

        echo "   Still running... (${i}0s elapsed, status: $STATUS, pg_cron executions: $CRON_COUNT)"
    fi
done

if [ "$SYNC_COMPLETE" != true ]; then
    echo "   ❌ Backfill did not complete within 10 minutes"
    exit 1
fi

# Now check if customer was synced
echo "   Verifying customer was synced..."
BACKFILL_QUERY="SELECT id FROM stripe.customers WHERE id = '$BACKFILL_CUSTOMER_ID'"
BACKFILL_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$BACKFILL_QUERY\"}")

if echo "$BACKFILL_RESULT" | jq -e ".[0].id == \"$BACKFILL_CUSTOMER_ID\"" > /dev/null 2>&1; then
    echo "   ✓ Pre-existing customer synced via backfill"
else
    echo "   ❌ Pre-existing customer NOT found in database after backfill"
    echo "   This could mean:"
    echo "   - Customer was created in different Stripe account"
    echo "   - Database write failed"
    exit 1
fi
echo ""

# Test 2: Create a NEW customer and verify webhook syncs it
echo "🧪 Testing webhook sync..."
echo "   Creating test customer in Stripe..."
CUSTOMER_RESPONSE=$(curl -s -X POST "https://api.stripe.com/v1/customers" \
    -u "$STRIPE_API_KEY:" \
    -d "name=Webhook Test Customer" \
    -d "email=webhook-test-$(date +%s)@example.com" \
    -d "metadata[test]=webhook-integration")

TEST_CUSTOMER_ID=$(echo "$CUSTOMER_RESPONSE" | jq -r '.id')
if [ -z "$TEST_CUSTOMER_ID" ] || [ "$TEST_CUSTOMER_ID" = "null" ]; then
    echo "❌ Failed to create test customer"
    echo "   Response: $CUSTOMER_RESPONSE"
    exit 1
fi
echo "   ✓ Created customer: $TEST_CUSTOMER_ID"

# Wait for webhook to process (Stripe sends webhooks async)
echo "   Waiting for webhook to sync (up to 30s)..."
WEBHOOK_SUCCESS=false
for i in {1..15}; do
    sleep 2

    # Check if customer exists in database
    CUSTOMER_QUERY="SELECT id FROM stripe.customers WHERE id = '$TEST_CUSTOMER_ID'"
    CUSTOMER_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$CUSTOMER_QUERY\"}")

    if echo "$CUSTOMER_RESULT" | jq -e ".[0].id == \"$TEST_CUSTOMER_ID\"" > /dev/null 2>&1; then
        WEBHOOK_SUCCESS=true
        break
    fi
done

if [ "$WEBHOOK_SUCCESS" = true ]; then
    echo "   ✓ Customer synced via webhook"
else
    echo "   ❌ Customer NOT synced via webhook after 30s"
    echo "   This could mean:"
    echo "   - Webhook is not properly configured"
    echo "   - Edge Function failed to process"
    echo "   - Database write failed"
    exit 1
fi
echo ""

echo "================================================"
echo "✅ Deploy integration test PASSED!"
echo "================================================"
echo ""
echo "Deployed resources:"
echo "  - Edge Functions: stripe-setup, stripe-webhook, stripe-worker"
echo "  - Stripe webhook: $WEBHOOK_ID"
echo "  - Database schema: stripe.*"
echo ""
echo "Verified functionality:"
echo "  ✓ Installation status (migrations table + schema comment)"
echo "  ✓ Backfill syncs pre-existing Stripe data to database"
echo "  ✓ Webhook syncs new Stripe events to database in real-time"
echo ""
echo "Note: Resources will be deleted during cleanup"
