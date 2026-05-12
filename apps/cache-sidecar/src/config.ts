import { z } from 'zod'

const ConfigSchema = z.object({
  REDIS_URL: z.string().default('redis://localhost:56379'),
  CHECKPOINT_PREFIX: z.string().default('sync:'),
  OPTIMISTIC_PREFIX: z.string().default('optimistic:'),
  CREDIT_TYPE_ID: z.string(),
  PORT: z.coerce.number().default(4100),
  WATERMARK_BUFFER_MS: z.coerce.number().default(10000),
  FIXED_EVENT_COST: z.coerce.number().positive().default(1),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format())
    process.exit(1)
  }
  return result.data
}
