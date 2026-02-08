'use strict'
import { FastifyInstance } from 'fastify'
import { createHmac } from 'node:crypto'
import { PostgresClient, StripeSync, runMigrations } from 'stripe-experiment-sync'
import { beforeAll, describe, test, expect, afterAll, vitest } from 'vitest'
import { getConfig } from '../utils/config'
import { createServer } from '../app'
import { logger } from '../logger'
import { mockStripe } from './helpers/mockStripe'

const unixtime = Math.floor(new Date().getTime() / 1000)
const stripeWebhookSecret = getConfig().stripeWebhookSecret

const postgresClient = new PostgresClient({
  poolConfig: {
    connectionString: getConfig().databaseUrl,
  },
  schema: 'stripe',
})

describe('POST /webhooks', () => {
  let server: FastifyInstance | undefined

  beforeAll(async () => {
    const config = getConfig()
    await postgresClient.query('DROP SCHEMA IF EXISTS stripe CASCADE')
    await runMigrations({
      databaseUrl: config.databaseUrl,
      logger,
    })

    process.env.AUTO_EXPAND_LISTS = 'false'
    process.env.STRIPE_ACCOUNT_ID = process.env.STRIPE_ACCOUNT_ID || 'acct_test_account'

    server = await createServer()

    const stripeSync = server.getDecorator<StripeSync>('stripeSync')
    const stripe = Object.assign(stripeSync.stripe, mockStripe)
    vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)

    await stripeSync.getCurrentAccount()
  })

  afterAll(async () => {
    if (server) {
      await server.close()
    }
  })

  function getTableName(entityType: string): string {
    // custom handling for checkout.session
    if (entityType === 'checkout.session') {
      return 'checkout_session'
    }

    if (entityType.includes('.')) {
      // Handle cases where entityType has a prefix (e.g., "radar.early_fraud_warning")
      return entityType.split('.').pop() || entityType
    }

    return entityType
  }

  async function deleteTestData(entityType: string, entityId: string) {
    const tableName = getTableName(entityType)
    await postgresClient.query(`DELETE FROM stripe.${tableName}s WHERE id = $1`, [entityId])
  }

  test.each([
    'customer_updated.json',
    'customer_deleted.json',
    'customer_tax_id_created.json',
    'customer_tax_id_updated.json',
    'product_created.json',
    'product_updated.json',
    'price_created.json',
    'price_updated.json',
    'subscription_created.json',
    'subscription_deleted.json',
    'subscription_updated.json',
    'invoice_paid.json',
    'invoice_updated.json',
    'invoice_finalized.json',
    'charge_captured.json',
    'charge_expired.json',
    'charge_failed.json',
    'charge_pending.json',
    'charge_refunded.json',
    'charge_succeeded.json',
    'charge_updated.json',
    'setup_intent_canceled.json',
    'setup_intent_created.json',
    'setup_intent_requires_action.json',
    'setup_intent_setup_failed.json',
    'setup_intent_succeeded.json',
    'subscription_schedule_aborted.json',
    'subscription_schedule_canceled.json',
    'subscription_schedule_completed.json',
    'subscription_schedule_created.json',
    'subscription_schedule_expiring.json',
    'subscription_schedule_released.json',
    'subscription_schedule_updated.json',
    'payment_method_attached.json',
    'payment_method_automatically_updated.json',
    'payment_method_detached.json',
    'payment_method_updated.json',
    'charge_dispute_closed.json',
    'charge_dispute_created.json',
    'charge_dispute_funds_reinstated.json',
    'charge_dispute_funds_withdrawn.json',
    'charge_dispute_updated.json',
    'plan_created.json',
    'plan_updated.json',
    'payment_intent_amount_capturable_updated.json',
    'payment_intent_canceled.json',
    'payment_intent_created.json',
    'payment_intent_partially_funded.json',
    'payment_intent_payment_failed.json',
    'payment_intent_processing.json',
    'payment_intent_requires_action.json',
    'payment_intent_succeeded.json',
    'credit_note_created.json',
    'credit_note_updated.json',
    'credit_note_voided.json',
    'early_fraud_warning_created.json',
    'early_fraud_warning_updated.json',
    'review_closed.json',
    'review_opened.json',
    'refund_created.json',
    'refund_failed.json',
    'refund_updated.json',
    'checkout_session_completed.json',
  ])('event %s is upserted', async (jsonFile) => {
    const eventBody = await import(`./stripe/${jsonFile}`).then(({ default: myData }) => myData)
    // Update the event body created timestamp to be the current time
    eventBody.created = unixtime
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(eventBody)}`, 'utf8')
      .digest('hex')
    const entity = eventBody.data.object
    const entityId = entity.id
    const entityType = entity.object
    await deleteTestData(entityType, entityId)

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: eventBody,
    })

    if (response.statusCode != 200) {
      logger.error('error: ', response.body)
    }
    expect(response.statusCode).toBe(200)

    const tableName = getTableName(entityType)
    const result = await postgresClient.query(`SELECT * FROM stripe.${tableName}s WHERE id = $1`, [
      entityId,
    ])

    const rows = result.rows
    expect(rows.length).toBe(1)

    const dbEntity = rows[0]
    expect(dbEntity.id).toBe(entityId)

    const syncTimestamp = new Date(eventBody.created * 1000).toISOString()
    // Allow small timing differences (within 1 second) due to processing delays
    const dbTimestamp = dbEntity._last_synced_at.toISOString()
    const timeDiff = Math.abs(new Date(dbTimestamp).getTime() - new Date(syncTimestamp).getTime())
    expect(timeDiff).toBeLessThan(1000) // Less than 1 second difference
  })

  test.each([
    'customer_tax_id_deleted.json',
    'product_deleted.json',
    'price_deleted.json',
    'invoice_deleted.json',
    'plan_deleted.json',
    'refund_created.json',
    'refund_failed.json',
    'refund_updated.json',
    'active_entitlement_summary_updated.json',
    'invoice_upcoming.json',
  ])('process event %s', async (jsonFile) => {
    const eventBody = await import(`./stripe/${jsonFile}`).then(({ default: myData }) => myData)
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(eventBody)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: eventBody,
    })

    if (response.statusCode != 200) {
      logger.error('error: ', response.body)
    }
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ received: true })
  })

  test('webhook with older timestamp does not override newer data', async () => {
    const eventBody = await import('./stripe/charge_updated.json').then(
      ({ default: myData }) => myData
    )
    const entity = eventBody.data.object
    const entityId = entity.id
    const entityType = entity.object
    const tableName = getTableName(entityType)

    // Clean up any existing test data
    await deleteTestData(entityType, entityId)

    // Use a fresh timestamp to avoid Stripe's signature tolerance window (300s)
    // expiring when earlier tests take a long time to run
    const newerTimestamp = Math.floor(Date.now() / 1000)
    const newerEventBody = { ...eventBody, created: newerTimestamp }
    const newerSignature = createHmac('sha256', stripeWebhookSecret)
      .update(`${newerTimestamp}.${JSON.stringify(newerEventBody)}`, 'utf8')
      .digest('hex')

    const newerResponse = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${newerTimestamp},v1=${newerSignature},v0=ff`,
      },
      payload: newerEventBody,
    })

    expect(newerResponse.statusCode).toBe(200)

    // Verify the newer data was stored
    const newerResult = await postgresClient.query(
      `SELECT * FROM stripe.${tableName}s WHERE id = $1`,
      [entityId]
    )
    expect(newerResult.rows.length).toBe(1)
    const newerDbEntity = newerResult.rows[0]
    const newerSyncTimestamp = new Date(newerTimestamp * 1000).toISOString()
    expect(newerDbEntity._last_synced_at.toISOString()).toBe(newerSyncTimestamp)

    // Now send a webhook with an older timestamp and different paid value (should not override)
    const olderTimestamp = newerTimestamp - 60 // 1 minute older
    const olderEventBody = {
      ...eventBody,
      created: olderTimestamp,
      data: {
        ...eventBody.data,
        object: {
          ...eventBody.data.object,
          paid: !eventBody.data.object.paid, // Flip the paid value
        },
      },
    }
    const olderSignature = createHmac('sha256', stripeWebhookSecret)
      .update(`${olderTimestamp}.${JSON.stringify(olderEventBody)}`, 'utf8')
      .digest('hex')

    const olderResponse = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${olderTimestamp},v1=${olderSignature},v0=ff`,
      },
      payload: olderEventBody,
    })

    expect(olderResponse.statusCode).toBe(200)

    // Verify the data still has the newer timestamp and newer paid value (not overridden)
    const olderResult = await postgresClient.query(
      `SELECT * FROM stripe.${tableName}s WHERE id = $1`,
      [entityId]
    )
    expect(olderResult.rows.length).toBe(1)
    const olderDbEntity = olderResult.rows[0]
    expect(olderDbEntity._last_synced_at.toISOString()).toBe(newerSyncTimestamp)
    expect(olderDbEntity._last_synced_at.toISOString()).not.toBe(
      new Date(olderTimestamp * 1000).toISOString()
    )
    // Verify the paid field still reflects the newer webhook's value
    expect(olderDbEntity.paid).toBe(newerEventBody.data.object.paid)
    expect(olderDbEntity.paid).not.toBe(olderEventBody.data.object.paid)
  })
})
