import Stripe from 'stripe'
import type { ResourceConfig } from './types'
import type { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import { computeResourceOrder } from './utils/computeResourceOrder'

export type StripeObject =
  | 'product'
  | 'price'
  | 'plan'
  | 'customer'
  | 'subscription'
  | 'subscription_schedules'
  | 'invoice'
  | 'charge'
  | 'setup_intent'
  | 'payment_method'
  | 'payment_intent'
  | 'tax_id'
  | 'credit_note'
  | 'dispute'
  | 'early_fraud_warning'
  | 'refund'
  | 'checkout_sessions'
  | 'active_entitlements'
  | 'review'

// Resource registry - maps SyncObject → list/retrieve operations
// Upsert is handled universally via StripeSync.upsertAny()
// Order field [computed] determines sync sequence - parents before children for FK dependencies
export function buildResourceRegistry(stripe: Stripe): Record<StripeObject, ResourceConfig> {
  const core: Record<StripeObject, Omit<ResourceConfig, 'order'>> = {
    product: {
      tableName: 'products',
      dependencies: [],
      listFn: (p) => stripe.products.list(p),
      retrieveFn: (id) => stripe.products.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
    },
    price: {
      tableName: 'prices',
      dependencies: ['product'],
      listFn: (p) => stripe.prices.list(p),
      retrieveFn: (id) => stripe.prices.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
    },
    plan: {
      tableName: 'plans',
      dependencies: ['product'],
      listFn: (p) => stripe.plans.list(p),
      retrieveFn: (id) => stripe.plans.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
    },
    customer: {
      tableName: 'customers',
      dependencies: [],
      listFn: (p) => stripe.customers.list(p),
      retrieveFn: (id) => stripe.customers.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (customer: Stripe.Customer | Stripe.DeletedCustomer) =>
        'deleted' in customer && customer.deleted === true,
    },
    subscription: {
      tableName: 'subscriptions',
      dependencies: ['customer', 'price'],
      listFn: (p) => stripe.subscriptions.list(p),
      retrieveFn: (id) => stripe.subscriptions.retrieve(id),
      listExpands: [
        { items: (id) => stripe.subscriptionItems.list({ subscription: id, limit: 100 }) },
      ],
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (subscription: Stripe.Subscription) =>
        subscription.status === 'canceled' || subscription.status === 'incomplete_expired',
    },
    subscription_schedules: {
      tableName: 'subscription_schedules',
      dependencies: ['customer'],
      listFn: (p) => stripe.subscriptionSchedules.list(p),
      retrieveFn: (id) => stripe.subscriptionSchedules.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (schedule: Stripe.SubscriptionSchedule) =>
        schedule.status === 'canceled' || schedule.status === 'completed',
    },
    invoice: {
      tableName: 'invoices',
      dependencies: ['customer', 'subscription'],
      listFn: (p) => stripe.invoices.list(p),
      retrieveFn: (id) => stripe.invoices.retrieve(id),
      listExpands: [{ lines: (id) => stripe.invoices.listLineItems(id, { limit: 100 }) }],
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (invoice: Stripe.Invoice) => invoice.status === 'void',
    },
    charge: {
      tableName: 'charges',
      dependencies: ['customer', 'invoice'],
      listFn: (p) => stripe.charges.list(p),
      retrieveFn: (id) => stripe.charges.retrieve(id),
      listExpands: [{ refunds: (id) => stripe.refunds.list({ charge: id, limit: 100 }) }],
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (charge: Stripe.Charge) =>
        charge.status === 'failed' || charge.status === 'succeeded',
    },
    setup_intent: {
      tableName: 'setup_intents',
      dependencies: ['customer'],
      listFn: (p) => stripe.setupIntents.list(p),
      retrieveFn: (id) => stripe.setupIntents.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (setupIntent: Stripe.SetupIntent) =>
        setupIntent.status === 'canceled' || setupIntent.status === 'succeeded',
    },
    payment_method: {
      tableName: 'payment_methods',
      dependencies: ['customer'],
      listFn: (p) => stripe.paymentMethods.list(p),
      retrieveFn: (id) => stripe.paymentMethods.retrieve(id),
      supportsCreatedFilter: false,
      sync: true,
    },
    payment_intent: {
      tableName: 'payment_intents',
      dependencies: ['customer', 'invoice'],
      listFn: (p) => stripe.paymentIntents.list(p),
      retrieveFn: (id) => stripe.paymentIntents.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (paymentIntent: Stripe.PaymentIntent) =>
        paymentIntent.status === 'canceled' || paymentIntent.status === 'succeeded',
    },
    tax_id: {
      tableName: 'tax_ids',
      dependencies: ['customer'],
      listFn: (p) => stripe.taxIds.list(p),
      retrieveFn: (id) => stripe.taxIds.retrieve(id),
      supportsCreatedFilter: false,
      sync: true,
    },
    credit_note: {
      tableName: 'credit_notes',
      dependencies: ['customer', 'invoice'],
      listFn: (p) => stripe.creditNotes.list(p),
      retrieveFn: (id) => stripe.creditNotes.retrieve(id),
      listExpands: [{ lines: (id) => stripe.creditNotes.listLineItems(id, { limit: 100 }) }],
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (creditNote: Stripe.CreditNote) => creditNote.status === 'void',
    },
    dispute: {
      tableName: 'disputes',
      dependencies: ['charge'],
      listFn: (p) => stripe.disputes.list(p),
      retrieveFn: (id) => stripe.disputes.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
      isFinalState: (dispute: Stripe.Dispute) =>
        dispute.status === 'won' || dispute.status === 'lost',
    },
    early_fraud_warning: {
      tableName: 'early_fraud_warnings',
      dependencies: ['payment_intent', 'charge'],
      listFn: (p) => stripe.radar.earlyFraudWarnings.list(p),
      retrieveFn: (id) => stripe.radar.earlyFraudWarnings.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
    },
    refund: {
      tableName: 'refunds',
      dependencies: ['payment_intent', 'charge'],
      listFn: (p) => stripe.refunds.list(p),
      retrieveFn: (id) => stripe.refunds.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
    },
    checkout_sessions: {
      tableName: 'checkout_sessions',
      dependencies: ['customer', 'subscription', 'payment_intent', 'invoice'],
      listFn: (p) => stripe.checkout.sessions.list(p),
      retrieveFn: (id) => stripe.checkout.sessions.retrieve(id),
      supportsCreatedFilter: true,
      sync: true,
      listExpands: [{ lines: (id) => stripe.checkout.sessions.listLineItems(id, { limit: 100 }) }],
    },
    active_entitlements: {
      tableName: 'active_entitlements',
      dependencies: ['customer'],
      listFn: (p) =>
        stripe.entitlements.activeEntitlements.list(
          p as unknown as Stripe.Entitlements.ActiveEntitlementListParams
        ),
      retrieveFn: (id) => stripe.entitlements.activeEntitlements.retrieve(id),
      supportsCreatedFilter: true,
      sync: false,
    },
    review: {
      tableName: 'reviews',
      dependencies: ['payment_intent', 'charge'],
      listFn: (p) => stripe.reviews.list(p),
      retrieveFn: (id) => stripe.reviews.retrieve(id),
      supportsCreatedFilter: true,
      sync: false,
    },
  }

  const orderMap = computeResourceOrder(core)

  return Object.fromEntries(
    Object.entries(core).map(([key, config]) => [key, { ...config, order: orderMap.get(key)! }])
  ) as Record<StripeObject, ResourceConfig>
}

/**
 * Build a separate registry for Sigma-backed resources.
 * Order values start after the highest core order so backfill sequencing is preserved.
 */
export function buildSigmaRegistry(
  sigma: SigmaSyncProcessor,
  coreRegistry: Record<string, ResourceConfig>
): Record<string, ResourceConfig> {
  const maxOrder = Math.max(...Object.values(coreRegistry).map((cfg) => cfg.order))
  return sigma.buildSigmaRegistryEntries(maxOrder)
}

/**
 * Maps Stripe API object type strings (e.g. "checkout.session") to SyncObject keys
 * used in resourceRegistry and getTableName().
 */
const STRIPE_OBJECT_TO_SYNC_OBJECT: Record<string, string> = {
  'checkout.session': 'checkout_sessions',
  'radar.early_fraud_warning': 'early_fraud_warning',
  'entitlements.active_entitlement': 'active_entitlements',
  'entitlements.feature': 'features',
  subscription_schedule: 'subscription_schedules',
}

/**
 * Convert a Stripe API object name (e.g. "checkout.session") to a SyncObject-compatible key.
 * Handles dotted names like "checkout.session" -> "checkout_sessions".
 * For simple names, returns as-is (e.g. "customer" -> "customer").
 */
export function normalizeStripeObjectName(stripeObjectName: string): StripeObject {
  return (STRIPE_OBJECT_TO_SYNC_OBJECT[stripeObjectName] ?? stripeObjectName) as StripeObject
}

/**
 * Maps Stripe ID prefixes to resource names used in the registry.
 * Used to resolve a Stripe object ID (e.g. "cus_xxx") to its resource type.
 * Prefixes are checked in order; longer prefixes should appear before shorter
 * ones that share a common start (e.g. "issfr_" before "in_").
 */
export const PREFIX_RESOURCE_MAP: Record<string, string> = {
  cus_: 'customer',
  in_: 'invoice',
  price_: 'price',
  prod_: 'product',
  sub_: 'subscription',
  seti_: 'setup_intent',
  pm_: 'payment_method',
  dp_: 'dispute',
  du_: 'dispute',
  ch_: 'charge',
  pi_: 'payment_intent',
  txi_: 'tax_id',
  cn_: 'credit_note',
  issfr_: 'early_fraud_warning',
  prv_: 'review',
  re_: 'refund',
  feat_: 'entitlements_feature',
  cs_: 'checkout_sessions',
}

// Prefixes sorted longest-first so e.g. "issfr_" is tested before "in_"
const SORTED_PREFIXES = Object.keys(PREFIX_RESOURCE_MAP).sort((a, b) => b.length - a.length)

/**
 * Resolve a Stripe object ID (e.g. "cus_abc123") to its resource name
 * in the registry (e.g. "customer"). Returns undefined if the prefix
 * is not recognized.
 */
export function getResourceFromPrefix(stripeId: string): string | undefined {
  const prefix = SORTED_PREFIXES.find((p) => stripeId.startsWith(p))
  return prefix ? PREFIX_RESOURCE_MAP[prefix] : undefined
}

/**
 * Get the resource configuration for a given Stripe ID.
 */
export function getResourceConfigFromId(
  stripeId: string,
  registry: Record<string, ResourceConfig>
): ResourceConfig | undefined {
  const resourceName = getResourceFromPrefix(stripeId)
  return resourceName ? registry[resourceName] : undefined
}

/**
 * Get the database table name for a SyncObject type from the resource registry.
 */
export function getTableName(object: string, registry: Record<string, ResourceConfig>): string {
  const config = registry[object]
  if (!config) {
    throw new Error(`No resource config found for object type: ${object}`)
  }
  return config.tableName
}
