import { describe, expect, it } from 'vitest'
import type { RemainingRange } from './index.js'
import { isSkippableError, reconcileRanges, withRateLimit } from './src-list-api.js'
import { StripeApiRequestError } from '@stripe/sync-openapi'
import type { ListFn } from '@stripe/sync-openapi'

describe('reconcileRanges', () => {
  it('returns remaining unchanged when accounted === incoming', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: 'cus_abc' },
      { gte: '2022', lt: '2024', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2018', lt: '2024' }
    )
    expect(result).toEqual(remaining)
  })

  it('drops ranges fully below new gte', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: 'cus_abc' },
      { gte: '2022', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2026' },
      { gte: '2020', lt: '2026' }
    )
    expect(result).toEqual([{ gte: '2022', lt: '2026', cursor: null }])
  })

  it('drops ranges fully above new lt', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2026' },
      { gte: '2018', lt: '2022' }
    )
    expect(result).toEqual([{ gte: '2018', lt: '2020', cursor: null }])
  })

  it('trims a range that overlaps the new gte and resets its cursor', () => {
    const remaining: RemainingRange[] = [{ gte: '2018', lt: '2022', cursor: 'cus_xyz' }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2020', lt: '2024' }
    )
    expect(result).toEqual([{ gte: '2020', lt: '2022', cursor: null }])
  })

  it('trims a range that overlaps the new lt but preserves its cursor', () => {
    const remaining: RemainingRange[] = [{ gte: '2022', lt: '2026', cursor: 'cus_abc' }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2026' },
      { gte: '2018', lt: '2024' }
    )
    expect(result).toEqual([{ gte: '2022', lt: '2024', cursor: 'cus_abc' }])
  })

  it('adds uncovered territory when lt is extended', () => {
    const result = reconcileRanges([], { gte: '2018', lt: '2024' }, { gte: '2018', lt: '2026' })
    expect(result).toEqual([{ gte: '2024', lt: '2026', cursor: null }])
  })

  it('adds uncovered territory when gte is decreased', () => {
    const remaining: RemainingRange[] = [{ gte: '2022', lt: '2024', cursor: 'cus_xyz' }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2016', lt: '2024' }
    )
    expect(result).toEqual([
      { gte: '2022', lt: '2024', cursor: 'cus_xyz' },
      { gte: '2016', lt: '2018', cursor: null },
    ])
  })

  it('handles both gte decreased and lt extended simultaneously', () => {
    const remaining: RemainingRange[] = [{ gte: '2020', lt: '2022', cursor: null }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2016', lt: '2026' }
    )
    expect(result).toEqual([
      { gte: '2020', lt: '2022', cursor: null },
      { gte: '2016', lt: '2018', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ])
  })

  it('handles empty remaining with extended lt', () => {
    const result = reconcileRanges([], { gte: '2018', lt: '2024' }, { gte: '2018', lt: '2026' })
    expect(result).toEqual([{ gte: '2024', lt: '2026', cursor: null }])
  })

  it('returns empty when incoming range is narrower and remaining is outside it', () => {
    const remaining: RemainingRange[] = [
      { gte: '2016', lt: '2018', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2016', lt: '2026' },
      { gte: '2018', lt: '2024' }
    )
    expect(result).toEqual([])
  })
})

describe('isSkippableError', () => {
  function makeError(message: string) {
    return new StripeApiRequestError(400, { error: { message } }, 'GET', '/v2/core/accounts')
  }

  describe.each([
    [
      'v2_core_accounts (platform)',
      "Accounts v2 is not enabled for your platform. If you're interested in using this API with your integration, please visit https://dashboard.stripe.com/acct_1DfwS2ClCIKljWvs/settings/connect/platform-setup. [GET /v2/core/accounts (400)] {request-id=req_v2HaQWYCiDgV6xQZ7, stripe-should-retry=false}",
      true,
    ],
    [
      'v2_core_accounts (livemode merchant)',
      'Accounts v2 is not enabled for your livemode merchant acct_1NIFdXLd02PKGbD5. Please visit https://docs.stripe.com/connect/use-accounts-as-customers to enable Accounts v2. [GET /v2/core/accounts (400)] {request-id=req_v2yowYQ7yMNDkuvFi, stripe-should-retry=false}',
      true,
    ],
    [
      'climate_order',
      'This account is not eligible for Climate Orders. [GET /v1/climate/orders (400)]',
      true,
    ],
    ['unrecognized error', 'Something went wrong', false],
    ['non-StripeApiRequestError', null, false],
  ])('%s', (_label, message, expected) => {
    it(`isSkippableError → ${expected}`, () => {
      const err = message === null ? new Error('Accounts v2 is not enabled') : makeError(message)
      expect(isSkippableError(err)).toBe(expected)
    })
  })
})

describe('withRateLimit', () => {
  const noopRateLimiter = async () => 0

  it('passes through to listFn when no signal is provided', async () => {
    const listFn: ListFn = async () => ({ data: [{ id: '1' }], has_more: false })
    const wrapped = withRateLimit(listFn, noopRateLimiter)
    const result = await wrapped({})
    expect(result).toEqual({ data: [{ id: '1' }], has_more: false })
  })

  it('aborts a blocked listFn when signal fires', async () => {
    const ac = new AbortController()
    // listFn that blocks for 10s (simulates slow retry backoff)
    const listFn: ListFn = () =>
      new Promise((resolve) => setTimeout(() => resolve({ data: [], has_more: false }), 10_000))

    const wrapped = withRateLimit(listFn, noopRateLimiter, ac.signal)
    const promise = wrapped({})

    // Abort after 10ms
    setTimeout(() => ac.abort(), 10)

    await expect(promise).rejects.toThrow()
    // Should resolve nearly instantly, not after 10s
  })

  it('throws immediately if signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()

    const listFn: ListFn = async () => ({ data: [], has_more: false })
    const wrapped = withRateLimit(listFn, noopRateLimiter, ac.signal)

    await expect(wrapped({})).rejects.toThrow()
  })

  it('does not interfere with listFn errors when signal is present', async () => {
    const ac = new AbortController()
    const listFn: ListFn = async () => {
      throw new Error('API error')
    }
    const wrapped = withRateLimit(listFn, noopRateLimiter, ac.signal)

    await expect(wrapped({})).rejects.toThrow('API error')
  })
})
