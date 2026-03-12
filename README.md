# Stripe Sync Engine Monorepo

![GitHub License](https://img.shields.io/github/license/stripe-experiments/sync-engine)
![NPM Version](https://img.shields.io/npm/v/stripe-experiment-sync)

This monorepo contains packages for synchronizing your Stripe account with a PostgreSQL database:

- [`stripe-experiment-sync`](./packages/sync-engine/README.md): A TypeScript library for syncing Stripe data to PostgreSQL with managed webhooks, CLI tools, and Supabase Edge Function deployment.
- [`stripe-sync-fastify`](./packages/fastify-app/README.md): A Fastify-based server and Docker image for production deployments.

![Sync Stripe with PostgreSQL](./docs/stripe-sync-engine.jpg)

---

## Quick Start

The easiest way to sync Stripe data to PostgreSQL is using the CLI. It will run a full historical backfill, and optionally stay alive to stream real-time events.

### CLI (Webhook Mode)

```bash
npx stripe-experiment-sync sync \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL \
  --listen-mode webhook \
  --ngrok-token $NGROK_AUTH_TOKEN
```

### CLI (Websocket Mode)

```bash
npx stripe-experiment-sync sync \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL \
  --listen-mode websocket
```

### Supabase Edge Functions

Deploy to Supabase for serverless operation:

```bash
npx stripe-experiment-sync supabase install \
  --token $SUPABASE_ACCESS_TOKEN \
  --project $SUPABASE_PROJECT_REF \
  --stripe-key $STRIPE_API_KEY
```

---

## Configuration Options

| Option                          | Type    | Description                                                                                              |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `poolConfig`                    | object  | **Required.** PostgreSQL connection pool configuration. Supports `connectionString`, `max`, `keepAlive`. |
| `stripeSecretKey`               | string  | **Required.** Stripe secret key (sk\_...)                                                                |
| `stripeWebhookSecret`           | string  | Stripe webhook signing secret (only needed for manual webhook processing)                                |
| `stripeApiVersion`              | string  | Stripe API version (default: `2020-08-27`)                                                               |
| `enableSigma`                   | boolean | Enable Stripe Sigma reporting data sync. Default: false                                                  |
| `autoExpandLists`               | boolean | Fetch all list items from Stripe (not just the default 10)                                               |
| `backfillRelatedEntities`       | boolean | Ensure related entities exist for foreign key integrity                                                  |
| `revalidateObjectsViaStripeApi` | Array   | Always fetch latest data from Stripe instead of trusting webhook payload                                 |
| `logger`                        | Logger  | Logger instance (pino-compatible)                                                                        |

---

## How it works

![How it works](./docs/sync-engine-how.png)

- Automatically runs database migrations to create the `stripe` schema with tables matching Stripe objects.
- Creates managed webhooks in Stripe for automatic event synchronization.
- Processes webhook events and syncs data to PostgreSQL in real-time.
- Supports syncing historical data from Stripe.
- Tracks sync runs and provides observability into sync operations.

---

## Packages

- [Library & CLI: stripe-experiment-sync](./packages/sync-engine/README.md)
- [Docker/Server: stripe-sync-fastify](./packages/fastify-app/README.md)
- Dashboard app in `packages/dashboard`
- [Schema Visualizer](./packages/visualizer/README.md)

The schema visualizer is a client-side SQL playground for Stripe tables.
It uses `pnpm explorer:build` to generate `bootstrap.sql` and `manifest.json`
for PGlite hydration in `packages/visualizer`.
Use `pnpm visualizer:with-data` to rebuild artifacts and start the visualizer together.

See the package READMEs where present for installation, configuration, and usage instructions.

### Schema Visualizer

See [`packages/visualizer/README.md`](./packages/visualizer/README.md) for the current visualizer workflow.

---

## Webhook Support

For the full event matrix (supported, unsupported, and caveats), see [`docs/webhook-event-support.md`](./docs/webhook-event-support.md).

## Syncing Data

For the current supported Stripe object types, see [`packages/sync-engine/README.md#syncing-data`](./packages/sync-engine/README.md#syncing-data).

---

## Contributing

Issues and pull requests are welcome at [`stripe-experiments/sync-engine`](https://github.com/stripe-experiments/sync-engine).

## License

See [LICENSE](LICENSE) file.
