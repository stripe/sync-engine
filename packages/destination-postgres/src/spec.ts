import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z
  .object({
    url: z.string().optional().describe('Postgres connection string'),
    connection_string: z.string().optional().describe('Deprecated alias for url; prefer url'),
    schema: z.string().describe('Target schema name (e.g. "stripe")').default('public'),
    batch_size: z.number().default(100).describe('Records to buffer before flushing'),
    aws: z
      .object({
        host: z.string().describe('Postgres host for RDS IAM auth'),
        port: z.number().default(5432).describe('Postgres port for RDS IAM auth'),
        database: z.string().describe('Database name for RDS IAM auth'),
        user: z.string().describe('Database user for RDS IAM auth'),
        region: z.string().describe('AWS region for RDS instance'),
        role_arn: z.string().optional().describe('IAM role ARN to assume (cross-account)'),
        external_id: z.string().optional().describe('External ID for STS AssumeRole'),
      })
      .optional()
      .describe('AWS RDS IAM authentication config'),
    allow_experimental_pglite: z
      .boolean()
      .optional()
      .describe('Enable experimental PGlite support (required to use pglite config or file:///memory:// URLs)'),
    pglite: z
      .union([
        z.literal(true),
        z.object({
          data_dir: z.string().optional().describe('Directory for persistent storage (omit for in-memory)'),
        }),
      ])
      .optional()
      .describe('Use PGlite (in-process WASM Postgres) instead of connecting to an external server'),
    ssl_ca_pem: z
      .string()
      .optional()
      .describe(
        'PEM-encoded CA certificate for SSL verification (required for verify-ca / verify-full with a private CA)'
      ),
  })
  .refine((config) => !((config.url || config.connection_string) && config.aws), {
    message: 'Specify either url/connection_string or aws config, not both',
    path: ['aws'],
  })
  .refine((config) => !(config.pglite && (config.url || config.connection_string || config.aws)), {
    message: 'Specify pglite OR url/connection_string/aws, not both',
    path: ['pglite'],
  })
  .refine(
    (config) => {
      if (config.pglite) return config.allow_experimental_pglite === true
      const url = config.url ?? config.connection_string
      if (url && (url.startsWith('file://') || url.startsWith('memory://')))
        return config.allow_experimental_pglite === true
      return true
    },
    {
      message: 'Set allow_experimental_pglite: true to use PGlite or file:///memory:// URLs',
      path: ['allow_experimental_pglite'],
    }
  )

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
