import type { RevalidateEntity } from '@stripe/sync-engine'
import { config } from 'dotenv'
import type { ConnectionOptions } from 'node:tls'

function getConfigFromEnv(key: string, defaultValue?: string): string {
  const value = process.env[key]
  if (value == null && defaultValue === undefined) {
    throw new Error(`${key} is undefined`)
  }
  return value ?? defaultValue!
}

export type StripeSyncServerConfig = {
  /** Full host -> merchant runtime config registry. */
  merchantConfigByHost: Record<string, MerchantConfig>

  /** API_KEY is used by internal admin paths. */
  apiKey: string

  /** Stripe API version for the webhooks, defaults to 2020-08-27 */
  stripeApiVersion: string

  maxPostgresConnections?: number

  revalidateObjectsViaStripeApi: Array<RevalidateEntity>

  /** Optional Stripe partner ID (e.g. "pp_supabase"). */
  partnerId?: string

  /** Stripe account ID. Skips the Stripe API call in StripeSync.create() when provided. */
  stripeAccountId?: string

  port: number
  disableMigrations: boolean
  sslConnectionOptions?: ConnectionOptions
}

export type MerchantConfig = {
  stripeSecretKey: string
  stripeWebhookSecret: string
  databaseUrl: string
  enableSigma?: boolean
  autoExpandLists?: boolean
  backfillRelatedEntities?: boolean
}

export function normalizeHost(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase()
  if (!trimmed) return ''
  const host = trimmed.split(',')[0].trim()
  if (!host) return ''

  if (host.startsWith('[')) {
    const closingIdx = host.indexOf(']')
    if (closingIdx > -1) {
      return host.slice(0, closingIdx + 1)
    }
  }

  return host.split(':')[0]
}

export function getConfig(): StripeSyncServerConfig {
  config()

  const defaultEnableSigma = getConfigFromEnv('ENABLE_SIGMA', 'false') === 'true'
  const defaultAutoExpandLists = getConfigFromEnv('AUTO_EXPAND_LISTS', 'false') === 'true'
  const defaultBackfillRelatedEntities =
    getConfigFromEnv('BACKFILL_RELATED_ENTITIES', 'true') === 'true'
  const merchantConfigByHost = parseMerchantConfigFromEnv({
    defaultEnableSigma,
    defaultAutoExpandLists,
    defaultBackfillRelatedEntities,
  })

  return {
    merchantConfigByHost,
    apiKey: getConfigFromEnv('API_KEY', 'false'),
    stripeApiVersion: getConfigFromEnv('STRIPE_API_VERSION', '2020-08-27'),
    port: Number(getConfigFromEnv('PORT', '8080')),
    maxPostgresConnections: Number(getConfigFromEnv('MAX_POSTGRES_CONNECTIONS', '10')),
    revalidateObjectsViaStripeApi: getConfigFromEnv('REVALIDATE_OBJECTS_VIA_STRIPE_API', '')
      .split(',')
      .map((it) => it.trim())
      .filter((it) => it.length > 0) as Array<RevalidateEntity>,
    partnerId: process.env.STRIPE_PARTNER_ID || undefined,
    stripeAccountId: process.env.STRIPE_ACCOUNT_ID || undefined,
    disableMigrations: getConfigFromEnv('DISABLE_MIGRATIONS', 'false') === 'true',
    sslConnectionOptions: sslConnnectionOptionsFromEnv(),
  }
}

function parseMerchantConfigFromEnv(defaults: {
  defaultEnableSigma: boolean
  defaultAutoExpandLists: boolean
  defaultBackfillRelatedEntities: boolean
}): Record<string, MerchantConfig> {
  const rawMerchantConfig = getConfigFromEnv('MERCHANT_CONFIG_JSON')

  let parsedMerchantConfig: unknown
  try {
    parsedMerchantConfig = JSON.parse(rawMerchantConfig)
  } catch {
    throw new Error('MERCHANT_CONFIG_JSON must be valid JSON')
  }

  if (
    parsedMerchantConfig == null ||
    typeof parsedMerchantConfig !== 'object' ||
    Array.isArray(parsedMerchantConfig)
  ) {
    throw new Error('MERCHANT_CONFIG_JSON must be an object map keyed by host')
  }

  const merchantConfigByHost: Record<string, MerchantConfig> = {}
  for (const [rawHost, value] of Object.entries(parsedMerchantConfig)) {
    const host = normalizeHost(rawHost)
    if (!host) {
      throw new Error(`MERCHANT_CONFIG_JSON contains an invalid host key: "${rawHost}"`)
    }
    if (merchantConfigByHost[host]) {
      throw new Error(
        `MERCHANT_CONFIG_JSON contains duplicate host key after normalization: "${host}"`
      )
    }
    merchantConfigByHost[host] = parseSingleMerchantConfig(value, host, defaults)
  }

  if (Object.keys(merchantConfigByHost).length === 0) {
    throw new Error('MERCHANT_CONFIG_JSON must contain at least one host mapping')
  }

  return merchantConfigByHost
}

function parseSingleMerchantConfig(
  value: unknown,
  host: string,
  defaults: {
    defaultEnableSigma: boolean
    defaultAutoExpandLists: boolean
    defaultBackfillRelatedEntities: boolean
  }
): MerchantConfig {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MERCHANT_CONFIG_JSON["${host}"] must be an object`)
  }

  const merchant = value as Record<string, unknown>
  return {
    stripeSecretKey: getRequiredString(merchant.stripeSecretKey, `${host}.stripeSecretKey`),
    stripeWebhookSecret: getRequiredString(
      merchant.stripeWebhookSecret,
      `${host}.stripeWebhookSecret`
    ),
    databaseUrl: getRequiredString(merchant.databaseUrl, `${host}.databaseUrl`),
    enableSigma:
      getOptionalBoolean(merchant.enableSigma, `${host}.enableSigma`) ??
      defaults.defaultEnableSigma,
    autoExpandLists:
      getOptionalBoolean(merchant.autoExpandLists, `${host}.autoExpandLists`) ??
      defaults.defaultAutoExpandLists,
    backfillRelatedEntities:
      getOptionalBoolean(merchant.backfillRelatedEntities, `${host}.backfillRelatedEntities`) ??
      defaults.defaultBackfillRelatedEntities,
  }
}

function getRequiredString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`MERCHANT_CONFIG_JSON field "${fieldPath}" must be a non-empty string`)
  }
  return value
}

function getOptionalBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value == null) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`MERCHANT_CONFIG_JSON field "${fieldPath}" must be a boolean when defined`)
  }
  return value
}

function sslConnnectionOptionsFromEnv(): ConnectionOptions | undefined {
  const pgSslConfigEnabled = getConfigFromEnv('PG_SSL_CONFIG_ENABLED', 'false') === 'true'
  const pgSslRejectedUnauthorized =
    getConfigFromEnv('PG_SSL_REJECT_UNAUTHORIZED', 'false') === 'true'
  const pgSslCa = getConfigFromEnv('PG_SSL_CA', '')
  const pgSslCert = getConfigFromEnv('PG_SSL_CERT', '')
  const pgSslRequestCert = getConfigFromEnv('PG_SSL_REQUEST_CERT', 'false') === 'true'

  if (pgSslConfigEnabled) {
    return {
      rejectUnauthorized: pgSslRejectedUnauthorized,
      ca: pgSslCa ? pgSslCa : undefined,
      requestCert: pgSslRequestCert,
      cert: pgSslCert ? pgSslCert : undefined,
    }
  } else {
    return undefined
  }
}
