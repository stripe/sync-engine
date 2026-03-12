import { describe, expect, it } from 'vitest'
import { renderMigrationTemplate, SYNC_SCHEMA_PLACEHOLDER } from '../migrationTemplate'

describe('renderMigrationTemplate', () => {
  it('replaces the explicit sync schema placeholder with a quoted identifier', () => {
    const input = `CREATE TABLE ${SYNC_SCHEMA_PLACEHOLDER}."accounts" (id text);`
    expect(renderMigrationTemplate(input, { syncSchema: 'existing_schema' })).toBe(
      `CREATE TABLE "existing_schema"."accounts" (id text);`
    )
  })

  it('replaces all placeholder occurrences in a multi-statement block', () => {
    const input = [
      `CREATE TABLE ${SYNC_SCHEMA_PLACEHOLDER}."accounts" (id text);`,
      `CREATE INDEX ON ${SYNC_SCHEMA_PLACEHOLDER}."accounts" (id);`,
      `ALTER TABLE ${SYNC_SCHEMA_PLACEHOLDER}."accounts" ADD COLUMN foo text;`,
    ].join('\n')

    const rendered = renderMigrationTemplate(input, { syncSchema: 'my_eval' })
    expect(rendered).not.toContain(SYNC_SCHEMA_PLACEHOLDER)
    expect(rendered.match(/"my_eval"/g)?.length).toBe(3)
  })

  it('escapes double-quotes inside schema names', () => {
    const input = `CREATE SCHEMA ${SYNC_SCHEMA_PLACEHOLDER};`
    const rendered = renderMigrationTemplate(input, { syncSchema: 'weird"schema' })
    expect(rendered).toBe(`CREATE SCHEMA "weird""schema";`)
  })

  it('does not touch ordinary text outside placeholders', () => {
    const input = `-- Sync stripe data\nCREATE TABLE ${SYNC_SCHEMA_PLACEHOLDER}."products" (stripe_id text);`
    const rendered = renderMigrationTemplate(input, { syncSchema: 'other' })
    expect(rendered).toContain('-- Sync stripe data')
    expect(rendered).toContain('stripe_id text')
    expect(rendered).toContain('"other"."products"')
  })

  it('throws on unknown placeholders', () => {
    const input = `CREATE TABLE {{data_schema}}."accounts" (id text);`
    expect(() => renderMigrationTemplate(input, { syncSchema: 'existing_schema' })).toThrow(
      /Unknown migration template placeholder/
    )
  })
})
