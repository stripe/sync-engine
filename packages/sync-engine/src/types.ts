import { type PoolConfig } from 'pg'
import Stripe from 'stripe'
import type { SigmaIngestionConfig } from './sigma/sigmaIngestion'
import type { RevalidateEntityName, SyncObjectName } from './resourceRegistry'

/**
 * Simple logger interface compatible with both pino and console
 */
export interface Logger {
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
  error(message?: unknown, ...optionalParams: unknown[]): void
}

export type RevalidateEntity = RevalidateEntityName

export type StripeSyncConfig = {
  /** @deprecated Use `poolConfig` with a connection string instead. */
  databaseUrl?: string

  /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
  stripeSecretKey: string

  /**
   * Enables syncing Stripe Sigma (reporting) tables via the Sigma API.
   *
   * Default: false (opt-in, so workers don't enqueue Sigma jobs unexpectedly).
   */
  enableSigma?: boolean

  /**
   * Optional override for Sigma page size (per query).
   * Useful for edge function CPU limits; lower values reduce per-invocation work.
   */
  sigmaPageSizeOverride?: number

  /**
   * Postgres schema name for Sigma tables.
   * Default: "sigma"
   */
  sigmaSchemaName?: string

  /**
   * Postgres schema name for core Stripe data tables.
   * Default: "stripe"
   */
  schemaName?: string

  /**
   * Postgres schema name for sync metadata tables (_sync_accounts, _sync_runs, _managed_webhooks, etc.).
   * Defaults to schemaName when not provided.
   */
  syncTablesSchemaName?: string

  /** Stripe account ID. If not provided, will be retrieved from Stripe API. Used as fallback option. */
  stripeAccountId?: string

  /** Optional Stripe partner ID embedded in appInfo for telemetry (e.g. "pp_supabase"). */
  partnerId?: string

  /** Stripe webhook signing secret for validating webhook signatures. Required if not using managed webhooks. */
  stripeWebhookSecret?: string

  /** Stripe API version for the webhooks, defaults to 2020-08-27 */
  stripeApiVersion?: string

  /**
   * Stripe limits related lists like invoice items in an invoice to 10 by default.
   * By enabling this, sync-engine automatically fetches the remaining elements before saving
   * */
  autoExpandLists?: boolean

  /**
   * If true, the sync engine will backfill related entities, i.e. when a invoice webhook comes in, it ensures that the customer is present and synced.
   * This ensures foreign key integrity, but comes at the cost of additional queries to the database (and added latency for Stripe calls if the entity is actually missing).
   */
  backfillRelatedEntities?: boolean

  /**
   * If true, the webhook data is not used and instead the webhook is just a trigger to fetch the entity from Stripe again. This ensures that a race condition with failed webhooks can never accidentally overwrite the data with an older state.
   *
   * Default: false
   */
  revalidateObjectsViaStripeApi?: Array<RevalidateEntity>

  /** @deprecated Use `poolConfig` instead. */
  maxPostgresConnections?: number

  poolConfig?: PoolConfig

  logger?: Logger

  /**
   * Maximum number of customers to process concurrently when syncing payment methods.
   * Lower values reduce API load but increase sync time.
   * Default: 10
   */
  maxConcurrentCustomers?: number
}

export type SyncObject = SyncObjectName

export const SUPPORTED_WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'charge.captured',
  'charge.expired',
  'charge.failed',
  'charge.pending',
  'charge.refunded',
  'charge.succeeded',
  'charge.updated',
  'customer.deleted',
  'customer.created',
  'customer.updated',
  'coupon.created',
  'coupon.deleted',
  'coupon.updated',
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'customer.subscription.trial_will_end',
  'customer.subscription.resumed',
  'customer.subscription.updated',
  'customer.tax_id.updated',
  'customer.tax_id.created',
  'customer.tax_id.deleted',
  'invoice.created',
  'invoice.deleted',
  'invoice.finalized',
  'invoice.finalization_failed',
  'invoice.paid',
  'invoice.payment_action_required',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'invoice.upcoming',
  'invoice.sent',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'invoice.updated',
  'product.created',
  'product.updated',
  'product.deleted',
  'price.created',
  'price.updated',
  'price.deleted',
  'plan.created',
  'plan.updated',
  'plan.deleted',
  'setup_intent.canceled',
  'setup_intent.created',
  'setup_intent.requires_action',
  'setup_intent.setup_failed',
  'setup_intent.succeeded',
  'subscription_schedule.aborted',
  'subscription_schedule.canceled',
  'subscription_schedule.completed',
  'subscription_schedule.created',
  'subscription_schedule.expiring',
  'subscription_schedule.released',
  'subscription_schedule.updated',
  'payment_method.attached',
  'payment_method.automatically_updated',
  'payment_method.detached',
  'payment_method.updated',
  'charge.dispute.created',
  'charge.dispute.funds_reinstated',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'payment_intent.amount_capturable_updated',
  'payment_intent.canceled',
  'payment_intent.created',
  'payment_intent.partially_funded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.succeeded',
  'credit_note.created',
  'credit_note.updated',
  'credit_note.voided',
  'radar.early_fraud_warning.created',
  'radar.early_fraud_warning.updated',
  'refund.created',
  'refund.failed',
  'refund.updated',
  'charge.refund.updated',
  'review.closed',
  'review.opened',
  'entitlements.active_entitlement_summary.updated',
]

export interface Sync {
  synced: number
}

export interface SyncParams {
  created?: {
    /**
     * Minimum value to filter by (exclusive)
     */
    gt?: number

    /**
     * Minimum value to filter by (inclusive)
     */
    gte?: number

    /**
     * Maximum value to filter by (exclusive)
     */
    lt?: number

    /**
     * Maximum value to filter by (inclusive)
     */
    lte?: number
  }
  object?: SyncObject
  backfillRelatedEntities?: boolean
}

export interface SyncEntitlementsParams {
  object: 'entitlements'
  customerId: string
  pagination?: Pick<Stripe.PaginationParams, 'starting_after' | 'ending_before'>
}
export interface SyncFeaturesParams {
  object: 'features'
  pagination?: Pick<Stripe.PaginationParams, 'starting_after' | 'ending_before'>
}

/**
 * Result of processing a single page of items via processNext()
 */
export interface ProcessNextResult {
  /** Number of items processed in this page */
  processed: number
  /** Whether there are more items to process */
  hasMore: boolean
  /** The sync run this processing belongs to */
  runStartedAt: Date
  /** Sigma-only: whether this step started a new Sigma query run */
  startedQuery?: boolean
}

/**
 * Parameters for processNext() including optional run context
 */
export interface ProcessNextParams extends SyncParams {
  /** Join an existing sync run instead of creating a new one */
  runStartedAt?: Date
  /** Who/what triggered this sync (for observability) */
  triggeredBy?: string
}

/**
 * Syncable resource configuration
 */
export type BaseResourceConfig = {
  /** Backfill order: lower numbers sync first; parents before children for FK dependencies */
  order: number
  /** Database table name for this resource (e.g. 'customers', 'invoices') */
  tableName: string
  /** Whether this resource supports incremental sync via 'created' filter or cursor */
  supportsCreatedFilter: boolean
  /** Whether this resource is included in sync runs by default. Default: true */
  sync?: boolean
  /** Resource types that must be backfilled before this one (e.g. price depends on product) */
  dependencies?: readonly string[]
  /** Function to check if an entity is in a final state and doesn't need revalidation */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isFinalState?: (entity: any) => boolean
}

export type StripeListResourceConfig = BaseResourceConfig & {
  /** Function to list items from Stripe API */
  listFn: (params: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam }) => Promise<{
    data: unknown[]
    has_more: boolean
  }>
  /** Function to retrieve a single item by ID from Stripe API */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retrieveFn: (id: string) => Promise<Stripe.Response<any>>
  /** Optional list of sub-resources to expand during upsert/fetching (e.g. 'refunds', 'listLineItems') */
  listExpands?: Record<string, (id: string) => Promise<Stripe.ApiList<{ id?: string }>>>[]
  /** discriminator */
  sigma?: undefined
}

/**
 * Configuration for Sigma query-backed resources.
 * Uses Stripe Sigma SQL queries with composite cursor pagination.
 */
export type SigmaResourceConfig = BaseResourceConfig & {
  /** Sigma uses composite cursors, not created filter */
  supportsCreatedFilter: false
  /** Sigma ingestion configuration (query, cursor spec, upsert options) */
  sigma: SigmaIngestionConfig
  /** discriminator */
  listFn?: undefined
  /** discriminator */
  retrieveFn?: undefined
  /** discriminator */
  listExpands?: Record<string, (id: string) => Promise<Stripe.ApiList<{ id?: string }>>>[]
}

/** Union of all resource configuration types */
export type ResourceConfig = StripeListResourceConfig | SigmaResourceConfig

/**
 * Installation status of the stripe-sync package
 */
export type InstallationStatus = 'not_installed' | 'installing' | 'installed' | 'error'

/**
 * Sync status for a single account (from sync_runs view)
 */
export interface StripeSyncAccountState {
  account_id: string
  started_at: string
  closed_at: string | null
  status: 'pending' | 'running' | 'complete' | 'error'
  error_message: string | null
  total_processed: number
  total_objects: number
  complete_count: number
  error_count: number
  running_count: number
  pending_count: number
  triggered_by: string
  max_concurrent: number
}

/**
 * Response schema for the sync status endpoint
 */
export interface StripeSyncState {
  package_version: string
  installation_status: InstallationStatus
  sync_status: StripeSyncAccountState[]
}
