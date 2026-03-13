# With Supabase Edge Functions

Deploy Sync Engine to Supabase using managed Edge Functions for webhook ingestion and background workers.

## Prerequisites

- A Supabase project
- A Stripe account and API key
- `@stripe/sync-engine` CLI installed (or run through `npx`)
- `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`

## Deploy

Use the CLI to install the Supabase integration:

```bash
npx @stripe/sync-engine supabase install \
  --token $SUPABASE_ACCESS_TOKEN \
  --project $SUPABASE_PROJECT_REF \
  --stripe-key $STRIPE_API_KEY
```

What this does:

- Deploys webhook and worker Edge Functions
- Runs database migrations
- Configures webhook handling for Stripe events
- Stores required secrets in Supabase

## Update Stripe Webhook Endpoint

After deployment, configure your Stripe webhook endpoint to point to the deployed Supabase webhook function URL.

## Remove Installation

To remove the Supabase deployment:

```bash
npx @stripe/sync-engine supabase uninstall \
  --token $SUPABASE_ACCESS_TOKEN \
  --project $SUPABASE_PROJECT_REF \
  --stripe-key $STRIPE_API_KEY
```

## Notes

- Webhook mode in local development may require ngrok; Supabase deployment does not.
- For full CLI options and flags, see `packages/sync-engine/src/cli/README.md`.
