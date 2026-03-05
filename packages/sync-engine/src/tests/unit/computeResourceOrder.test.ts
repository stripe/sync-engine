import { describe, it, expect } from 'vitest'
import { computeResourceOrder } from '../../utils/computeResourceOrder'

describe('computeResourceOrder', () => {
  it('returns empty map for empty input', () => {
    const result = computeResourceOrder({})
    expect(result.size).toBe(0)
  })

  it('places dependencies before their dependents', () => {
    const result = computeResourceOrder({
      price: { dependencies: ['product'] },
      product: {},
    })
    expect(result.get('product')).toBeLessThan(result.get('price')!)
  })

  it('handles a linear dependency chain', () => {
    const result = computeResourceOrder({
      subscription: { dependencies: ['price'] },
      price: { dependencies: ['product'] },
      product: {},
    })
    expect(result.get('product')).toBe(1)
    expect(result.get('price')).toBe(2)
    expect(result.get('subscription')).toBe(3)
  })

  it('handles diamond-shaped dependencies', () => {
    const result = computeResourceOrder({
      product: {},
      price: { dependencies: ['product'] },
      coupon: { dependencies: ['product'] },
      subscription: { dependencies: ['price', 'coupon'] },
    })
    expect(result.get('product')).toBe(1)
    expect(result.get('price')).toBeLessThan(result.get('subscription')!)
    expect(result.get('coupon')).toBeLessThan(result.get('subscription')!)
  })

  it('ignores dependencies on unknown resources', () => {
    const result = computeResourceOrder({
      price: { dependencies: ['nonexistent'] },
      product: {},
    })
    expect(result.size).toBe(2)
    expect(result.has('price')).toBe(true)
    expect(result.has('product')).toBe(true)
  })

  it('handles resources with empty dependency arrays', () => {
    const result = computeResourceOrder({
      product: { dependencies: [] },
      customer: { dependencies: [] },
    })
    expect(result.size).toBe(2)
  })

  it('throws on circular dependency between two resources', () => {
    expect(() =>
      computeResourceOrder({
        a: { dependencies: ['b'] },
        b: { dependencies: ['a'] },
      })
    ).toThrow('Circular dependency detected among: a, b')
  })

  it('throws on circular dependency in a cycle of three', () => {
    expect(() =>
      computeResourceOrder({
        a: { dependencies: ['c'] },
        b: { dependencies: ['a'] },
        c: { dependencies: ['b'] },
      })
    ).toThrow('Circular dependency detected among: a, b, c')
  })

  it('throws on self-referencing dependency', () => {
    expect(() =>
      computeResourceOrder({
        a: { dependencies: ['a'] },
      })
    ).toThrow('Circular dependency detected among: a')
  })

  it('handles multiple independent dependency chains', () => {
    const result = computeResourceOrder({
      product: {},
      price: { dependencies: ['product'] },
      customer: {},
      subscription: { dependencies: ['customer'] },
    })
    expect(result.get('product')).toBeLessThan(result.get('price')!)
    expect(result.get('customer')).toBeLessThan(result.get('subscription')!)
  })
})
