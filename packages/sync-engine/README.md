# Stripe Sync Engine

![GitHub License](https://img.shields.io/github/license/stripe-experiments/sync-engine)
![NPM Version](https://img.shields.io/npm/v/stripe-experiment-sync)

Sync Stripe data into PostgreSQL from the command line.

## Install

```sh
npm install stripe-experiment-sync stripe
# or
pnpm add stripe-experiment-sync stripe
# or
yarn add stripe-experiment-sync stripe
```

## Run Sync (CLI)

Set environment variables:

```sh
export STRIPE_API_KEY=sk_live_xxx
export DATABASE_URL=postgres://...
```

Then run either command:

```sh
# 1) Sync everything
npx stripe-experiment-sync sync \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL

# 2) Sync one object type
npx stripe-experiment-sync sync customer \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL
```

> **Note:** `sync` automatically applies any pending database migrations before syncing data.

## Supported Objects

- `all`
- `charge`
- `checkout_sessions`
- `credit_note`
- `customer`
- `customer_with_entitlements`
- `dispute`
- `early_fraud_warning`
- `invoice`
- `payment_intent`
- `payment_method`
- `plan`
- `price`
- `product`
- `refund`
- `setup_intent`
- `subscription`
- `subscription_schedules`
- `tax_id`

## License

See [LICENSE](LICENSE) file.

## Contributing

Issues and pull requests are welcome at [https://github.com/stripe-experiments/sync-engine](https://github.com/stripe-experiments/sync-engine).
