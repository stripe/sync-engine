// Legacy constants kept for backward compatibility parsing
export const STRIPE_SCHEMA_COMMENT_PREFIX = 'stripe-sync'
export const INSTALLATION_STARTED_SUFFIX = 'installation:started'
export const INSTALLATION_ERROR_SUFFIX = 'installation:error'
export const INSTALLATION_INSTALLED_SUFFIX = 'installed'
export const UNINSTALLATION_STARTED_SUFFIX = 'uninstallation:started'
export const UNINSTALLATION_ERROR_SUFFIX = 'uninstallation:error'

/**
 * Installation status for the Supabase schema comment
 */
export type SchemaInstallationStatus =
  | 'installing'
  | 'installed'
  | 'install_error'
  | 'uninstalling'
  | 'uninstalled'
  | 'uninstall_error'

/**
 * Comment structure stored in stripe schema as JSON
 */
export interface StripeSchemaComment {
  /** The installation status */
  status: SchemaInstallationStatus

  /** The old sync engine package version (e.g., '1.2.3'). This is
   * set to the old version being upgraded from.
   */
  oldVersion?: string

  /** The new sync engine package version (e.g., '1.2.3'). This is
   * set to the new version being installed or upgraded to.
   */
  newVersion?: string

  /** Error message if status is install_error or uninstall_error */
  errorMessage?: string
}

/**
 * Parse schema comment - tries JSON first, falls back to legacy plain-text parsing
 */
export function parseSchemaComment(comment: string | null | undefined): StripeSchemaComment {
  if (!comment) return { status: 'uninstalled' }

  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(comment) as StripeSchemaComment
    // Validate it has the required status field
    if (parsed.status) {
      return parsed
    }
  } catch {
    // Not JSON or invalid JSON, fall through to legacy parsing
  }

  // Legacy plain-text parsing for backward compatibility
  if (!comment.includes(STRIPE_SCHEMA_COMMENT_PREFIX)) {
    return { status: 'uninstalled' }
  }

  // Extract version if present (format: "stripe-sync v1.2.3 ..." or "stripe-sync 1.2.3 ...")
  const versionMatch = comment.match(/stripe-sync\s+v?([0-9]+\.[0-9]+\.[0-9]+)/)
  const version = versionMatch?.[1]

  // Determine status from legacy suffixes
  let status: SchemaInstallationStatus
  let errorMessage: string | undefined

  if (comment.includes(UNINSTALLATION_ERROR_SUFFIX)) {
    status = 'uninstall_error'
    // Extract error message after " - "
    const errorMatch = comment.match(/uninstallation:error\s*-\s*(.+)$/)
    errorMessage = errorMatch?.[1]
  } else if (comment.includes(UNINSTALLATION_STARTED_SUFFIX)) {
    status = 'uninstalling'
  } else if (comment.includes(INSTALLATION_ERROR_SUFFIX)) {
    status = 'install_error'
    const errorMatch = comment.match(/installation:error\s*-\s*(.+)$/)
    errorMessage = errorMatch?.[1]
  } else if (comment.includes(INSTALLATION_STARTED_SUFFIX)) {
    status = 'installing'
  } else if (comment.includes(INSTALLATION_INSTALLED_SUFFIX)) {
    status = 'installed'
  } else {
    // Unknown legacy format
    return { status: 'uninstalled' }
  }

  return { status, oldVersion: undefined, newVersion: version, errorMessage }
}
