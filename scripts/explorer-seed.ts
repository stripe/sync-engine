#!/usr/bin/env tsx
/**
 * Deterministic Fake Data Generator for Schema Explorer
 *
 * Generates realistic, deterministic synthetic Stripe data for testing the schema explorer.
 * - Uses a caller-supplied deterministic seed for reproducibility
 * - Inserts data as _raw_data JSONB so generated columns work automatically
 * - Follows Stripe billing/payment graph relationships for core tables
 * - Uses generic fallback generator for all remaining projected tables
 * - Uses stable IDs (e.g., prod_seed_001, cus_seed_001)
 * - Timestamps fall within a stable window
 * - Reads database connection from .tmp/schema-explorer-run.json
 * - Prints manifest of row counts per table
 *
 * Usage:
 *   pnpm tsx scripts/explorer-seed.ts [--api-version=2020-08-27] [--seed=42]
 *   STRIPE_API_VERSION=2023-10-16 SEED=1337 pnpm tsx scripts/explorer-seed.ts
 */

import { Client } from 'pg'
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'node:util'
import {
  SpecParser,
  resolveOpenApiSpec,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from '../packages/sync-engine/src/openapi/index.js'
import type {
  ParsedResourceTable,
  ParsedColumn,
  ScalarType,
} from '../packages/sync-engine/src/openapi/types.js'

const TMP_DIR = path.join(process.cwd(), '.tmp')
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json')

// Deterministic seed for reproducibility
const DEFAULT_SEED = 42

// Stable timestamp window (Jan 1, 2024 to Dec 31, 2024)
const START_TIMESTAMP = 1704067200 // 2024-01-01 00:00:00 UTC
const END_TIMESTAMP = 1735689599 // 2024-12-31 23:59:59 UTC

// Core tables with graph-aware generators
const CORE_TABLES = new Set([
  'accounts',
  'products',
  'prices',
  'customers',
  'payment_methods',
  'setup_intents',
  'subscriptions',
  'subscription_items',
  'invoices',
  'payment_intents',
  'charges',
  'refunds',
  'checkout_sessions',
  'credit_notes',
  'disputes',
  'tax_ids',
])

// Stripe API version for spec resolution
const DEFAULT_STRIPE_API_VERSION = '2020-08-27'
const SYNC_ACCOUNTS_TABLE = '_sync_accounts'

interface ContainerMetadata {
  databaseUrl: string
  containerId: string
  containerName: string
  port: number
  volumeName: string
  createdAt: string
}

interface SeedScriptConfig {
  seed: number
  stripeApiVersion: string
}

function printUsage(): void {
  console.log('Usage: pnpm tsx scripts/explorer-seed.ts --api-version=2020-08-27 --seed=42')
  console.log('')
  console.log('Flags:')
  console.log(
    `  --api-version  Stripe API version for schema resolution (default: ${DEFAULT_STRIPE_API_VERSION})`
  )
  console.log(
    `  --seed         Random seed for deterministic data generation (default: ${DEFAULT_SEED})`
  )
  console.log('')
  console.log('Environment:')
  console.log('  STRIPE_API_VERSION  Used when --api-version is not provided')
  console.log('  SEED                Used when --seed is not provided')
}

function resolveApiVersion(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_STRIPE_API_VERSION
  }

  const normalizedValue = value.trim()
  if (!normalizedValue) {
    throw new Error('Stripe API version cannot be empty')
  }

  return normalizedValue
}

function resolveSeed(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_SEED
  }

  const normalizedValue = value.trim()
  if (!normalizedValue) {
    throw new Error('Seed cannot be empty')
  }

  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(`Seed must be a non-negative integer, received "${value}"`)
  }

  const seed = Number(normalizedValue)
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`Seed must be a safe integer, received "${value}"`)
  }

  return seed
}

function parseConfig(): SeedScriptConfig {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      'api-version': {
        type: 'string',
      },
      seed: {
        type: 'string',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    strict: true,
  })

  if (values.help) {
    printUsage()
    process.exit(0)
  }

  return {
    seed: resolveSeed(values.seed ?? process.env.SEED),
    stripeApiVersion: resolveApiVersion(values['api-version'] ?? process.env.STRIPE_API_VERSION),
  }
}

/**
 * Simple deterministic random number generator
 */
class SeededRandom {
  private seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  next(): number {
    // Simple LCG (Linear Congruential Generator)
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648
    return this.seed / 2147483648
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  nextTimestamp(): number {
    return this.nextInt(START_TIMESTAMP, END_TIMESTAMP)
  }

  choice<T>(arr: T[]): T {
    return arr[this.nextInt(0, arr.length - 1)]
  }

  boolean(): boolean {
    return this.next() > 0.5
  }
}

/**
 * Deterministic data generators
 */
class DataGenerator {
  private rng: SeededRandom

  constructor(seed: number) {
    this.rng = new SeededRandom(seed)
  }

  accountId(): string {
    return `acct_seed_${String(this.rng.nextInt(1, 999)).padStart(3, '0')}`
  }

  productId(index: number): string {
    return `prod_seed_${String(index).padStart(3, '0')}`
  }

  priceId(index: number): string {
    return `price_seed_${String(index).padStart(3, '0')}`
  }

  customerId(index: number): string {
    return `cus_seed_${String(index).padStart(3, '0')}`
  }

  subscriptionId(index: number): string {
    return `sub_seed_${String(index).padStart(3, '0')}`
  }

  subscriptionItemId(index: number): string {
    return `si_seed_${String(index).padStart(3, '0')}`
  }

  invoiceId(index: number): string {
    return `in_seed_${String(index).padStart(3, '0')}`
  }

  paymentIntentId(index: number): string {
    return `pi_seed_${String(index).padStart(3, '0')}`
  }

  paymentMethodId(index: number): string {
    return `pm_seed_${String(index).padStart(3, '0')}`
  }

  chargeId(index: number): string {
    return `ch_seed_${String(index).padStart(3, '0')}`
  }

  refundId(index: number): string {
    return `re_seed_${String(index).padStart(3, '0')}`
  }

  checkoutSessionId(index: number): string {
    return `cs_seed_${String(index).padStart(3, '0')}`
  }

  creditNoteId(index: number): string {
    return `cn_seed_${String(index).padStart(3, '0')}`
  }

  disputeId(index: number): string {
    return `dp_seed_${String(index).padStart(3, '0')}`
  }

  setupIntentId(index: number): string {
    return `seti_seed_${String(index).padStart(3, '0')}`
  }

  taxIdId(index: number): string {
    return `txi_seed_${String(index).padStart(3, '0')}`
  }

  email(index: number): string {
    return `customer${index}@example.com`
  }

  name(index: number): string {
    const firstNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry']
    const lastNames = [
      'Smith',
      'Johnson',
      'Williams',
      'Brown',
      'Jones',
      'Garcia',
      'Miller',
      'Davis',
    ]
    return `${this.rng.choice(firstNames)} ${this.rng.choice(lastNames)}`
  }

  productName(index: number): string {
    const products = [
      'Starter Plan',
      'Pro Plan',
      'Enterprise Plan',
      'Premium Service',
      'Basic Package',
    ]
    return `${this.rng.choice(products)} ${index}`
  }

  currency(): string {
    return this.rng.choice(['usd', 'eur', 'gbp'])
  }

  amount(): number {
    return this.rng.nextInt(500, 50000) // $5.00 to $500.00 in cents
  }
}

/**
 * Graph-aware data generator
 */
class StripeDataGraph {
  private gen: DataGenerator
  private accountId: string
  private accountRawData: Record<string, unknown> | null = null

  constructor(seed: number, accountId: string) {
    this.gen = new DataGenerator(seed)
    this.accountId = accountId
  }

  async seed(client: Client): Promise<void> {
    console.log('🌱 Seeding database with deterministic data...\n')

    // Clear existing data first for clean re-run
    console.log('  🗑️  Clearing existing data...')
    await client.query(`TRUNCATE stripe.${SYNC_ACCOUNTS_TABLE} CASCADE`)
    console.log('    ✓ Data cleared\n')

    // Insert the sync-owned root account first so projected tables can satisfy FKs.
    await this.seedSyncAccountRoot(client)
    await this.seedAccounts(client)

    // Core billing/payment flow
    await this.seedProducts(client)
    await this.seedPrices(client)
    await this.seedCustomers(client)
    await this.seedPaymentMethods(client)
    await this.seedSetupIntents(client)
    await this.seedSubscriptions(client)
    await this.seedSubscriptionItems(client)
    await this.seedInvoices(client)
    await this.seedPaymentIntents(client)
    await this.seedCharges(client)
    await this.seedRefunds(client)
    await this.seedCheckoutSessions(client)
    await this.seedCreditNotes(client)
    await this.seedDisputes(client)
    await this.seedTaxIds(client)

    console.log('\n✅ Seeding complete!')
  }

  private buildAccountRawData() {
    if (this.accountRawData) {
      return this.accountRawData
    }

    this.accountRawData = {
      id: this.accountId,
      object: 'account',
      business_profile: {
        name: 'Seed Test Account',
        url: 'https://example.com',
      },
      country: 'US',
      created: this.gen['rng'].nextTimestamp(),
      default_currency: 'usd',
      email: 'account@example.com',
      type: 'standard',
      charges_enabled: true,
      payouts_enabled: true,
    }

    return this.accountRawData
  }

  private async seedSyncAccountRoot(client: Client): Promise<void> {
    console.log('  🔐 Seeding sync account root...')

    const rawData = this.buildAccountRawData()

    await client.query(
      `INSERT INTO stripe.${SYNC_ACCOUNTS_TABLE} (_raw_data, api_key_hashes) VALUES ($1, $2)`,
      [JSON.stringify(rawData), []]
    )

    console.log(`    ✓ Inserted 1 sync account root`)
  }

  private async seedAccounts(client: Client): Promise<void> {
    console.log('  📋 Seeding accounts...')

    const rawData = this.buildAccountRawData()

    await client.query(`INSERT INTO stripe.accounts (_raw_data, _account_id) VALUES ($1, $2)`, [
      JSON.stringify(rawData),
      this.accountId,
    ])

    console.log(`    ✓ Inserted 1 projected account`)
  }

  private async seedProducts(client: Client): Promise<void> {
    console.log('  📦 Seeding products...')
    const count = 8

    for (let i = 1; i <= count; i++) {
      const rawData = {
        id: this.gen.productId(i),
        object: 'product',
        active: this.gen['rng'].boolean(),
        created: this.gen['rng'].nextTimestamp(),
        description: `Description for product ${i}`,
        images: [],
        livemode: false,
        metadata: {},
        name: this.gen.productName(i),
        statement_descriptor: null,
        updated: this.gen['rng'].nextTimestamp(),
        url: null,
      }

      await client.query(`INSERT INTO stripe.products (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} products`)
  }

  private async seedPrices(client: Client): Promise<void> {
    console.log('  💰 Seeding prices...')
    const count = 12

    for (let i = 1; i <= count; i++) {
      const productId = this.gen.productId((i % 8) + 1)
      const currency = this.gen.currency()

      const rawData = {
        id: this.gen.priceId(i),
        object: 'price',
        active: true,
        billing_scheme: 'per_unit',
        created: this.gen['rng'].nextTimestamp(),
        currency: currency,
        custom_unit_amount: null,
        livemode: false,
        lookup_key: null,
        metadata: {},
        nickname: `Price ${i}`,
        product: productId,
        recurring: this.gen['rng'].boolean()
          ? {
              interval: this.gen['rng'].choice(['month', 'year']),
              interval_count: 1,
              usage_type: 'licensed',
            }
          : null,
        tax_behavior: 'unspecified',
        type: this.gen['rng'].boolean() ? 'recurring' : 'one_time',
        unit_amount: this.gen.amount(),
        unit_amount_decimal: String(this.gen.amount()),
      }

      await client.query(`INSERT INTO stripe.prices (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} prices`)
  }

  private async seedCustomers(client: Client): Promise<void> {
    console.log('  👤 Seeding customers...')
    const count = 25

    for (let i = 1; i <= count; i++) {
      const rawData = {
        id: this.gen.customerId(i),
        object: 'customer',
        address: null,
        balance: 0,
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        default_source: null,
        delinquent: false,
        description: `Customer ${i}`,
        discount: null,
        email: this.gen.email(i),
        invoice_prefix: `INV${i}`,
        invoice_settings: {
          custom_fields: null,
          default_payment_method: null,
          footer: null,
        },
        livemode: false,
        metadata: {},
        name: this.gen.name(i),
        phone: null,
        preferred_locales: [],
        shipping: null,
        tax_exempt: 'none',
      }

      await client.query(`INSERT INTO stripe.customers (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} customers`)
  }

  private async seedPaymentMethods(client: Client): Promise<void> {
    console.log('  💳 Seeding payment methods...')
    const count = 30

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)

      const rawData = {
        id: this.gen.paymentMethodId(i),
        object: 'payment_method',
        billing_details: {
          address: null,
          email: this.gen.email((i % 25) + 1),
          name: this.gen.name((i % 25) + 1),
          phone: null,
        },
        card: {
          brand: this.gen['rng'].choice(['visa', 'mastercard', 'amex']),
          checks: null,
          country: 'US',
          exp_month: this.gen['rng'].nextInt(1, 12),
          exp_year: this.gen['rng'].nextInt(2025, 2030),
          fingerprint: `fp_${i}`,
          funding: 'credit',
          last4: String(this.gen['rng'].nextInt(1000, 9999)),
          networks: null,
          three_d_secure_usage: null,
          wallet: null,
        },
        created: this.gen['rng'].nextTimestamp(),
        customer: customerId,
        livemode: false,
        metadata: {},
        type: 'card',
      }

      await client.query(
        `INSERT INTO stripe.payment_methods (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} payment methods`)
  }

  private async seedSetupIntents(client: Client): Promise<void> {
    console.log('  🔧 Seeding setup intents...')
    const count = 15

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const paymentMethodId = this.gen.paymentMethodId((i % 30) + 1)

      const rawData = {
        id: this.gen.setupIntentId(i),
        object: 'setup_intent',
        application: null,
        automatic_payment_methods: null,
        cancellation_reason: null,
        client_secret: `seti_secret_${i}`,
        created: this.gen['rng'].nextTimestamp(),
        customer: customerId,
        description: null,
        flow_directions: null,
        last_setup_error: null,
        latest_attempt: null,
        livemode: false,
        mandate: null,
        metadata: {},
        next_action: null,
        on_behalf_of: null,
        payment_method: paymentMethodId,
        payment_method_options: {},
        payment_method_types: ['card'],
        single_use_mandate: null,
        status: this.gen['rng'].choice(['succeeded', 'requires_payment_method', 'canceled']),
        usage: 'off_session',
      }

      await client.query(
        `INSERT INTO stripe.setup_intents (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} setup intents`)
  }

  private async seedSubscriptions(client: Client): Promise<void> {
    console.log('  📅 Seeding subscriptions...')
    const count = 20

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const created = this.gen['rng'].nextTimestamp()

      const rawData = {
        id: this.gen.subscriptionId(i),
        object: 'subscription',
        application: null,
        application_fee_percent: null,
        automatic_tax: { enabled: false },
        billing_cycle_anchor: created,
        billing_thresholds: null,
        cancel_at: null,
        cancel_at_period_end: false,
        canceled_at: null,
        collection_method: 'charge_automatically',
        created: created,
        currency: this.gen.currency(),
        current_period_end: created + 2592000, // +30 days
        current_period_start: created,
        customer: customerId,
        days_until_due: null,
        default_payment_method: null,
        default_source: null,
        default_tax_rates: [],
        description: null,
        discount: null,
        ended_at: null,
        items: {
          object: 'list',
          data: [],
          has_more: false,
          total_count: 0,
          url: `/v1/subscription_items?subscription=${this.gen.subscriptionId(i)}`,
        },
        latest_invoice: null,
        livemode: false,
        metadata: {},
        next_pending_invoice_item_invoice: null,
        on_behalf_of: null,
        pause_collection: null,
        payment_settings: null,
        pending_invoice_item_interval: null,
        pending_setup_intent: null,
        pending_update: null,
        schedule: null,
        start_date: created,
        status: this.gen['rng'].choice(['active', 'past_due', 'trialing']),
        test_clock: null,
        transfer_data: null,
        trial_end: null,
        trial_start: null,
      }

      await client.query(
        `INSERT INTO stripe.subscriptions (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} subscriptions`)
  }

  private async seedSubscriptionItems(client: Client): Promise<void> {
    console.log('  📋 Seeding subscription items...')
    const count = 30

    for (let i = 1; i <= count; i++) {
      const subscriptionId = this.gen.subscriptionId((i % 20) + 1)
      const priceId = this.gen.priceId((i % 12) + 1)

      const rawData = {
        id: this.gen.subscriptionItemId(i),
        object: 'subscription_item',
        billing_thresholds: null,
        created: this.gen['rng'].nextTimestamp(),
        metadata: {},
        price: {
          id: priceId,
          object: 'price',
        },
        quantity: this.gen['rng'].nextInt(1, 10),
        subscription: subscriptionId,
        tax_rates: [],
      }

      await client.query(
        `INSERT INTO stripe.subscription_items (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} subscription items`)
  }

  private async seedInvoices(client: Client): Promise<void> {
    console.log('  🧾 Seeding invoices...')
    const count = 35

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const subscriptionId = i <= 20 ? this.gen.subscriptionId(i) : null
      const created = this.gen['rng'].nextTimestamp()
      const amount = this.gen.amount()

      const rawData = {
        id: this.gen.invoiceId(i),
        object: 'invoice',
        account_country: 'US',
        account_name: 'Seed Test Account',
        account_tax_ids: null,
        amount_due: amount,
        amount_paid: this.gen['rng'].boolean() ? amount : 0,
        amount_remaining: this.gen['rng'].boolean() ? 0 : amount,
        application: null,
        application_fee_amount: null,
        attempt_count: this.gen['rng'].nextInt(0, 3),
        attempted: true,
        auto_advance: true,
        automatic_tax: { enabled: false },
        billing_reason: subscriptionId ? 'subscription_cycle' : 'manual',
        charge: null,
        collection_method: 'charge_automatically',
        created: created,
        currency: this.gen.currency(),
        custom_fields: null,
        customer: customerId,
        customer_address: null,
        customer_email: this.gen.email((i % 25) + 1),
        customer_name: this.gen.name((i % 25) + 1),
        customer_phone: null,
        customer_shipping: null,
        customer_tax_exempt: 'none',
        customer_tax_ids: [],
        default_payment_method: null,
        default_source: null,
        default_tax_rates: [],
        description: null,
        discount: null,
        discounts: [],
        due_date: null,
        ending_balance: 0,
        footer: null,
        hosted_invoice_url: null,
        invoice_pdf: null,
        last_finalization_error: null,
        latest_revision: null,
        lines: {
          object: 'list',
          data: [],
          has_more: false,
          total_count: 0,
          url: `/v1/invoices/${this.gen.invoiceId(i)}/lines`,
        },
        livemode: false,
        metadata: {},
        next_payment_attempt: null,
        number: `INV-${String(i).padStart(4, '0')}`,
        on_behalf_of: null,
        paid: this.gen['rng'].boolean(),
        paid_out_of_band: false,
        payment_intent: null,
        payment_settings: null,
        period_end: created,
        period_start: created - 2592000, // -30 days
        post_payment_credit_notes_amount: 0,
        pre_payment_credit_notes_amount: 0,
        quote: null,
        receipt_number: null,
        rendering_options: null,
        starting_balance: 0,
        statement_descriptor: null,
        status: this.gen['rng'].choice(['draft', 'open', 'paid', 'void']),
        status_transitions: {
          finalized_at: created,
          marked_uncollectible_at: null,
          paid_at: this.gen['rng'].boolean() ? created + 3600 : null,
          voided_at: null,
        },
        subscription: subscriptionId,
        subtotal: amount,
        subtotal_excluding_tax: amount,
        tax: null,
        test_clock: null,
        total: amount,
        total_discount_amounts: [],
        total_excluding_tax: amount,
        total_tax_amounts: [],
        transfer_data: null,
        webhooks_delivered_at: created,
      }

      await client.query(`INSERT INTO stripe.invoices (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} invoices`)
  }

  private async seedPaymentIntents(client: Client): Promise<void> {
    console.log('  💸 Seeding payment intents...')
    const count = 40

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const invoiceId = i <= 35 ? this.gen.invoiceId(i) : null
      const paymentMethodId = this.gen.paymentMethodId((i % 30) + 1)
      const amount = this.gen.amount()

      const rawData = {
        id: this.gen.paymentIntentId(i),
        object: 'payment_intent',
        amount: amount,
        amount_capturable: 0,
        amount_details: {},
        amount_received: this.gen['rng'].boolean() ? amount : 0,
        application: null,
        application_fee_amount: null,
        automatic_payment_methods: null,
        canceled_at: null,
        cancellation_reason: null,
        capture_method: 'automatic',
        charges: {
          object: 'list',
          data: [],
          has_more: false,
          total_count: 0,
          url: `/v1/charges?payment_intent=${this.gen.paymentIntentId(i)}`,
        },
        client_secret: `pi_secret_${i}`,
        confirmation_method: 'automatic',
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        customer: customerId,
        description: null,
        invoice: invoiceId,
        last_payment_error: null,
        latest_charge: null,
        livemode: false,
        metadata: {},
        next_action: null,
        on_behalf_of: null,
        payment_method: paymentMethodId,
        payment_method_options: {},
        payment_method_types: ['card'],
        processing: null,
        receipt_email: null,
        review: null,
        setup_future_usage: null,
        shipping: null,
        statement_descriptor: null,
        statement_descriptor_suffix: null,
        status: this.gen['rng'].choice(['succeeded', 'requires_payment_method', 'processing']),
        transfer_data: null,
        transfer_group: null,
      }

      await client.query(
        `INSERT INTO stripe.payment_intents (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} payment intents`)
  }

  private async seedCharges(client: Client): Promise<void> {
    console.log('  ⚡ Seeding charges...')
    const count = 45

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const invoiceId = i <= 35 ? this.gen.invoiceId(i) : null
      const paymentIntentId = i <= 40 ? this.gen.paymentIntentId(i) : null
      const paymentMethodId = this.gen.paymentMethodId((i % 30) + 1)
      const amount = this.gen.amount()
      const paid = this.gen['rng'].boolean()

      const rawData = {
        id: this.gen.chargeId(i),
        object: 'charge',
        amount: amount,
        amount_captured: paid ? amount : 0,
        amount_refunded: 0,
        application: null,
        application_fee: null,
        application_fee_amount: null,
        balance_transaction: `txn_${i}`,
        billing_details: {
          address: null,
          email: this.gen.email((i % 25) + 1),
          name: this.gen.name((i % 25) + 1),
          phone: null,
        },
        calculated_statement_descriptor: `SEED*TEST ${i}`,
        captured: paid,
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        customer: customerId,
        description: null,
        destination: null,
        dispute: null,
        disputed: false,
        failure_balance_transaction: null,
        failure_code: null,
        failure_message: null,
        fraud_details: {},
        invoice: invoiceId,
        livemode: false,
        metadata: {},
        on_behalf_of: null,
        outcome: {
          network_status: 'approved_by_network',
          reason: null,
          risk_level: 'normal',
          risk_score: this.gen['rng'].nextInt(10, 50),
          seller_message: 'Payment complete.',
          type: 'authorized',
        },
        paid: paid,
        payment_intent: paymentIntentId,
        payment_method: paymentMethodId,
        payment_method_details: {
          card: {
            brand: this.gen['rng'].choice(['visa', 'mastercard', 'amex']),
            country: 'US',
            exp_month: this.gen['rng'].nextInt(1, 12),
            exp_year: this.gen['rng'].nextInt(2025, 2030),
            fingerprint: `fp_${i}`,
            funding: 'credit',
            last4: String(this.gen['rng'].nextInt(1000, 9999)),
          },
          type: 'card',
        },
        receipt_email: null,
        receipt_number: null,
        receipt_url: `https://pay.stripe.com/receipts/${i}`,
        refunded: false,
        refunds: {
          object: 'list',
          data: [],
          has_more: false,
          total_count: 0,
          url: `/v1/charges/${this.gen.chargeId(i)}/refunds`,
        },
        review: null,
        shipping: null,
        source_transfer: null,
        statement_descriptor: null,
        statement_descriptor_suffix: null,
        status: paid ? 'succeeded' : this.gen['rng'].choice(['pending', 'failed']),
        transfer_data: null,
        transfer_group: null,
      }

      await client.query(`INSERT INTO stripe.charges (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} charges`)
  }

  private async seedRefunds(client: Client): Promise<void> {
    console.log('  🔄 Seeding refunds...')
    const count = 10

    for (let i = 1; i <= count; i++) {
      const chargeId = this.gen.chargeId((i % 45) + 1)
      const paymentIntentId = this.gen.paymentIntentId((i % 40) + 1)
      const amount = this.gen.amount()

      const rawData = {
        id: this.gen.refundId(i),
        object: 'refund',
        amount: Math.floor(amount / 2),
        balance_transaction: `txn_refund_${i}`,
        charge: chargeId,
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        description: null,
        failure_balance_transaction: null,
        failure_reason: null,
        metadata: {},
        payment_intent: paymentIntentId,
        reason: this.gen['rng'].choice(['requested_by_customer', 'duplicate', 'fraudulent']),
        receipt_number: null,
        source_transfer_reversal: null,
        status: 'succeeded',
        transfer_reversal: null,
      }

      await client.query(`INSERT INTO stripe.refunds (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} refunds`)
  }

  private async seedCheckoutSessions(client: Client): Promise<void> {
    console.log('  🛒 Seeding checkout sessions...')
    const count = 18

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const subscriptionId = i <= 20 ? this.gen.subscriptionId(i) : null
      const paymentIntentId = i <= 40 ? this.gen.paymentIntentId(i) : null
      const amount = this.gen.amount()

      const rawData = {
        id: this.gen.checkoutSessionId(i),
        object: 'checkout.session',
        after_expiration: null,
        allow_promotion_codes: null,
        amount_subtotal: amount,
        amount_total: amount,
        automatic_tax: { enabled: false, status: null },
        billing_address_collection: null,
        cancel_url: 'https://example.com/cancel',
        client_reference_id: null,
        consent: null,
        consent_collection: null,
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        custom_fields: [],
        custom_text: {},
        customer: customerId,
        customer_creation: null,
        customer_details: {
          address: null,
          email: this.gen.email((i % 25) + 1),
          name: this.gen.name((i % 25) + 1),
          phone: null,
          tax_exempt: 'none',
          tax_ids: [],
        },
        customer_email: this.gen.email((i % 25) + 1),
        expires_at: this.gen['rng'].nextTimestamp() + 86400,
        invoice: null,
        invoice_creation: null,
        livemode: false,
        locale: null,
        metadata: {},
        mode: subscriptionId ? 'subscription' : 'payment',
        payment_intent: paymentIntentId,
        payment_link: null,
        payment_method_collection: 'always',
        payment_method_options: {},
        payment_method_types: ['card'],
        payment_status: this.gen['rng'].choice(['paid', 'unpaid', 'no_payment_required']),
        phone_number_collection: { enabled: false },
        recovered_from: null,
        setup_intent: null,
        shipping_address_collection: null,
        shipping_cost: null,
        shipping_details: null,
        shipping_options: [],
        status: this.gen['rng'].choice(['complete', 'expired', 'open']),
        submit_type: null,
        subscription: subscriptionId,
        success_url: 'https://example.com/success',
        total_details: {
          amount_discount: 0,
          amount_shipping: 0,
          amount_tax: 0,
        },
        ui_mode: 'hosted',
        url: `https://checkout.stripe.com/c/pay/${i}`,
      }

      await client.query(
        `INSERT INTO stripe.checkout_sessions (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} checkout sessions`)
  }

  private async seedCreditNotes(client: Client): Promise<void> {
    console.log('  📝 Seeding credit notes...')
    const count = 5

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)
      const invoiceId = this.gen.invoiceId((i % 35) + 1)
      const amount = this.gen.amount()

      const rawData = {
        id: this.gen.creditNoteId(i),
        object: 'credit_note',
        amount: amount,
        amount_shipping: 0,
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        customer: customerId,
        customer_balance_transaction: null,
        discount_amount: 0,
        discount_amounts: [],
        effective_at: null,
        invoice: invoiceId,
        lines: {
          object: 'list',
          data: [],
          has_more: false,
          total_count: 0,
          url: `/v1/credit_notes/${this.gen.creditNoteId(i)}/lines`,
        },
        livemode: false,
        memo: `Credit note ${i}`,
        metadata: {},
        number: `CN-${String(i).padStart(4, '0')}`,
        out_of_band_amount: null,
        pdf: `https://pay.stripe.com/credit_notes/${i}/pdf`,
        reason: this.gen['rng'].choice([
          'duplicate',
          'fraudulent',
          'order_change',
          'product_unsatisfactory',
        ]),
        refund: null,
        shipping_cost: null,
        status: 'issued',
        subtotal: amount,
        subtotal_excluding_tax: amount,
        tax_amounts: [],
        total: amount,
        total_excluding_tax: amount,
        type: 'post_payment',
        voided_at: null,
      }

      await client.query(
        `INSERT INTO stripe.credit_notes (_raw_data, _account_id) VALUES ($1, $2)`,
        [JSON.stringify(rawData), this.accountId]
      )
    }

    console.log(`    ✓ Inserted ${count} credit notes`)
  }

  private async seedDisputes(client: Client): Promise<void> {
    console.log('  ⚠️  Seeding disputes...')
    const count = 3

    for (let i = 1; i <= count; i++) {
      const chargeId = this.gen.chargeId((i % 45) + 1)
      const amount = this.gen.amount()

      const rawData = {
        id: this.gen.disputeId(i),
        object: 'dispute',
        amount: amount,
        balance_transactions: [],
        charge: chargeId,
        created: this.gen['rng'].nextTimestamp(),
        currency: this.gen.currency(),
        evidence: {
          access_activity_log: null,
          billing_address: null,
          cancellation_policy: null,
          cancellation_policy_disclosure: null,
          cancellation_rebuttal: null,
          customer_communication: null,
          customer_email_address: null,
          customer_name: null,
          customer_purchase_ip: null,
          customer_signature: null,
          duplicate_charge_documentation: null,
          duplicate_charge_explanation: null,
          duplicate_charge_id: null,
          product_description: null,
          receipt: null,
          refund_policy: null,
          refund_policy_disclosure: null,
          refund_refusal_explanation: null,
          service_date: null,
          service_documentation: null,
          shipping_address: null,
          shipping_carrier: null,
          shipping_date: null,
          shipping_documentation: null,
          shipping_tracking_number: null,
          uncategorized_file: null,
          uncategorized_text: null,
        },
        evidence_details: {
          due_by: this.gen['rng'].nextTimestamp() + 1209600, // +14 days
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        is_charge_refundable: true,
        livemode: false,
        metadata: {},
        payment_intent: null,
        reason: this.gen['rng'].choice([
          'bank_cannot_process',
          'credit_not_processed',
          'customer_initiated',
          'fraudulent',
        ]),
        status: this.gen['rng'].choice([
          'warning_needs_response',
          'warning_under_review',
          'won',
          'lost',
        ]),
      }

      await client.query(`INSERT INTO stripe.disputes (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} disputes`)
  }

  private async seedTaxIds(client: Client): Promise<void> {
    console.log('  🆔 Seeding tax IDs...')
    const count = 12

    for (let i = 1; i <= count; i++) {
      const customerId = this.gen.customerId((i % 25) + 1)

      const rawData = {
        id: this.gen.taxIdId(i),
        object: 'tax_id',
        country: this.gen['rng'].choice(['US', 'GB', 'DE', 'FR', 'CA']),
        created: this.gen['rng'].nextTimestamp(),
        customer: customerId,
        livemode: false,
        type: this.gen['rng'].choice(['eu_vat', 'us_ein', 'gb_vat', 'ca_bn']),
        value: `TAX${String(this.gen['rng'].nextInt(100000, 999999))}`,
        verification: {
          status: this.gen['rng'].choice(['verified', 'pending', 'unverified']),
          verified_address: null,
          verified_name: null,
        },
      }

      await client.query(`INSERT INTO stripe.tax_ids (_raw_data, _account_id) VALUES ($1, $2)`, [
        JSON.stringify(rawData),
        this.accountId,
      ])
    }

    console.log(`    ✓ Inserted ${count} tax IDs`)
  }
}

/**
 * Generic fallback generator for long-tail projected tables
 * Uses column metadata from SpecParser to generate type-correct _raw_data
 */
class GenericTableSeeder {
  private rng: SeededRandom
  private accountId: string

  constructor(seed: number, accountId: string) {
    this.rng = new SeededRandom(seed)
    this.accountId = accountId
  }

  /**
   * Generate a type-correct value for a column based on its type
   */
  private generateValueForType(columnName: string, type: ScalarType, index: number): any {
    switch (type) {
      case 'text':
        // Use stable string values based on column name
        if (columnName === 'id') {
          return `generic_${index}_${this.rng.nextInt(1000, 9999)}`
        }
        if (columnName.includes('email')) {
          return `generic${index}@example.com`
        }
        if (columnName.includes('name') || columnName.includes('description')) {
          return `Generic ${columnName} ${index}`
        }
        if (columnName.includes('status')) {
          return this.rng.choice(['active', 'inactive', 'pending', 'succeeded'])
        }
        if (columnName.includes('currency')) {
          return this.rng.choice(['usd', 'eur', 'gbp'])
        }
        return `value_${columnName}_${index}`

      case 'bigint':
        // Generate stable integers
        if (columnName.includes('amount') || columnName.includes('balance')) {
          return this.rng.nextInt(100, 100000)
        }
        if (columnName.includes('created') || columnName.includes('timestamp')) {
          return this.rng.nextTimestamp()
        }
        if (columnName.includes('count') || columnName.includes('quantity')) {
          return this.rng.nextInt(1, 100)
        }
        return this.rng.nextInt(1, 1000000)

      case 'boolean':
        return this.rng.boolean()

      case 'timestamptz':
        // Return Unix timestamp (will be converted to timestamptz)
        return this.rng.nextTimestamp()

      case 'numeric':
        // Generate decimal values
        return this.rng.nextInt(100, 100000) / 100

      case 'json':
        // Return stable JSON objects
        return {
          [`${columnName}_field`]: `value_${index}`,
          metadata: {},
          timestamp: this.rng.nextTimestamp(),
        }

      default:
        return `fallback_${index}`
    }
  }

  /**
   * Generate a single row of data for a table
   */
  private generateRow(table: ParsedResourceTable, index: number): Record<string, any> {
    const row: Record<string, any> = {
      object: table.resourceId,
    }

    // Generate id field if not in columns (it's usually in _raw_data)
    const hasIdColumn = table.columns.some((col) => col.name === 'id')
    if (!hasIdColumn) {
      row.id = `${table.tableName}_seed_${String(index).padStart(3, '0')}`
    }

    // Generate values for all columns
    for (const column of table.columns) {
      // Skip reserved columns that are handled separately
      if (['_raw_data', '_last_synced_at', '_updated_at', '_account_id'].includes(column.name)) {
        continue
      }

      const value = this.generateValueForType(column.name, column.type, index)

      // Handle nullable columns
      if (column.nullable && this.rng.next() < 0.3) {
        row[column.name] = null
      } else {
        row[column.name] = value
      }
    }

    return row
  }

  /**
   * Seed a table with generic data
   */
  async seedTable(client: Client, table: ParsedResourceTable): Promise<number> {
    // Determine row count (1-20 for long-tail tables)
    const rowCount = this.rng.nextInt(1, 20)

    for (let i = 1; i <= rowCount; i++) {
      const rawData = this.generateRow(table, i)

      try {
        await client.query(
          `INSERT INTO stripe.${table.tableName} (_raw_data, _account_id) VALUES ($1, $2)`,
          [JSON.stringify(rawData), this.accountId]
        )
      } catch (error) {
        // Log error but continue with other tables
        console.error(
          `    ⚠️  Error inserting row ${i} into ${table.tableName}:`,
          (error as Error).message
        )
        return i - 1 // Return count of successful inserts
      }
    }

    return rowCount
  }
}

async function main(): Promise<void> {
  console.log('🚀 Explorer Seed Script\n')

  let config: SeedScriptConfig
  try {
    config = parseConfig()
  } catch (error) {
    console.error('❌ Configuration error:', (error as Error).message)
    process.exit(1)
  }

  // Load metadata
  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ Error: No metadata file found')
    console.error(`   Expected: ${METADATA_FILE}`)
    console.error('\n💡 Start the harness first: pnpm tsx scripts/explorer-harness.ts start')
    process.exit(1)
  }

  const metadata: ContainerMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'))

  console.log('📋 Connection details:')
  console.log(`   Database URL: ${metadata.databaseUrl}`)
  console.log(`   Container: ${metadata.containerName}`)
  console.log(`   API Version: ${config.stripeApiVersion}`)
  console.log(`   Seed: ${config.seed}`)
  console.log('')

  // Connect to database
  const client = new Client({ connectionString: metadata.databaseUrl })

  try {
    await client.connect()
    console.log('✅ Connected to database\n')

    // Generate deterministic account ID
    const gen = new DataGenerator(config.seed)
    const accountId = gen.accountId()

    // Phase 1: Seed core tables with graph-aware generators
    console.log('📦 Phase 1: Seeding core tables with graph-aware data...\n')
    const graph = new StripeDataGraph(config.seed, accountId)
    await graph.seed(client)

    // Phase 2: Discover all projected tables from OpenAPI spec
    console.log('\n📦 Phase 2: Discovering projected tables from OpenAPI spec...\n')
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion: config.stripeApiVersion,
    })
    console.log(`   ✓ Resolved OpenAPI spec (${resolvedSpec.source})`)

    const parser = new SpecParser()
    // Parse ALL projected tables (no allowedTables filter)
    const parsedSpec = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      // Omit allowedTables to get all resolvable tables
    })

    console.log(`   ✓ Parsed ${parsedSpec.tables.length} projected tables\n`)

    // Phase 3: Seed long-tail tables with generic fallback generator
    console.log('📦 Phase 3: Seeding long-tail tables with generic fallback...\n')
    const genericSeeder = new GenericTableSeeder(config.seed + 1000, accountId)
    const seededTables: Record<string, number> = {}
    const failedTables: Array<{ table: string; reason: string }> = []
    const skippedTables: string[] = []

    for (const table of parsedSpec.tables) {
      // Skip core tables (already seeded)
      if (CORE_TABLES.has(table.tableName)) {
        skippedTables.push(table.tableName)
        continue
      }

      // Check if table exists in database
      const tableExistsResult = await client.query(
        `SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'stripe'
          AND table_name = $1
        )`,
        [table.tableName]
      )

      if (!tableExistsResult.rows[0]?.exists) {
        failedTables.push({
          table: table.tableName,
          reason: 'Table does not exist in database (not migrated)',
        })
        continue
      }

      console.log(`  🔧 Seeding ${table.tableName}...`)
      try {
        const rowCount = await genericSeeder.seedTable(client, table)
        seededTables[table.tableName] = rowCount
        console.log(`    ✓ Inserted ${rowCount} rows`)
      } catch (error) {
        failedTables.push({
          table: table.tableName,
          reason: (error as Error).message,
        })
        console.error(`    ❌ Failed: ${(error as Error).message}`)
      }
    }

    // Phase 4: Generate manifest
    console.log('\n📊 Seeding Complete - Row Count Manifest:\n')
    console.log('Core Tables (Graph-Aware):')

    const manifest: Record<string, number> = {}

    // Query row counts for all tables in stripe schema
    const allTablesResult = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'stripe'
       AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    )

    for (const row of allTablesResult.rows) {
      const tableName = row.table_name

      // Skip internal tables
      if (tableName.startsWith('_')) {
        continue
      }

      const countResult = await client.query(`SELECT COUNT(*) as count FROM stripe."${tableName}"`)
      const count = parseInt(countResult.rows[0].count, 10)
      manifest[tableName] = count

      if (CORE_TABLES.has(tableName)) {
        console.log(`   ✓ ${tableName}: ${count} rows`)
      }
    }

    console.log('\nLong-Tail Tables (Generic Fallback):')
    for (const [tableName, count] of Object.entries(manifest)) {
      if (!CORE_TABLES.has(tableName)) {
        console.log(`   ✓ ${tableName}: ${count} rows`)
      }
    }

    // Display excluded tables
    if (failedTables.length > 0) {
      console.log('\n⚠️  Excluded Tables (with reasons):')
      for (const { table, reason } of failedTables) {
        console.log(`   ✗ ${table}: ${reason}`)
      }
    }

    // Display skipped tables
    if (skippedTables.length > 0) {
      console.log('\n⏭️  Skipped Tables (already seeded by core generators):')
      for (const table of skippedTables) {
        console.log(`   - ${table}`)
      }
    }

    // Verify all tables have at least 1 row
    console.log('\n🔍 Verification:')
    const emptyTables = Object.entries(manifest).filter(([_, count]) => count === 0)
    const tablesWithData = Object.entries(manifest).filter(([_, count]) => count > 0)

    console.log(`   ✓ Tables with data: ${tablesWithData.length}`)
    if (emptyTables.length > 0) {
      console.log(`   ⚠️  Tables with 0 rows: ${emptyTables.length}`)
      for (const [tableName] of emptyTables) {
        console.log(`      - ${tableName}`)
      }
    } else {
      console.log('   ✅ All tables have at least 1 row!')
    }

    console.log(`\n✅ Seeding complete! ${Object.keys(manifest).length} tables seeded.`)

    // Write manifest to file for reference
    const manifestPath = path.join(TMP_DIR, 'seed-manifest.json')
    const manifestData = {
      timestamp: new Date().toISOString(),
      seed: config.seed,
      apiVersion: config.stripeApiVersion,
      totalTables: Object.keys(manifest).length,
      coreTables: Array.from(CORE_TABLES).filter((t) => t in manifest),
      longTailTables: Object.keys(manifest).filter((t) => !CORE_TABLES.has(t)),
      manifest,
      failedTables,
      verification: {
        allTablesSeeded: emptyTables.length === 0,
        tablesWithData: tablesWithData.length,
        emptyTables: emptyTables.map(([name]) => name),
      },
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2))
    console.log(`\n📄 Manifest written to: ${manifestPath}`)
  } catch (error) {
    console.error('\n❌ Error:', error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
