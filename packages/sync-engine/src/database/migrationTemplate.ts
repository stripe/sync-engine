const PLACEHOLDER_PATTERN = /\{\{[a-z_]+\}\}/g

export const SYNC_SCHEMA_PLACEHOLDER = '{{sync_schema}}'

type MigrationTemplateContext = {
  syncSchema: string
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * Render bootstrap SQL from a tiny, explicit template language.
 *
 * We intentionally do not use a general-purpose template engine here:
 * the bootstrap migration only needs a small, auditable set of schema placeholders,
 * and unknown placeholders should fail fast rather than render silently.
 */
export function renderMigrationTemplate(sql: string, context: MigrationTemplateContext): string {
  const rendered = sql.replaceAll(SYNC_SCHEMA_PLACEHOLDER, quoteIdentifier(context.syncSchema))
  const unresolvedPlaceholders = [...new Set(rendered.match(PLACEHOLDER_PATTERN) ?? [])]
  if (unresolvedPlaceholders.length > 0) {
    throw new Error(
      `Unknown migration template placeholder(s): ${unresolvedPlaceholders.join(', ')}`
    )
  }
  return rendered
}
