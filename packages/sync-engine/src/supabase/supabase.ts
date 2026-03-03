import { SupabaseManagementAPI } from 'supabase-management-js'
import {
  setupFunctionCode,
  webhookFunctionCode,
  workerFunctionCode,
  sigmaWorkerFunctionCode,
} from './edge-function-code'
import pkg from '../../package.json' with { type: 'json' }
import { parseSchemaComment, SchemaInstallationStatus, StripeSchemaComment } from './schemaComment'

export interface DeployClientOptions {
  accessToken: string
  projectRef: string
  projectBaseUrl?: string
  supabaseManagementUrl?: string
}

export interface ProjectInfo {
  id: string
  name: string
  region: string
}

export class SupabaseSetupClient {
  api: SupabaseManagementAPI
  private projectRef: string
  private projectBaseUrl: string
  private supabaseManagementUrl?: string
  private accessToken: string
  private workerSecret: string

  constructor(options: DeployClientOptions) {
    this.api = new SupabaseManagementAPI({
      accessToken: options.accessToken,
      baseUrl: options.supabaseManagementUrl,
    })
    this.projectRef = options.projectRef
    this.projectBaseUrl = options.projectBaseUrl || process.env.SUPABASE_BASE_URL || 'supabase.co'
    this.supabaseManagementUrl = options.supabaseManagementUrl
    this.accessToken = options.accessToken
    this.workerSecret = crypto.randomUUID()
  }

  /**
   * Validate that the project exists and we have access.
   * Fetches the project directly by ref instead of listing all projects,
   * because some org-level tokens lack the list-all permission.
   */
  async validateProject(): Promise<ProjectInfo> {
    const baseUrl = this.supabaseManagementUrl || 'https://api.supabase.com'
    const response = await fetch(`${baseUrl}/v1/projects/${this.projectRef}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Project ${this.projectRef} not found or you don't have access (${response.status}: ${body})`
      )
    }
    const project = await response.json()
    return {
      id: project.ref,
      name: project.name,
      region: project.region,
    }
  }

  /**
   * Deploy an Edge Function
   */
  async deployFunction(name: string, code: string, verifyJwt = false): Promise<void> {
    // Create or update function
    await this.api.deployAFunction(
      this.projectRef,
      {
        file: [
          new File([code], 'index.ts', { type: 'application/typescript' }),
        ] as unknown as string[],
        metadata: {
          entrypoint_path: 'index.ts',
          verify_jwt: verifyJwt,
          name,
        },
      },
      {
        slug: name,
      }
    )
  }

  /**
   * Inject package version into Edge Function code
   */
  private injectPackageVersion(code: string, version: string): string {
    if (version === 'latest') {
      return code
    }
    // Replace unversioned npm imports with versioned ones
    return code.replace(
      /from ['"]npm:stripe-experiment-sync['"]/g,
      `from 'npm:stripe-experiment-sync@${version}'`
    )
  }

  /**
   * Set secrets for Edge Functions
   */
  async setSecrets(secrets: { name: string; value: string }[]): Promise<void> {
    await this.api.bulkCreateSecrets(this.projectRef, secrets)
  }

  /**
   * Run SQL against the database
   */
  async runSQL(sql: string): Promise<unknown> {
    const { data } = await this.api.runAQuery(this.projectRef, {
      query: sql,
    })
    return data
  }

  /**
   * Setup pg_cron job to invoke worker function
   * @param intervalSeconds - How often to run the worker (default: 60 seconds)
   */
  async setupPgCronJob(intervalSeconds: number = 60): Promise<void> {
    // Validate interval
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
      throw new Error(`Invalid interval: ${intervalSeconds}. Must be a positive integer.`)
    }

    // Convert interval to pg_cron schedule format
    // pg_cron supports two formats:
    // 1. Interval format: '[1-59] seconds' (only for 1-59 seconds)
    // 2. Cron format: '*/N * * * *' (for minutes and longer)
    let schedule: string
    if (intervalSeconds < 60) {
      // Use interval format for sub-minute intervals
      schedule = `${intervalSeconds} seconds`
    } else if (intervalSeconds % 60 === 0) {
      // Convert to minutes for intervals divisible by 60
      const minutes = intervalSeconds / 60
      if (minutes < 60) {
        // Use cron format for minute-based intervals
        schedule = `*/${minutes} * * * *`
      } else {
        throw new Error(
          `Invalid interval: ${intervalSeconds}. Intervals >= 3600 seconds (1 hour) are not supported. Use a value between 1-3599 seconds.`
        )
      }
    } else {
      throw new Error(
        `Invalid interval: ${intervalSeconds}. Must be either 1-59 seconds or a multiple of 60 (e.g., 60, 120, 180).`
      )
    }

    // Escape single quotes to prevent SQL injection
    const escapedWorkerSecret = this.workerSecret.replace(/'/g, "''")

    const sql = `
      -- Enable extensions
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE EXTENSION IF NOT EXISTS pg_net;
      CREATE EXTENSION IF NOT EXISTS pgmq;

      -- Create pgmq queue for sync work (idempotent)
      SELECT pgmq.create('stripe_sync_work')
      WHERE NOT EXISTS (
        SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'stripe_sync_work'
      );

      -- Store unique worker secret in vault for pg_cron to use
      -- Delete existing secret if it exists, then create new one
      DELETE FROM vault.secrets WHERE name = 'stripe_sync_worker_secret';
      SELECT vault.create_secret('${escapedWorkerSecret}', 'stripe_sync_worker_secret');

      -- Delete existing jobs if they exist
      SELECT cron.unschedule('stripe-sync-worker') WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker'
      );
      SELECT cron.unschedule('stripe-sync-scheduler') WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-scheduler'
      );

      -- Create job to invoke worker at configured interval
      -- Worker reads from pgmq, enqueues objects if empty, and processes sync work
      SELECT cron.schedule(
        'stripe-sync-worker',
        '${schedule}',
        $$
        SELECT net.http_post(
          url := 'https://${this.projectRef}.${this.projectBaseUrl}/functions/v1/stripe-worker',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sync_worker_secret')
          )
        )
        WHERE NOT EXISTS (
          SELECT 1 FROM vault.decrypted_secrets
          WHERE name = 'stripe_sync_skip_until'
            AND decrypted_secret::timestamptz > NOW()
        )
        $$
      );
    `
    await this.runSQL(sql)
  }

  /**
   * Setup pg_cron job for Sigma data worker (every 12 hours)
   * Creates secret, self-trigger function, and cron job
   */
  async setupSigmaPgCronJob(): Promise<void> {
    // Generate a unique secret for sigma-data-worker authentication
    const sigmaWorkerSecret = crypto.randomUUID()
    const escapedSigmaWorkerSecret = sigmaWorkerSecret.replace(/'/g, "''")

    const sql = `
      -- Enable extensions
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE EXTENSION IF NOT EXISTS pg_net;

      -- Store unique sigma worker secret in vault
      DELETE FROM vault.secrets WHERE name = 'stripe_sigma_worker_secret';
      SELECT vault.create_secret('${escapedSigmaWorkerSecret}', 'stripe_sigma_worker_secret');

      -- Create self-trigger function for sigma worker continuation
      -- This allows the worker to trigger itself when there's more work
      CREATE OR REPLACE FUNCTION stripe.trigger_sigma_worker()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        PERFORM net.http_post(
          url := 'https://${this.projectRef}.${this.projectBaseUrl}/functions/v1/sigma-data-worker',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sigma_worker_secret')
          )
        );
      END;
      $$;

      -- Delete existing sigma job if it exists
      SELECT cron.unschedule('stripe-sigma-worker') WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'stripe-sigma-worker'
      );

      -- Create cron job for Sigma sync
      -- Runs at 00:00 and 12:00 UTC
      SELECT cron.schedule(
        'stripe-sigma-worker',
        '0 */12 * * *',
        $$
        SELECT net.http_post(
          url := 'https://${this.projectRef}.${this.projectBaseUrl}/functions/v1/sigma-data-worker',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sigma_worker_secret')
          )
        )
        $$
      );
    `
    await this.runSQL(sql)
  }

  /**
   * Get the webhook URL for this project
   */
  getWebhookUrl(): string {
    return `https://${this.projectRef}.${this.projectBaseUrl}/functions/v1/stripe-webhook`
  }

  /**
   * Get the anon key for this project (needed for Realtime subscriptions)
   */
  async getAnonKey(): Promise<string | null | undefined> {
    const { data: apiKeys } = await this.api.getProjectApiKeys(this.projectRef)
    const anonKey = apiKeys?.find((k) => k.name === 'anon')
    if (!anonKey) {
      throw new Error('Could not find anon API key')
    }
    return anonKey.api_key
  }

  /**
   * Get the project URL
   */
  getProjectUrl(): string {
    return `https://${this.projectRef}.${this.projectBaseUrl}`
  }

  /**
   * Invoke an Edge Function
   */
  async invokeFunction(
    slug: string,
    method: string,
    bearerToken: string
  ): Promise<{ success: boolean; error?: string }> {
    const url = `https://${this.projectRef}.${this.projectBaseUrl}/functions/v1/${slug}`
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `${response.status}: ${text}` }
    }

    const result = (await response.json()) as { success?: boolean; error?: string }
    if (result.success === false) {
      return { success: false, error: result.error }
    }

    return { success: true }
  }

  /**
   * Check if a schema exists in the database
   * @param schema The schema name to check (defaults to 'stripe')
   * @returns true if schema exists, false otherwise
   */
  private async schemaExists(schema = 'stripe'): Promise<boolean> {
    try {
      const schemaCheck = (await this.runSQL(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata
          WHERE schema_name = '${schema}'
        ) as schema_exists`
      )) as { schema_exists: boolean }[]

      return schemaCheck[0].schema_exists === true
    } catch {
      // Return false if query fails
      return false
    }
  }

  /**
   * Reads and parses comment from a schema
   * @param schema schema to read comment from
   * @returns parsed comment or null if either schema or the comment doesn't exist
   */
  private async readAndParseComment(schema = 'stripe'): Promise<StripeSchemaComment | null> {
    const schemaExistsResult = await this.schemaExists(schema)

    if (!schemaExistsResult) {
      return null
    }

    const commentCheck = (await this.runSQL(
      `SELECT obj_description(oid, 'pg_namespace') as comment
         FROM pg_namespace
         WHERE nspname = '${schema}'`
    )) as { comment: string | null }[]

    const comment = commentCheck[0]?.comment ?? null
    const parsedComment = parseSchemaComment(comment)
    return parsedComment
  }

  /**
   * Check if stripe-sync is installed in the database.
   *
   * Uses the Supabase Management API to run SQL queries.
   * Uses duck typing (schema + migrations table) combined with comment validation.
   * Throws error for legacy installations to prevent accidental corruption.
   *
   * @param schema The schema name to check (defaults to 'stripe')
   * @returns true if properly installed with comment marker, false if not installed
   * @throws Error if legacy installation detected (schema exists without comment)
   */
  async isInstalled(schema = 'stripe'): Promise<boolean> {
    try {
      // Check if migrations table exists (either old 'migrations' or new '_migrations')
      const migrationsCheck = (await this.runSQL(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = '${schema}' AND table_name IN ('migrations', '_migrations')
        ) as table_exists`
      )) as { table_exists: boolean }[]

      const migrationsTableExists = migrationsCheck[0].table_exists === true

      if (!migrationsTableExists) {
        // Schema exists but no migrations table - incomplete/manual installation
        return false
      }

      const parsedComment = await this.readAndParseComment()

      if (!parsedComment) {
        // Schema doesn't exist - not installed
        return false
      }

      // If schema + migrations table exist but no valid comment, throw error (legacy installation)
      if (parsedComment.status === 'uninstalled') {
        throw new Error(
          `Legacy installation detected: Schema '${schema}' and migrations table exist, but missing stripe-sync comment marker. ` +
            `This may be a legacy installation or manually created schema. ` +
            `Please contact support or manually drop the schema before proceeding.`
        )
      }

      // Check for uninstallation in progress
      if (parsedComment.status === 'uninstalling') {
        return false
      }

      // Check for failed uninstallation (requires manual intervention)
      if (parsedComment.status === 'uninstall_error') {
        throw new Error(
          `Uninstallation failed: Schema '${schema}' exists but uninstallation encountered an error. ` +
            `${parsedComment.errorMessage ? `Error: ${parsedComment.errorMessage}` : ''}. Manual cleanup may be required.`
        )
      }

      // Check for incomplete installation (can retry)
      if (parsedComment.status === 'installing') {
        return false
      }

      // Check for failed installation (requires manual intervention)
      if (parsedComment.status === 'install_error') {
        throw new Error(
          `Installation failed: Schema '${schema}' exists but installation encountered an error. ` +
            `${parsedComment.errorMessage ? `Error: ${parsedComment.errorMessage}` : ''}. Please uninstall and install again.`
        )
      }

      // All checks passed
      return true
    } catch (error) {
      // Re-throw our custom errors
      if (
        error instanceof Error &&
        (error.message.includes('Legacy installation detected') ||
          error.message.includes('Installation failed') ||
          error.message.includes('Uninstallation failed'))
      ) {
        throw error
      }
      // Other errors return false
      return false
    }
  }

  /**
   * Update installation progress comment on the stripe schema
   */
  async updateComment(
    status: SchemaInstallationStatus,
    oldVersion?: string,
    errorMessage?: string
  ): Promise<void> {
    const comment = JSON.stringify({
      status,
      newVersion: pkg.version,
      oldVersion,
      errorMessage,
    })
    // Escape single quotes to prevent SQL injection
    const escapedComment = comment.replace(/'/g, "''")
    await this.runSQL(`COMMENT ON SCHEMA stripe IS '${escapedComment}'`)
  }

  /**
   * Uninstall stripe-sync from a Supabase project
   * Invokes the stripe-setup edge function's DELETE endpoint which handles cleanup
   * Tracks uninstallation progress via schema comments
   */
  async uninstall(): Promise<void> {
    try {
      // Check if schema exists and mark uninstall as started
      const hasSchema = await this.schemaExists('stripe')
      if (hasSchema) {
        await this.updateComment('uninstalling')
      }

      // Invoke the DELETE endpoint on stripe-setup function
      // Use accessToken in Authorization header for Management API validation
      const setupResult = await this.invokeFunction('stripe-setup', 'DELETE', this.accessToken)

      if (!setupResult.success) {
        throw new Error(`Uninstall failed: ${setupResult.error}`)
      }
      // On success, schema is dropped by edge function (no comment update needed)
    } catch (error) {
      // Mark schema with error if it still exists
      try {
        const hasSchema = await this.schemaExists('stripe')
        if (hasSchema) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          await this.updateComment('uninstall_error', undefined, errorMessage)
        }
      } catch (error) {
        throw new Error(
          `Uninstall failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      throw new Error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async install(
    stripeKey: string,
    packageVersion?: string,
    workerIntervalSeconds?: number,
    enableSigma?: boolean,
    rateLimit?: number,
    syncIntervalSeconds?: number
  ): Promise<void> {
    const trimmedStripeKey = stripeKey.trim()
    if (!trimmedStripeKey.startsWith('sk_') && !trimmedStripeKey.startsWith('rk_')) {
      throw new Error('Stripe key should start with "sk_" or "rk_"')
    }

    // Default to 'latest' if no version specified
    const version = packageVersion || 'latest'

    try {
      // Validate project
      await this.validateProject()

      // Create schema if it doesn't exist (before we can comment on it)
      await this.runSQL(`CREATE SCHEMA IF NOT EXISTS stripe`)

      const existingComment = await this.readAndParseComment()
      // new version now becomes the old version and the current package version
      // will become the new version (upgrade scenrio)
      const oldVersion = existingComment?.newVersion

      // Signal installation started
      await this.updateComment('installing', oldVersion)

      // Set secrets first -- stripe-setup needs STRIPE_SECRET_KEY to run
      const secrets = [{ name: 'STRIPE_SECRET_KEY', value: trimmedStripeKey }]
      if (this.supabaseManagementUrl) {
        secrets.push({ name: 'MANAGEMENT_API_URL', value: this.supabaseManagementUrl })
      }
      if (enableSigma) {
        secrets.push({ name: 'ENABLE_SIGMA', value: 'true' })
      }
      if (rateLimit != null) {
        secrets.push({ name: 'RATE_LIMIT', value: String(rateLimit) })
      }
      if (syncIntervalSeconds != null) {
        secrets.push({ name: 'SYNC_INTERVAL', value: String(syncIntervalSeconds) })
      }
      await this.setSecrets(secrets)

      const versionedSetup = this.injectPackageVersion(setupFunctionCode, version)
      await this.deployFunction('stripe-setup', versionedSetup, false)

      // Run setup (migrations + webhook creation)
      // Use accessToken for Management API validation
      const setupResult = await this.invokeFunction('stripe-setup', 'POST', this.accessToken)

      if (!setupResult.success) {
        throw new Error(`Setup failed: ${setupResult.error}`)
      }

      // Now deploy the remaining edge functions -- schema is ready
      const versionedWebhook = this.injectPackageVersion(webhookFunctionCode, version)
      const versionedWorker = this.injectPackageVersion(workerFunctionCode, version)

      await this.deployFunction('stripe-webhook', versionedWebhook, false)
      await this.deployFunction('stripe-worker', versionedWorker, false)

      if (enableSigma) {
        const versionedSigmaWorker = this.injectPackageVersion(sigmaWorkerFunctionCode, version)
        await this.deployFunction('sigma-data-worker', versionedSigmaWorker, false)
      }

      // Setup pg_cron - this is required for automatic syncing
      await this.setupPgCronJob(workerIntervalSeconds)

      // Setup Sigma pg_cron only if enabled - dedicated 12-hourly worker for Sigma data
      if (enableSigma) {
        await this.setupSigmaPgCronJob()
      }

      // Invoke stripe-worker immediately to trigger first sync for better UX on Supabase
      // dashboard. We want to see the first sync run immediately after an installation.
      await this.invokeFunction('stripe-worker', 'POST', this.workerSecret)

      // Set final version comment
      await this.updateComment('installed', oldVersion)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      try {
        await this.updateComment('install_error', undefined, errorMessage)
      } catch {
        // Schema may not exist if early steps failed -- don't mask the original error
      }
      throw error
    }
  }
}

export async function install(params: {
  supabaseAccessToken: string
  supabaseProjectRef: string
  stripeKey: string
  packageVersion?: string
  workerIntervalSeconds?: number
  baseProjectUrl?: string
  supabaseManagementUrl?: string
  enableSigma?: boolean
  rateLimit?: number
  syncIntervalSeconds?: number
}): Promise<void> {
  const {
    supabaseAccessToken,
    supabaseProjectRef,
    stripeKey,
    packageVersion,
    workerIntervalSeconds,
    enableSigma,
    rateLimit,
    syncIntervalSeconds,
  } = params

  const client = new SupabaseSetupClient({
    accessToken: supabaseAccessToken,
    projectRef: supabaseProjectRef,
    projectBaseUrl: params.baseProjectUrl,
    supabaseManagementUrl: params.supabaseManagementUrl,
  })

  await client.install(
    stripeKey,
    packageVersion,
    workerIntervalSeconds,
    enableSigma,
    rateLimit,
    syncIntervalSeconds
  )
}

export async function uninstall(params: {
  supabaseAccessToken: string
  supabaseProjectRef: string
  baseProjectUrl?: string
  supabaseManagementUrl?: string
}): Promise<void> {
  const { supabaseAccessToken, supabaseProjectRef } = params

  const client = new SupabaseSetupClient({
    accessToken: supabaseAccessToken,
    projectRef: supabaseProjectRef,
    projectBaseUrl: params.baseProjectUrl,
    supabaseManagementUrl: params.supabaseManagementUrl,
  })

  await client.uninstall()
}

export function getCurrentVersion(): string {
  return pkg.version
}
