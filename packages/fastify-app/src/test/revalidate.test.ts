import { StripeSync, runMigrations } from '@stripe/sync-engine'
import { vitest, beforeAll, describe, test, expect, afterEach } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'
import type Stripe from 'stripe'
import { ensureTestMerchantConfig } from './helpers/merchantConfig'

let stripeSync: StripeSync | undefined

ensureTestMerchantConfig()

beforeAll(async () => {
  process.env.REVALIDATE_OBJECTS_VIA_STRIPE_API = 'invoice'

  const config = getConfig()
  const primaryMerchantConfig = Object.values(config.merchantConfigByHost)[0]
  if (!primaryMerchantConfig) {
    throw new Error('MERCHANT_CONFIG_JSON must define at least one merchant')
  }
  await runMigrations({
    databaseUrl: primaryMerchantConfig.databaseUrl,

    logger,
  })

  stripeSync = await StripeSync.create({
    ...primaryMerchantConfig,
    stripeApiVersion: config.stripeApiVersion,
    stripeAccountId: 'acct_test_account',
    revalidateObjectsViaStripeApi: config.revalidateObjectsViaStripeApi,
    maxPostgresConnections: config.maxPostgresConnections,
    ...(config.partnerId ? { partnerId: config.partnerId } : {}),
    logger,
    poolConfig: {
      connectionString: primaryMerchantConfig.databaseUrl,
    },
  })
  const stripe = Object.assign(stripeSync.stripe, mockStripe)
  vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)
})

afterEach(() => {
  vitest.clearAllMocks()
})

describe('invoices', () => {
  test('should revalidate entity if enabled', async () => {
    const eventBody = await import(`./stripe/invoice_finalized.json`).then(
      ({ default: myData }) => myData
    )

    await stripeSync.webhook.processEvent(eventBody as unknown as Stripe.Event)

    const result = await stripeSync.postgresClient.query(
      `select customer from stripe.invoices where id = 'in_1KJdKkJDPojXS6LNSwSWkZSN' limit 1`
    )
    expect(mockStripe.invoices.retrieve).toHaveBeenCalled()
    expect(result.rows[0].customer).toEqual('cus_J7Mkgr8mvbl1eK') // from stripe mock
  })

  test('should not revalidate if entity in final status', async () => {
    const eventBody = await import(`./stripe/invoice_voided.json`).then(
      ({ default: myData }) => myData
    )

    await stripeSync.webhook.processEvent(eventBody as unknown as Stripe.Event)

    const result = await stripeSync.postgresClient.query(
      `select customer from stripe.invoices where id = 'in_1KJqKBJDPojXS6LNJbvLUgEy' limit 1`
    )
    expect(mockStripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(result.rows[0].customer).toEqual('cus_JsuO3bmrj0QlAw') // from webhook, no refetch
  })
})
