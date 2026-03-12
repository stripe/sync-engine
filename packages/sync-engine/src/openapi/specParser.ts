import type {
  OpenApiSchemaObject,
  OpenApiSchemaOrReference,
  OpenApiSpec,
  ParseSpecOptions,
  ParsedColumn,
  ParsedOpenApiSpec,
  ScalarType,
} from './types'
import { RUNTIME_REQUIRED_TABLES as DEFAULT_RUNTIME_REQUIRED_TABLES } from '../resourceRegistry'
import {
  OPENAPI_COMPATIBILITY_COLUMNS,
  OPENAPI_RESOURCE_TABLE_ALIASES as DEFAULT_OPENAPI_RESOURCE_TABLE_ALIASES,
} from './runtimeMappings'

const RESERVED_COLUMNS = new Set([
  'id',
  '_raw_data',
  '_last_synced_at',
  '_updated_at',
  '_account_id',
])

export const RUNTIME_REQUIRED_TABLES = DEFAULT_RUNTIME_REQUIRED_TABLES

export const OPENAPI_RESOURCE_TABLE_ALIASES = DEFAULT_OPENAPI_RESOURCE_TABLE_ALIASES
/** Backward-compatible alias for runtime resource table mappings. */
export const RUNTIME_RESOURCE_ALIASES = OPENAPI_RESOURCE_TABLE_ALIASES

type ColumnAccumulator = {
  type: ScalarType
  nullable: boolean
  expandableReference: boolean
}

export class SpecParser {
  parse(spec: OpenApiSpec, options: ParseSpecOptions = {}): ParsedOpenApiSpec {
    const schemas = spec.components?.schemas
    if (!schemas || typeof schemas !== 'object') {
      throw new Error('OpenAPI spec is missing components.schemas')
    }

    const aliases = { ...OPENAPI_RESOURCE_TABLE_ALIASES, ...(options.resourceAliases ?? {}) }
    const allowedTables = options.allowedTables ? new Set(options.allowedTables) : null
    const tableMap = new Map<
      string,
      {
        resourceId: string
        sourceSchemaName: string
        columns: Map<string, ColumnAccumulator>
      }
    >()

    for (const schemaName of Object.keys(schemas).sort((a, b) => a.localeCompare(b))) {
      const schema = this.resolveSchema({ $ref: `#/components/schemas/${schemaName}` }, spec)
      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') {
        continue
      }

      const tableName = this.resolveTableName(resourceId, aliases)
      if (allowedTables && !allowedTables.has(tableName)) {
        continue
      }

      const propCandidates = this.collectPropertyCandidates(
        { $ref: `#/components/schemas/${schemaName}` },
        spec
      )
      const parsedColumns = this.parseColumns(propCandidates, spec)

      const existing =
        tableMap.get(tableName) ??
        ({
          resourceId,
          sourceSchemaName: schemaName,
          columns: new Map<string, ColumnAccumulator>(),
        } as const)

      for (const column of parsedColumns) {
        const current = existing.columns.get(column.name)
        if (!current) {
          existing.columns.set(column.name, {
            type: column.type,
            nullable: column.nullable,
            expandableReference: column.expandableReference ?? false,
          })
          continue
        }
        existing.columns.set(column.name, {
          type: this.mergeTypes(current.type, column.type),
          nullable: current.nullable || column.nullable,
          expandableReference: current.expandableReference || (column.expandableReference ?? false),
        })
      }

      tableMap.set(tableName, existing)
    }

    const compatibilityTableNames = allowedTables
      ? Array.from(allowedTables)
      : Array.from(tableMap.keys())

    for (const tableName of compatibilityTableNames.sort((a, b) => a.localeCompare(b))) {
      const current =
        tableMap.get(tableName) ??
        ({
          resourceId: tableName,
          sourceSchemaName: 'compatibility_fallback',
          columns: new Map<string, ColumnAccumulator>(),
        } as const)
      for (const compatibilityColumn of OPENAPI_COMPATIBILITY_COLUMNS[tableName] ?? []) {
        const existing = current.columns.get(compatibilityColumn.name)
        if (!existing) {
          current.columns.set(compatibilityColumn.name, {
            type: compatibilityColumn.type,
            nullable: compatibilityColumn.nullable,
            expandableReference: compatibilityColumn.expandableReference ?? false,
          })
        }
      }
      tableMap.set(tableName, current)
    }

    const tables = Array.from(tableMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, table]) => ({
        tableName,
        resourceId: table.resourceId,
        sourceSchemaName: table.sourceSchemaName,
        columns: Array.from(table.columns.entries())
          .map(([name, value]) => ({
            name,
            type: value.type,
            nullable: value.nullable,
            ...(value.expandableReference ? { expandableReference: true } : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))

    return {
      apiVersion: spec.info?.version ?? spec.openapi ?? 'unknown',
      tables,
    }
  }

  private resolveTableName(resourceId: string, aliases: Record<string, string>): string {
    const alias = aliases[resourceId]
    if (alias) {
      return alias
    }

    const normalized = resourceId.toLowerCase().replace(/[.]/g, '_')
    return normalized.endsWith('s') ? normalized : `${normalized}s`
  }

  private parseColumns(
    propCandidates: Map<string, OpenApiSchemaOrReference[]>,
    spec: OpenApiSpec
  ): ParsedColumn[] {
    const columns: ParsedColumn[] = []
    for (const [propertyName, candidates] of Array.from(propCandidates.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (RESERVED_COLUMNS.has(propertyName)) {
        continue
      }
      const inferred = this.inferFromCandidates(candidates, spec)
      columns.push({
        name: propertyName,
        type: inferred.type,
        nullable: inferred.nullable,
        ...(inferred.expandableReference ? { expandableReference: true } : {}),
      })
    }
    return columns
  }

  private inferFromCandidates(
    candidates: OpenApiSchemaOrReference[],
    spec: OpenApiSpec
  ): { type: ScalarType; nullable: boolean; expandableReference: boolean } {
    if (candidates.length === 0) {
      return { type: 'text', nullable: true, expandableReference: false }
    }

    let mergedType: ScalarType | null = null
    let nullable = false
    let expandableReference = false
    for (const candidate of candidates) {
      const inferred = this.inferType(candidate, spec)
      mergedType = mergedType ? this.mergeTypes(mergedType, inferred.type) : inferred.type
      nullable = nullable || inferred.nullable
      expandableReference =
        expandableReference || this.isExpandableReferenceCandidate(candidate, spec)
    }

    return { type: mergedType ?? 'text', nullable, expandableReference }
  }

  private mergeTypes(left: ScalarType, right: ScalarType): ScalarType {
    if (left === right) return left
    if (left === 'json' || right === 'json') return 'json'
    if ((left === 'numeric' && right === 'bigint') || (left === 'bigint' && right === 'numeric')) {
      return 'numeric'
    }
    if (left === 'timestamptz' && right === 'text') return 'text'
    if (left === 'text' && right === 'timestamptz') return 'text'
    return 'text'
  }

  private inferType(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): { type: ScalarType; nullable: boolean } {
    const schema = this.resolveSchema(schemaOrRef, spec)
    const nullable = Boolean(schema.nullable)

    if (schema.oneOf?.length) {
      const merged = this.inferFromCandidates(schema.oneOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }
    if (schema.anyOf?.length) {
      const merged = this.inferFromCandidates(schema.anyOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }
    if (schema.allOf?.length) {
      const merged = this.inferFromCandidates(schema.allOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }

    if (schema.type === 'boolean') return { type: 'boolean', nullable }
    if (schema.type === 'integer') return { type: 'bigint', nullable }
    if (schema.type === 'number') return { type: 'numeric', nullable }
    if (schema.type === 'string') {
      if (schema.format === 'date-time') {
        return { type: 'timestamptz', nullable }
      }
      return { type: 'text', nullable }
    }
    if (schema.type === 'array') return { type: 'json', nullable }
    if (schema.type === 'object') return { type: 'json', nullable }
    if (schema.properties || schema.additionalProperties) return { type: 'json', nullable }

    if (schema.enum && schema.enum.length > 0) {
      const values = schema.enum
      if (values.every((value) => typeof value === 'boolean')) {
        return { type: 'boolean', nullable }
      }
      if (values.every((value) => typeof value === 'number' && Number.isInteger(value))) {
        return { type: 'bigint', nullable }
      }
      if (values.every((value) => typeof value === 'number')) {
        return { type: 'numeric', nullable }
      }
    }

    return { type: 'text', nullable: true }
  }

  private isExpandableReferenceCandidate(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): boolean {
    const schema = this.resolveSchema(schemaOrRef, spec)
    return Boolean(schema['x-expansionResources'])
  }

  private collectPropertyCandidates(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Map<string, OpenApiSchemaOrReference[]> {
    if (this.isReference(schemaOrRef)) {
      if (seenRefs.has(schemaOrRef.$ref)) {
        return new Map()
      }
      seenRefs.add(schemaOrRef.$ref)
    }

    const schema = this.resolveSchema(schemaOrRef, spec)
    if (seenSchemas.has(schema)) {
      return new Map()
    }
    seenSchemas.add(schema)

    const merged = new Map<string, OpenApiSchemaOrReference[]>()
    const pushProp = (name: string, value: OpenApiSchemaOrReference) => {
      const existing = merged.get(name) ?? []
      existing.push(value)
      merged.set(name, existing)
    }

    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      pushProp(name, value)
    }

    for (const composed of [schema.allOf, schema.oneOf, schema.anyOf]) {
      if (!composed) continue
      for (const subSchema of composed) {
        const subProps = this.collectPropertyCandidates(subSchema, spec, seenRefs, seenSchemas)
        for (const [name, candidates] of subProps.entries()) {
          for (const candidate of candidates) {
            pushProp(name, candidate)
          }
        }
      }
    }

    return merged
  }

  private resolveSchema(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): OpenApiSchemaObject {
    if (!this.isReference(schemaOrRef)) {
      return schemaOrRef
    }

    const prefix = '#/components/schemas/'
    if (!schemaOrRef.$ref.startsWith(prefix)) {
      throw new Error(`Unsupported OpenAPI reference: ${schemaOrRef.$ref}`)
    }
    const schemaName = schemaOrRef.$ref.slice(prefix.length)
    const resolved = spec.components?.schemas?.[schemaName]
    if (!resolved) {
      throw new Error(`Failed to resolve OpenAPI schema reference: ${schemaOrRef.$ref}`)
    }
    if (this.isReference(resolved)) {
      return this.resolveSchema(resolved, spec)
    }
    return resolved
  }

  private isReference(schemaOrRef: OpenApiSchemaOrReference): schemaOrRef is { $ref: string } {
    return typeof (schemaOrRef as { $ref?: string }).$ref === 'string'
  }
}
