import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import spec, { configSchema, stripeEventSchema, streamStateSpec } from './spec.js'
import { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS } from '@stripe/sync-openapi'

describe('configSchema api_version field', () => {
  it('only accepts known enum values', () => {
    expect(configSchema.shape.api_version.safeParse(BUNDLED_API_VERSION).success).toBe(true)
    expect(configSchema.shape.api_version.safeParse('2099-01-01.unknown').success).toBe(false)
    expect(configSchema.shape.api_version.safeParse(undefined).success).toBe(true)
  })

  it('exposes supported versions via JSON Schema enum', () => {
    const jsonSchema = spec.config as {
      properties?: Record<string, { enum?: string[]; description?: string }>
    }
    const field = jsonSchema.properties?.api_version

    expect(field).toBeDefined()
    expect(field!.enum).toEqual([...SUPPORTED_API_VERSIONS])
    expect(field!.description).toContain(BUNDLED_API_VERSION)
  })

  it('clients can extract supported API versions from config_schema', () => {
    // This is the pattern clients use: read config_schema from
    // GET /meta/sources/stripe, then inspect the api_version field.
    const schema = spec.config as {
      properties?: Record<string, { enum?: string[] }>
    }
    const versions: string[] = schema.properties?.api_version?.enum ?? []

    expect(versions).toContain(BUNDLED_API_VERSION)
    expect(versions.length).toBeGreaterThan(0)
  })
})

describe('streamStateSpec JSON Schema round-trip', () => {
  it('accounted_range survives toJSONSchema → fromJSONSchema round-trip', () => {
    // The engine converts streamStateSpec to JSON Schema (spec export) then back
    // to Zod (z.fromJSONSchema). State with accounted_range must survive this
    // round-trip or parseSyncState discards all state, breaking incremental sync.
    const jsonSchema = z.toJSONSchema(streamStateSpec)
    const zodFromJson = z.fromJSONSchema(jsonSchema)

    const stateWithAccounted = {
      accounted_range: { gte: '2019-08-21T20:19:01.000Z', lt: '2026-04-19T22:10:49.000Z' },
      remaining: [],
    }
    expect(zodFromJson.safeParse(stateWithAccounted).success).toBe(true)
  })

  it('accepts state without accounted_range (first checkpoint)', () => {
    const jsonSchema = z.toJSONSchema(streamStateSpec)
    const zodFromJson = z.fromJSONSchema(jsonSchema)

    expect(zodFromJson.safeParse({ remaining: [] }).success).toBe(true)
  })

  it('accepts state with remaining ranges and accounted_range', () => {
    const jsonSchema = z.toJSONSchema(streamStateSpec)
    const zodFromJson = z.fromJSONSchema(jsonSchema)

    const stateInProgress = {
      accounted_range: { gte: '2019-01-01T00:00:00.000Z', lt: '2026-01-01T00:00:00.000Z' },
      remaining: [
        { gte: '2019-01-01T00:00:00.000Z', lt: '2023-01-01T00:00:00.000Z', cursor: null },
        { gte: '2025-06-01T00:00:00.000Z', lt: '2025-06-02T00:00:00.000Z', cursor: 'cur_abc' },
      ],
    }
    expect(zodFromJson.safeParse(stateInProgress).success).toBe(true)
  })
})

describe('stripeEventSchema', () => {
  it('accepts request as a plain string (older API versions)', () => {
    const event = {
      id: 'evt_test',
      object: 'event',
      api_version: '2020-08-27',
      created: 1234567890,
      data: { object: {} },
      livemode: false,
      pending_webhooks: 0,
      request: 'req_xxxxx',
      type: 'charge.created',
    }
    expect(stripeEventSchema.safeParse(event).success).toBe(true)
  })

  it('accepts request as an object (modern API versions)', () => {
    const event = {
      id: 'evt_test',
      object: 'event',
      api_version: '2020-08-27',
      created: 1234567890,
      data: { object: {} },
      livemode: false,
      pending_webhooks: 0,
      request: { id: 'req_xxxxx', idempotency_key: null },
      type: 'charge.created',
    }
    expect(stripeEventSchema.safeParse(event).success).toBe(true)
  })

  it('accepts request as null', () => {
    const event = {
      id: 'evt_test',
      object: 'event',
      api_version: '2020-08-27',
      created: 1234567890,
      data: { object: {} },
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'charge.created',
    }
    expect(stripeEventSchema.safeParse(event).success).toBe(true)
  })
})
