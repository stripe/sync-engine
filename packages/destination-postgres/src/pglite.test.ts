import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import destination, { deleteMany, upsertMany, writeMany, pgliteClient } from './index.js'
import type { ManagedClient } from './client.js'
import type { ConfiguredCatalog, DestinationInput, DestinationOutput } from '@stripe/sync-protocol'
import { collectFirst, drain } from '@stripe/sync-protocol'
import type { Config } from './spec.js'

const SCHEMA = 'test_dest'
let dataDir: string

function makeConfig(): Config {
  return { pglite: { data_dir: dataDir }, schema: SCHEMA, batch_size: 100, allow_experimental_pglite: true }
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pglite-test-'))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

let nextRecordTs = Math.floor(Date.now() / 1000)
function makeRecord(stream: string, data: Record<string, unknown>) {
  return {
    type: 'record' as const,
    record: {
      stream,
      data: { _updated_at: nextRecordTs++, ...data },
      emitted_at: new Date().toISOString(),
    },
  }
}

function makeState(stream: string, data: unknown) {
  return { type: 'source_state' as const, source_state: { stream, data } }
}

async function* toAsyncIter(msgs: DestinationInput[]): AsyncIterable<DestinationInput> {
  for (const msg of msgs) yield msg
}

async function collectOutputs(iter: AsyncIterable<DestinationOutput>): Promise<DestinationOutput[]> {
  const results: DestinationOutput[] = []
  for await (const msg of iter) results.push(msg)
  return results
}

async function resetSchema() {
  const c = await pgliteClient({ data_dir: dataDir })
  await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await c.close()
}

const catalog: ConfiguredCatalog = {
  streams: [
    {
      stream: {
        name: 'customer',
        primary_key: [['id']],
        newer_than_field: '_updated_at',
        metadata: {},
      },
      sync_mode: 'full_refresh',
      destination_sync_mode: 'overwrite',
    },
  ],
}

describe('PGlite destination', () => {
  beforeEach(async () => {
    await resetSchema()
  })

  describe('check()', () => {
    it('succeeds with pglite config', async () => {
      const statusMsg = await collectFirst(
        destination.check({ config: makeConfig() }),
        'connection_status'
      )
      expect(statusMsg.connection_status.status).toBe('succeeded')
    })
  })

  describe('setup()', () => {
    it('creates schema and table', async () => {
      await drain(destination.setup!({ config: makeConfig(), catalog }))

      const c = await pgliteClient({ data_dir: dataDir })
      try {
        const { rows } = await c.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
          [SCHEMA]
        )
        expect(rows.map((r) => r.table_name)).toContain('customer')
      } finally {
        await c.close()
      }
    })
  })

  describe('write()', () => {
    beforeEach(async () => {
      await drain(destination.setup!({ config: makeConfig(), catalog }))
    })

    it('upserts records via PGlite', async () => {
      const messages = toAsyncIter([
        makeRecord('customer', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customer', { id: 'cus_2', name: 'Bob' }),
      ])

      const outputs = await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages))
      const records = outputs.filter((m) => m.type === 'record')
      expect(records).toHaveLength(2)
    })

    it('re-emits SourceStateMessage after flushing', async () => {
      const stateData = { cursor: 'abc123' }
      const messages = toAsyncIter([
        makeRecord('customer', { id: 'cus_1', name: 'Alice' }),
        makeState('customer', stateData),
      ])

      const outputs = await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages))
      const stateOutputs = outputs.filter((m) => m.type === 'source_state')
      expect(stateOutputs).toHaveLength(1)
      expect(stateOutputs[0]).toEqual({
        type: 'source_state',
        source_state: { stream: 'customer', data: stateData },
      })
    })

    it('handles upsert (ON CONFLICT update)', async () => {
      const messages1 = toAsyncIter([makeRecord('customer', { id: 'cus_1', name: 'Alice' })])
      await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages1))

      const messages2 = toAsyncIter([makeRecord('customer', { id: 'cus_1', name: 'Alice Updated' })])
      await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages2))

      const c = await pgliteClient({ data_dir: dataDir })
      try {
        const { rows } = await c.query(
          `SELECT _raw_data->>'name' AS name FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
        )
        expect(rows[0].name).toBe('Alice Updated')
      } finally {
        await c.close()
      }
    })
  })
})

describe('PGlite upsertMany / deleteMany / writeMany', () => {
  let client: ManagedClient

  beforeEach(async () => {
    client = await pgliteClient({ data_dir: dataDir })
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`)
    await client.query(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".customer (
      "_raw_data" jsonb NOT NULL,
      "_synced_at" timestamptz NOT NULL DEFAULT now(),
      "_updated_at" timestamptz NOT NULL DEFAULT now(),
      "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
      PRIMARY KEY ("id")
    )`)
  })

  afterEach(async () => {
    await client?.close()
  })

  it('upsertMany inserts records', async () => {
    const ts = Math.floor(Date.now() / 1000)
    await upsertMany(
      client,
      SCHEMA,
      'customer',
      [
        { id: 'cus_10', name: 'Direct', _updated_at: ts },
        { id: 'cus_11', name: 'Insert', _updated_at: ts },
      ],
      ['id'],
      '_updated_at'
    )

    const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customer`)
    expect(rows[0].n).toBe(2)
  })

  it('deleteMany removes rows', async () => {
    const ts = Math.floor(Date.now() / 1000)
    await upsertMany(
      client,
      SCHEMA,
      'customer',
      [
        { id: 'cus_keep', name: 'Keep', _updated_at: ts },
        { id: 'cus_drop', name: 'Drop', _updated_at: ts },
      ],
      ['id'],
      '_updated_at'
    )

    const result = await deleteMany(client, SCHEMA, 'customer', [{ id: 'cus_drop' }], ['id'])
    expect(result.deleted_count).toBe(1)

    const { rows } = await client.query(`SELECT id FROM "${SCHEMA}".customer ORDER BY id`)
    expect(rows).toEqual([{ id: 'cus_keep' }])
  })

  it('writeMany routes mixed batch to upsert and delete', async () => {
    const ts = Math.floor(Date.now() / 1000)
    await upsertMany(
      client,
      SCHEMA,
      'customer',
      [{ id: 'cus_old', name: 'Old', _updated_at: ts }],
      ['id'],
      '_updated_at'
    )

    const result = await writeMany(
      client,
      SCHEMA,
      'customer',
      [
        { data: { id: 'cus_new', name: 'New', _updated_at: ts + 1 } },
        { recordDeleted: true, data: { id: 'cus_old', _updated_at: ts + 1 } },
      ],
      ['id'],
      '_updated_at'
    )
    expect(result.created_count).toBe(1)
    expect(result.deleted_count).toBe(1)

    const { rows } = await client.query(`SELECT id FROM "${SCHEMA}".customer ORDER BY id`)
    expect(rows).toEqual([{ id: 'cus_new' }])
  })
})
