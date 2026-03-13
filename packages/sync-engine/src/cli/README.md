# sync-engine CLI

CLI tool for syncing Stripe data to PostgreSQL with optional real-time event streaming and Supabase Edge Functions deployment.

## Features

- 🔄 Full historical backfill from Stripe to PostgreSQL
- 📡 Optional real-time event streaming via WebSocket or ngrok webhook
- 🚀 Automatic table creation and migrations
- 🔐 Secure webhook signature verification
- 🧹 Automatic cleanup on exit
- ☁️ Supabase Edge Functions deployment for serverless webhook handling

## Installation

```bash
npm install -g @stripe/sync-engine
```

## Commands

### Run Migrations

```bash
sync-engine migrate [options]

Options:
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
  --sigma                  Create Sigma tables during migration
```

Runs database migrations to create Stripe schema tables.

### Sync Data

```bash
sync-engine sync [entityName] [options]

Arguments:
  entityName               Optional Stripe entity to sync (e.g., customer, invoice, product)

Options:
  --stripe-key <key>       Stripe API key (or STRIPE_API_KEY env)
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
  --sigma                  Enable Sigma tables
  --interval <seconds>     Skip resync if a successful run completed within this many seconds (default: 86400)
  --worker-count <count>   Number of parallel sync workers (default: 50)
  --rate-limit <limit>     Max requests per second (default: 25)
  --listen-mode <mode>     Event listener mode: websocket, webhook, or disabled (default: disabled)
```

Syncs data from Stripe to PostgreSQL. When called without an entity name, syncs all supported objects. When an entity name is provided, syncs only that entity.

The `--listen-mode` option controls real-time event streaming after the backfill completes:

- **`disabled`** (default) — performs the backfill and exits.
- **`websocket`** — connects directly to Stripe via WebSocket (no ngrok needed). After the backfill, the process stays alive streaming live changes.
- **`webhook`** — creates an ngrok tunnel and Express server to receive webhook events. Requires `NGROK_AUTH_TOKEN`. After the backfill, the process stays alive streaming live changes.

If a successful sync run completed within the `--interval` window, the backfill is skipped entirely.

### Monitor

```bash
sync-engine monitor [options]

Options:
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
  --stripe-key <key>       Stripe API key (or STRIPE_API_KEY env)
```

Live display of table row counts in the stripe schema.

### Supabase Deployment

#### Install to Supabase

```bash
sync-engine supabase install [options]

Options:
  --token <token>              Supabase access token (or SUPABASE_ACCESS_TOKEN env)
  --project <ref>              Supabase project ref (or SUPABASE_PROJECT_REF env)
  --stripe-key <key>           Stripe API key (or STRIPE_API_KEY env)
  --worker-interval <seconds>  Worker interval in seconds (defaults to 60)
  --sync-interval <seconds>    Full resync interval in seconds (default: 604800 = 1 week)
  --rate-limit <limit>         Max Stripe API requests per second (default: 60)
  --sigma                      Enable Sigma sync
  --management-url <url>       Supabase management API URL (or SUPABASE_MANAGEMENT_URL env)
  --package-version <version>  Package version to install (defaults to latest)
```

Deploys Stripe sync engine as Supabase Edge Functions. The worker interval controls how frequently the pg_cron job invokes the worker function to process sync operations.

#### Uninstall from Supabase

```bash
sync-engine supabase uninstall [options]

Options:
  --token <token>          Supabase access token (or SUPABASE_ACCESS_TOKEN env)
  --project <ref>          Supabase project ref (or SUPABASE_PROJECT_REF env)
  --management-url <url>   Supabase management API URL (or SUPABASE_MANAGEMENT_URL env)
```

Removes Stripe sync Edge Functions from Supabase.

## Environment Variables

Create a `.env` file in your project (see `.env.sample`):

```env
# Required for sync commands
STRIPE_API_KEY=sk_test_...
DATABASE_URL=postgresql://user:password@localhost:5432/mydb

# Required for webhook listen mode
NGROK_AUTH_TOKEN=your_ngrok_token

# Required for Supabase deployment
SUPABASE_ACCESS_TOKEN=your_supabase_token
SUPABASE_PROJECT_REF=your_project_ref
```

Then run commands without options:

```bash
sync-engine migrate
sync-engine sync
sync-engine sync customer
sync-engine supabase install
```

## Usage Examples

### One-off Backfill

```bash
# Sync all data and exit
sync-engine sync

# Sync a specific entity
sync-engine sync customer
```

### Continuous Sync (Backfill + Live Streaming)

```bash
# Backfill then stream via WebSocket (no ngrok needed)
sync-engine sync --listen-mode websocket

# Backfill then stream via ngrok webhook
sync-engine sync --listen-mode webhook
```

### Supabase Deployment Workflow

1. **Deploy to Supabase**:

   ```bash
   sync-engine supabase install
   ```

2. **Update webhook endpoint in Stripe dashboard** to point to your Supabase Edge Function

3. **To remove**:

   ```bash
   sync-engine supabase uninstall
   ```

## Testing with Stripe Events

Trigger test Stripe events using the Stripe CLI:

```bash
stripe trigger payment_intent.succeeded
stripe trigger customer.created
stripe trigger subscription.created
```

This uses the [Stripe CLI](https://stripe.com/docs/stripe-cli) to send test webhook events.

**Install Stripe CLI:**

- macOS: `brew install stripe/stripe-cli/stripe`
- Download: https://github.com/stripe/stripe-cli/releases/latest

## How It Works

### Supabase Deployment Mode

1. **Deploys Edge Functions**: Creates webhook and worker Edge Functions
2. **Runs Migrations**: Automatically sets up database schema
3. **Configures Webhooks**: Sets up Stripe webhook endpoints pointing to Supabase
4. **Manages Secrets**: Securely stores Stripe API keys in Supabase

The deployment:

- Uses Supabase's serverless Edge Functions (Deno runtime)
- Connects to your Supabase PostgreSQL database
- Handles webhook signature verification
- Processes events asynchronously via queue

## Troubleshooting

### Webhook Limit Reached

If you hit Stripe's 16 webhook endpoint limit, delete unused webhooks from the Stripe Dashboard:
https://dashboard.stripe.com/webhooks

### Database Connection Issues

Ensure your `DATABASE_URL` is correct and the database is accessible:

```bash
psql $DATABASE_URL -c "SELECT 1"
```

### Ngrok Authentication

Get your ngrok auth token from: https://dashboard.ngrok.com/get-started/your-authtoken

## License

MIT
