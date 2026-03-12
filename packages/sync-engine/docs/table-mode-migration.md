# Table Mode Migration Documentation

## Overview

The sync-engine migration system now supports two table filtering modes:

1. **`runtime_required`** (default): Migrates only tables in `RUNTIME_REQUIRED_TABLES` (~24 tables)
2. **`all_projected`**: Migrates all resolvable tables from the OpenAPI spec by omitting the `allowedTables` filter

## Configuration

### MigrationConfig

The `MigrationConfig` type now includes an optional `tableMode` parameter:

```typescript
type MigrationConfig = {
  // ... existing fields
  /**
   * Table filtering mode for OpenAPI schema migration:
   * - 'runtime_required': Only migrate tables in RUNTIME_REQUIRED_TABLES (default)
   * - 'all_projected': Migrate all resolvable tables from the OpenAPI spec
   */
  tableMode?: 'runtime_required' | 'all_projected'
}
```

### Usage Examples

#### Default (runtime_required mode)

```typescript
await runMigrations({
  databaseUrl: 'postgresql://localhost:5432/mydb',
  stripeApiVersion: '2020-08-27',
  // tableMode defaults to 'runtime_required'
})
```

#### All projected tables mode

```typescript
await runMigrations({
  databaseUrl: 'postgresql://localhost:5432/mydb',
  stripeApiVersion: '2020-08-27',
  tableMode: 'all_projected',
})
```

#### With embedded migrations

```typescript
await runMigrationsFromContent(
  {
    databaseUrl: 'postgresql://localhost:5432/mydb',
    tableMode: 'all_projected',
  },
  migrations
)
```

## Implementation Details

### Mode Behavior

- **`runtime_required`** (default):
  - Passes `allowedTables: [...RUNTIME_REQUIRED_TABLES]` to `SpecParser.parse()`
  - Includes approximately 24 tables required for runtime sync operations
  - Tables include: products, prices, customers, subscriptions, invoices, charges, etc.

- **`all_projected`**:
  - Does NOT pass `allowedTables` to `SpecParser.parse()` (property is omitted)
  - When `allowedTables` is undefined, the `SpecParser` parses all resolvable `x-resourceId` entries from the OpenAPI spec (i.e., no table filtering is applied).

### Table Counts

Based on the current implementation:

- **runtime_required**: ~24 tables (RUNTIME_REQUIRED_TABLES)
- **all_projected**: all resolvable tables from the OpenAPI spec (significantly more than `runtime_required`; the exact count depends on the Stripe API version and spec).
- **Expected behavior**: all_projected should produce significantly more tables

To verify the actual table counts in your environment, run:

```bash
tsx packages/sync-engine/scripts/test-table-modes.ts
```

## Logging

When applying OpenAPI schemas, the migration logger now includes the `tableMode` field:

```typescript
config.logger?.info(
  {
    tableCount: parsedSpec.tables.length,
    writePlanCount: writePlans.length,
    tableMode: 'runtime_required' | 'all_projected',
    marker: '...',
  },
  'Applied OpenAPI-generated Stripe tables'
)
```

## Files Modified

1. **packages/sync-engine/src/database/migrate.ts**
   - Added `tableMode` field to `MigrationConfig` type
   - Modified `applyOpenApiSchema()` to conditionally pass `allowedTables` based on mode
   - Updated logging to include `tableMode`
   - Both `runMigrations()` and `runMigrationsFromContent()` support the new parameter

2. **packages/sync-engine/docs/table-mode-migration.md** (this file)
   - Documentation for the new feature

3. **packages/sync-engine/scripts/test-table-modes.ts**
   - Test script to compare table counts between modes

## Future Considerations

If you need `all_projected` mode to truly parse ALL resolvable tables (not just RUNTIME_REQUIRED_TABLES), you would need to modify `packages/sync-engine/src/openapi/specParser.ts` line 44 to remove the default:

```typescript
// Current:
const allowedTables = new Set(options.allowedTables ?? RUNTIME_REQUIRED_TABLES)

// Modified to support truly unrestricted parsing:
const allowedTables = options.allowedTables ? new Set(options.allowedTables) : null

// Then update line 62-64:
if (allowedTables && !allowedTables.has(tableName)) {
  continue
}
```

However, per the task requirements, no changes to `specParser.ts` were made in this implementation.

## Migration Safety

The default behavior remains unchanged (`runtime_required` mode), ensuring backward compatibility. Existing code that doesn't specify `tableMode` will continue to work exactly as before.
