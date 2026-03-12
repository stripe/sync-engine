import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { DialectAdapter } from './dialectAdapter'
import type { ParsedColumn, ParsedResourceTable, ScalarType } from './types'

const PG_IDENTIFIER_MAX_BYTES = 63

type PostgresAdapterOptions = {
  schemaName?: string
  /** Schema for the sync-owned accounts table (FK target). Defaults to schemaName when not provided. */
  accountSchema?: string
  /** Sync-owned accounts table name used as the FK target. Defaults to _sync_accounts. */
  accountTableName?: string
  materializeTemporalAsText?: boolean
}

export class PostgresAdapter implements DialectAdapter {
  private readonly schemaName: string
  private readonly accountSchema: string
  private readonly accountTableName: string
  private readonly materializeTemporalAsText: boolean

  constructor(options: PostgresAdapterOptions = {}) {
    this.schemaName = options.schemaName ?? 'stripe'
    this.accountSchema = options.accountSchema ?? this.schemaName
    this.accountTableName = options.accountTableName ?? '_sync_accounts'
    this.materializeTemporalAsText = options.materializeTemporalAsText ?? true
  }

  buildAllStatements(tables: ParsedResourceTable[]): string[] {
    return [...tables]
      .sort((a, b) => a.tableName.localeCompare(b.tableName))
      .flatMap((table) => this.buildTableStatements(table))
  }

  buildTableStatements(table: ParsedResourceTable): string[] {
    const quotedSchema = this.quoteIdent(this.schemaName)
    const quotedTable = this.quoteIdent(table.tableName)
    const generatedColumns = table.columns.map((column) => this.buildGeneratedColumn(column))
    const generatedColumnAlters = generatedColumns.map(
      (columnDef) =>
        `ALTER TABLE ${quotedSchema}.${quotedTable} ADD COLUMN IF NOT EXISTS ${columnDef};`
    )
    const columnDefs = [
      '"_raw_data" jsonb NOT NULL',
      '"_last_synced_at" timestamptz',
      '"_updated_at" timestamptz NOT NULL DEFAULT now()',
      '"_account_id" text NOT NULL',
      '"id" text GENERATED ALWAYS AS ((_raw_data->>\'id\')::text) STORED',
      ...generatedColumns,
      'PRIMARY KEY ("id")',
    ]

    const fkName = this.safeIdentifier(`fk_${table.tableName}_account`)
    const accountIdxName = this.safeIdentifier(`idx_${table.tableName}_account_id`)
    const quotedAccountSchema = this.quoteIdent(this.accountSchema)
    const quotedAccountTable = this.quoteIdent(this.accountTableName)

    return [
      `CREATE TABLE ${quotedSchema}.${quotedTable} (\n  ${columnDefs.join(',\n  ')}\n);`,
      ...generatedColumnAlters,
      `ALTER TABLE ${quotedSchema}.${quotedTable} ADD CONSTRAINT ${this.quoteIdent(
        fkName
      )} FOREIGN KEY ("_account_id") REFERENCES ${quotedAccountSchema}.${quotedAccountTable} (id);`,
      `CREATE INDEX ${this.quoteIdent(accountIdxName)} ON ${quotedSchema}.${quotedTable} ("_account_id");`,
      `DROP TRIGGER IF EXISTS handle_updated_at ON ${quotedSchema}.${quotedTable};`,
      `CREATE TRIGGER handle_updated_at BEFORE UPDATE ON ${quotedSchema}.${quotedTable} FOR EACH ROW EXECUTE FUNCTION set_updated_at();`,
    ]
  }

  private buildGeneratedColumn(column: ParsedColumn): string {
    const forceReferenceText = column.expandableReference === true
    const pgType = forceReferenceText ? 'text' : this.pgType(column.type)
    const escapedPath = column.name.replace(/'/g, "''")
    const expression = forceReferenceText
      ? this.buildExpandableReferenceTextExpression(escapedPath)
      : pgType === 'jsonb'
        ? `(_raw_data->'${escapedPath}')::jsonb`
        : pgType === 'text'
          ? `(_raw_data->>'${escapedPath}')::text`
          : `(NULLIF(_raw_data->>'${escapedPath}', ''))::${pgType}`

    return `${this.quoteIdent(column.name)} ${pgType} GENERATED ALWAYS AS (${expression}) STORED`
  }

  private buildExpandableReferenceTextExpression(escapedPath: string): string {
    const jsonPath = `_raw_data->'${escapedPath}'`
    return `CASE
      WHEN jsonb_typeof(${jsonPath}) = 'object' AND ${jsonPath} ? 'id'
        THEN (${jsonPath}->>'id')
      ELSE (_raw_data->>'${escapedPath}')
    END`
  }

  private pgType(type: ScalarType): string {
    if (type === 'timestamptz' && this.materializeTemporalAsText) {
      return 'text'
    }

    switch (type) {
      case 'text':
        return 'text'
      case 'boolean':
        return 'boolean'
      case 'bigint':
        return 'bigint'
      case 'numeric':
        return 'numeric'
      case 'json':
        return 'jsonb'
      case 'timestamptz':
        return 'timestamptz'
    }
  }

  private quoteIdent(value: string): string {
    return `"${value.replaceAll('"', '""')}"`
  }

  private safeIdentifier(name: string): string {
    if (Buffer.byteLength(name) <= PG_IDENTIFIER_MAX_BYTES) {
      return name
    }

    const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
    const suffix = `_h${hash}`
    const maxBaseBytes = PG_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix)
    const truncatedBase = Buffer.from(name).subarray(0, maxBaseBytes).toString('utf8')
    return `${truncatedBase}${suffix}`
  }
}
