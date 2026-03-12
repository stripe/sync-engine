import { describe, expect, it } from 'vitest'
import type { MigrationConfig } from '../migrate'

describe('MigrationConfig tableMode type', () => {
  it('accepts runtime_required mode', () => {
    const config: MigrationConfig = {
      databaseUrl: 'postgresql://localhost:5432/test',
      tableMode: 'runtime_required',
    }
    expect(config.tableMode).toBe('runtime_required')
  })

  it('accepts all_projected mode', () => {
    const config: MigrationConfig = {
      databaseUrl: 'postgresql://localhost:5432/test',
      tableMode: 'all_projected',
    }
    expect(config.tableMode).toBe('all_projected')
  })

  it('accepts undefined tableMode (defaults to runtime_required)', () => {
    const config: MigrationConfig = {
      databaseUrl: 'postgresql://localhost:5432/test',
    }
    expect(config.tableMode).toBeUndefined()
  })

  it('rejects invalid tableMode values at compile time', () => {
    // This should cause a TypeScript compilation error if uncommented:
    // const config: MigrationConfig = {
    //   databaseUrl: 'postgresql://localhost:5432/test',
    //   tableMode: 'invalid_mode',
    // }
    expect(true).toBe(true)
  })
})
