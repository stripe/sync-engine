# Schema Visualizer Runbook

This runbook explains how to generate artifacts, run the standalone schema visualizer locally, and deploy it.

## Overview

The visualizer is a browser app backed by static artifacts:

- `bootstrap.sql` contains the schema and seed data.
- `manifest.json` contains metadata and table counts.
- PGlite hydrates those artifacts in the browser so the UI can run SQL locally.

The generated files live in `packages/visualizer/public/explorer-data/`.

## Common Commands

Generate fresh artifacts:

```bash
pnpm explorer:build
```

Start the visualizer on its own:

```bash
pnpm visualizer
```

Rebuild artifacts and then start the visualizer:

```bash
pnpm visualizer:with-data
```

By default the root `visualizer` script runs the app on `http://localhost:3001`.

## Build Pipeline

`pnpm explorer:build` runs the full pipeline:

1. Start an isolated Docker Postgres harness.
2. Run migrations for the projected Stripe schema.
3. Seed deterministic fake Stripe data.
4. Export `bootstrap.sql` and `manifest.json`.
5. Stop and clean up the harness.

After a successful build you should have:

```text
packages/visualizer/public/explorer-data/
├── bootstrap.sql
└── manifest.json
```

## Local Workflow

Typical local loop:

1. Run `pnpm visualizer` while working on the UI.
2. Edit files in `packages/visualizer/src/`.
3. Re-run `pnpm explorer:build` when you need new data or a different API version.

To verify the generated artifact:

```bash
jq . packages/visualizer/public/explorer-data/manifest.json
```

Look for:

- `apiVersion`
- `totalTables`
- `verification.allTablesSeeded`
- `verification.emptyTables`

## Manual Phase Debugging

Use the underlying scripts when you need to inspect one phase at a time:

```bash
pnpm tsx scripts/explorer-harness.ts start
pnpm tsx scripts/explorer-harness.ts status
pnpm tsx scripts/explorer-migrate.ts --api-version=2020-08-27
pnpm tsx scripts/explorer-seed.ts --api-version=2020-08-27 --seed=42
pnpm tsx scripts/explorer-export.ts
pnpm tsx scripts/explorer-harness.ts stop
```

## Deployment Notes

Deploy `packages/visualizer` as the standalone UI package.

Important:

- Vercel does not provide Docker during builds.
- If your deployment flow needs fresh artifacts, generate them before deployment on a machine or CI runner that has Docker.
- Generated artifacts are ignored by git in this repo, so deployment should rely on pre-build generation rather than committed artifacts.

## Troubleshooting

If the harness does not start:

- Make sure Docker is installed and running.
- Check for stale containers with `docker ps -a | rg schema-explorer`.
- Stop any leftover harness with `pnpm tsx scripts/explorer-harness.ts stop`.

If export fails:

- Confirm `.tmp/schema-explorer-run.json` exists.
- Confirm `packages/visualizer/public/explorer-data/` is writable.
- Check that the harness is still reachable.

If the visualizer loads with no data:

- Verify `bootstrap.sql` contains inserts as well as schema DDL.
- Check the browser console for hydration errors.
- Confirm `manifest.json` and `bootstrap.sql` exist under `packages/visualizer/public/explorer-data/`.
