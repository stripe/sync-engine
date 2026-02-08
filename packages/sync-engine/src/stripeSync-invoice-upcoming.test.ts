import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSync } from './stripeSync'
import type Stripe from 'stripe'

/**
 * Unit tests for invoice.upcoming handling.
 *
 * Verifies that:
 * 1. invoice.upcoming is not in the supported event types (removed from handler registry)
 * 2. Events whose data.object lacks an id are skipped gracefully (defensive guard)
 * 3. No database write is attempted for id-less events
 */

describe('invoice.upcoming handling', () => {
  let stripeSync: StripeSync

  beforeEach(() => {
    stripeSync = new StripeSync({
      stripeSecretKey: 'sk_test_fake',
      databaseUrl: 'postgresql://localhost:5432/fake_db',
      poolConfig: {},
    })
  })

  it('should not include invoice.upcoming in supported event types', () => {
    const supportedEvents = stripeSync.getSupportedEventTypes()
    expect(supportedEvents).not.toContain('invoice.upcoming')
  })

  it('should include other invoice events in supported event types', () => {
    const supportedEvents = stripeSync.getSupportedEventTypes()
    expect(supportedEvents).toContain('invoice.created')
    expect(supportedEvents).toContain('invoice.paid')
    expect(supportedEvents).toContain('invoice.finalized')
    expect(supportedEvents).toContain('invoice.updated')
  })

  it('should skip events whose data.object has no id', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    stripeSync = new StripeSync({
      stripeSecretKey: 'sk_test_fake',
      databaseUrl: 'postgresql://localhost:5432/fake_db',
      poolConfig: {},
      logger,
    })

    // Mock getAccountId and getCurrentAccount to avoid real Stripe/DB calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync as any).getAccountId = vi.fn().mockResolvedValue('acct_test')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync as any).getCurrentAccount = vi.fn().mockResolvedValue({ id: 'acct_test' })

    // Spy on upsertInvoices to verify it's never called
    const upsertSpy = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync as any).upsertInvoices = upsertSpy

    // Simulate an invoice.upcoming event (no id on data.object)
    const event = {
      id: 'evt_test_upcoming',
      type: 'invoice.upcoming',
      data: {
        object: {
          object: 'invoice',
          currency: 'usd',
          customer: 'cus_test123',
          subscription: 'sub_test123',
          total: 10000,
          // No 'id' field — this is a preview invoice
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    // processEvent should complete without error
    await expect(stripeSync.processEvent(event)).resolves.toBeUndefined()

    // Verify upsertInvoices was never called
    expect(upsertSpy).not.toHaveBeenCalled()

    // Verify the skip was logged
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping webhook evt_test_upcoming')
    )
  })

  it('should process normal invoice events that have an id', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    stripeSync = new StripeSync({
      stripeSecretKey: 'sk_test_fake',
      databaseUrl: 'postgresql://localhost:5432/fake_db',
      poolConfig: {},
      logger,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync as any).getAccountId = vi.fn().mockResolvedValue('acct_test')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync as any).getCurrentAccount = vi.fn().mockResolvedValue({ id: 'acct_test' })

    // Mock the handler to verify it IS called for normal invoice events
    const handlerSpy = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync as any).eventHandlers['invoice.paid'] = handlerSpy

    const event = {
      id: 'evt_test_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test123',
          object: 'invoice',
          currency: 'usd',
          customer: 'cus_test123',
          status: 'paid',
          total: 10000,
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.processEvent(event)).resolves.toBeUndefined()

    // The handler should have been called for a normal invoice with an id
    expect(handlerSpy).toHaveBeenCalledWith(event, 'acct_test')
  })
})
