import { describe, expect, it } from 'vitest'
import { PostgresAdapter } from '../postgresAdapter'
import type { ParsedResourceTable } from '../types'

const SAMPLE_TABLE: ParsedResourceTable = {
  tableName: 'customers',
  resourceId: 'customer',
  sourceSchemaName: 'customer',
  columns: [
    { name: 'created', type: 'bigint', nullable: false },
    { name: 'deleted', type: 'boolean', nullable: true },
    { name: 'metadata', type: 'json', nullable: true },
    { name: 'expires_at', type: 'timestamptz', nullable: true },
  ],
}

const EXPANDABLE_REFERENCE_TABLE: ParsedResourceTable = {
  tableName: 'charges',
  resourceId: 'charge',
  sourceSchemaName: 'charge',
  columns: [{ name: 'customer', type: 'json', nullable: true, expandableReference: true }],
}

const ACCOUNT_TABLE: ParsedResourceTable = {
  tableName: 'accounts',
  resourceId: 'account',
  sourceSchemaName: 'account',
  columns: [
    { name: 'business_profile', type: 'json', nullable: true },
    { name: 'charges_enabled', type: 'boolean', nullable: false },
  ],
}

describe('PostgresAdapter', () => {
  it('emits deterministic DDL statements with runtime-required metadata columns', () => {
    const adapter = new PostgresAdapter({ schemaName: 'stripe' })
    const statements = adapter.buildAllStatements([SAMPLE_TABLE])

    expect(statements).toHaveLength(9)
    expect(statements[0]).toContain('CREATE TABLE "stripe"."customers"')
    expect(statements[0]).toContain('"_raw_data" jsonb NOT NULL')
    expect(statements[0]).toContain('"_account_id" text NOT NULL')
    expect(statements[0]).toContain(
      '"id" text GENERATED ALWAYS AS ((_raw_data->>\'id\')::text) STORED'
    )
    expect(statements[0]).toContain(
      '"metadata" jsonb GENERATED ALWAYS AS ((_raw_data->\'metadata\')::jsonb) STORED'
    )
    // Temporal columns are stored as text generated columns for immutability safety.
    expect(statements[0]).toContain(
      '"expires_at" text GENERATED ALWAYS AS ((_raw_data->>\'expires_at\')::text) STORED'
    )
    expect(
      statements.some((stmt) => stmt.includes('ADD COLUMN IF NOT EXISTS "created" bigint'))
    ).toBe(true)
    expect(
      statements.some((stmt) => stmt.includes('ADD COLUMN IF NOT EXISTS "deleted" boolean'))
    ).toBe(true)
    expect(
      statements.some((stmt) => stmt.includes('ADD COLUMN IF NOT EXISTS "metadata" jsonb'))
    ).toBe(true)
    expect(
      statements.some((stmt) => stmt.includes('ADD COLUMN IF NOT EXISTS "expires_at" text'))
    ).toBe(true)
    expect(statements[5]).toContain(
      'FOREIGN KEY ("_account_id") REFERENCES "stripe"."_sync_accounts" (id)'
    )
    expect(statements[7]).toContain('DROP TRIGGER IF EXISTS handle_updated_at')
    expect(statements[8]).toContain('EXECUTE FUNCTION set_updated_at()')
  })

  it('produces stable output across repeated calls', () => {
    const adapter = new PostgresAdapter({ schemaName: 'stripe' })
    const first = adapter.buildAllStatements([SAMPLE_TABLE])
    const second = adapter.buildAllStatements([SAMPLE_TABLE])
    expect(second).toEqual(first)
  })

  it('materializes expandable reference columns as text ids for compatibility', () => {
    const adapter = new PostgresAdapter({ schemaName: 'stripe' })
    const statements = adapter.buildAllStatements([EXPANDABLE_REFERENCE_TABLE])

    expect(statements[0]).toContain('"customer" text GENERATED ALWAYS AS (CASE')
    expect(statements[0]).toContain("WHEN jsonb_typeof(_raw_data->'customer') = 'object'")
    expect(statements[0]).toContain("THEN (_raw_data->'customer'->>'id')")
  })

  it('uses accountSchema for FK when provided (split schema)', () => {
    const adapter = new PostgresAdapter({
      schemaName: 'stripe_data',
      accountSchema: 'stripe_sync',
    })
    const statements = adapter.buildAllStatements([SAMPLE_TABLE])
    expect(statements[0]).toContain('CREATE TABLE "stripe_data"."customers"')
    expect(statements[5]).toContain(
      'FOREIGN KEY ("_account_id") REFERENCES "stripe_sync"."_sync_accounts" (id)'
    )
  })

  it('creates projected accounts like any other resource table', () => {
    const adapter = new PostgresAdapter({ schemaName: 'stripe' })
    const statements = adapter.buildAllStatements([ACCOUNT_TABLE])

    expect(statements).toHaveLength(7)
    expect(statements[0]).toContain('CREATE TABLE "stripe"."accounts"')
    expect(statements[0]).toContain('"_account_id" text NOT NULL')
    expect(statements[0]).toContain(
      '"business_profile" jsonb GENERATED ALWAYS AS ((_raw_data->\'business_profile\')::jsonb) STORED'
    )
    expect(statements[1]).toBe(
      `ALTER TABLE "stripe"."accounts" ADD COLUMN IF NOT EXISTS "business_profile" jsonb GENERATED ALWAYS AS ((_raw_data->'business_profile')::jsonb) STORED;`
    )
    expect(statements[2]).toBe(
      `ALTER TABLE "stripe"."accounts" ADD COLUMN IF NOT EXISTS "charges_enabled" boolean GENERATED ALWAYS AS ((NULLIF(_raw_data->>'charges_enabled', ''))::boolean) STORED;`
    )
    expect(statements[3]).toContain(
      'FOREIGN KEY ("_account_id") REFERENCES "stripe"."_sync_accounts" (id)'
    )
  })
})
