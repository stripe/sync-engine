# Schema Explorer Scripts

This directory contains scripts for setting up and seeding an isolated Postgres database for testing the schema explorer.

## Scripts

### 1. Docker Harness (`explorer-harness.ts`)

Creates and manages an isolated Postgres container with random suffixes to avoid collisions.

**Commands:**
```bash
# Start the harness (creates container, random port, volume)
pnpm explorer:db:start

# Check status
pnpm explorer:db:status

# Stop and cleanup
pnpm explorer:db:stop
```

**Features:**
- Random container name suffix to avoid collisions
- Random host port (50000-60000, avoiding 5432 and 55432)
- Safety checks to prevent running against shared instances
- Writes connection metadata to `.tmp/schema-explorer-run.json`

### 2. Migrations (`explorer-migrate.ts`)

Runs database migrations to create the Stripe schema tables.

**Command:**
```bash
pnpm explorer:migrate
```

**What it does:**
- Reads connection info from `.tmp/schema-explorer-run.json`
- Runs initial migrations to create base tables (accounts, _sync_runs, etc.)
- Uses OpenAPI spec to create Stripe object tables (products, customers, invoices, etc.)
- Tables are created with `_raw_data` JSONB column and generated columns

### 3. Seed Data (`explorer-seed.ts`)

Generates deterministic, graph-aware synthetic Stripe data.

**Command:**
```bash
pnpm explorer:seed
```

**Features:**
- **Deterministic**: Uses fixed seed (42) for reproducible data
- **Graph-aware**: Maintains proper relationships between objects
  - accounts → products → prices → customers → payment_methods → subscriptions → subscription_items → invoices → payment_intents → charges → refunds
  - Plus: checkout_sessions, credit_notes, disputes, setup_intents, tax_ids
- **Stable IDs**: Uses predictable prefixes (e.g., `prod_seed_001`, `cus_seed_001`)
- **Stable timestamps**: All timestamps fall within 2024 date range
- **JSONB insertion**: Data is inserted as `_raw_data` JSONB, so generated columns populate automatically
- **FK satisfaction**: Inserts accounts first, then follows dependency order
- **Re-runnable**: Clears existing data before seeding for clean re-runs

**Data volumes:**
- 1 account
- 8 products
- 12 prices
- 25 customers
- 30 payment methods
- 15 setup intents
- 20 subscriptions
- 30 subscription items
- 35 invoices
- 40 payment intents
- 45 charges
- 10 refunds
- 18 checkout sessions
- 5 credit notes
- 3 disputes
- 12 tax IDs

**Total: ~270 rows** across 16 core tables

## Quick Start

```bash
# 1. Start the database
pnpm explorer:db:start

# 2. Run migrations
pnpm explorer:migrate

# 3. Seed data
pnpm explorer:seed

# 4. When done, cleanup
pnpm explorer:db:stop
```

## Verifying Data

Connect to the database using the connection string from `.tmp/schema-explorer-run.json`:

```bash
# Get connection details
cat .tmp/schema-explorer-run.json

# Example: Connect via psql
docker exec <container-name> psql -U explorer -d schema_explorer

# Example queries
SELECT id, name, email FROM stripe.customers LIMIT 5;
SELECT id, customer, subscription FROM stripe.invoices LIMIT 5;
SELECT p.id, p.customer, c.id as charge FROM stripe.payment_intents p LEFT JOIN stripe.charges c ON c.payment_intent = p.id LIMIT 5;
```

## Implementation Details

### Deterministic Random Generation

The seed script uses a simple Linear Congruential Generator (LCG) with a fixed seed to ensure:
- Same data on every run
- Same IDs, names, emails, amounts, timestamps
- Same relationships between objects

### Graph-Aware Seeding

Objects are seeded in dependency order:
1. **Products & Prices**: Foundation of billing
2. **Customers**: Who gets billed
3. **Payment Methods**: How customers pay
4. **Subscriptions**: Recurring billing
5. **Invoices**: Bills generated from subscriptions or manual
6. **Payment Intents**: Payment attempts
7. **Charges**: Actual charges on payment methods
8. **Refunds**: Returns on charges
9. **Supporting objects**: Checkout sessions, credit notes, disputes, tax IDs

References between objects use modulo arithmetic to ensure valid relationships:
```typescript
// Example: Invoice #10 references Customer #10, wrapping around if needed
const customerId = this.gen.customerId((i % 25) + 1);  // 25 total customers
```

### Why No Faker?

The implementation uses a hand-rolled deterministic generator instead of `@faker-js/faker` to:
- Minimize dependencies
- Ensure perfect reproducibility (faker may change between versions)
- Keep data generation logic simple and auditable
- Match Stripe ID prefixes exactly (e.g., `prod_`, `cus_`, `pi_`)

## Safety Features

The harness includes multiple safety checks:
1. **Port validation**: Refuses to use ports 5432 or 55432
2. **Container name validation**: Refuses names matching "stripe-db"
3. **Localhost verification**: Only works with local Docker containers
4. **Random suffixes**: Prevents accidental collision with existing containers

## Metadata File

`.tmp/schema-explorer-run.json` contains:
```json
{
  "databaseUrl": "postgresql://explorer:password@localhost:50318/schema_explorer",
  "containerId": "6f4a38038767...",
  "containerName": "schema-explorer-u7arxyi6",
  "port": 50318,
  "volumeName": "schema-explorer-vol-u7arxyi6",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

This file is used by migrate and seed scripts to find the database connection.
