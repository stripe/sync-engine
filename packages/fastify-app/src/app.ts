import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import autoload from '@fastify/autoload'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { join } from 'node:path'
import { getConfig, normalizeHost } from './utils/config'
import { StripeSync } from 'stripe-experiment-sync'
import { errorSchema } from './error'
import { logger } from './logger'
import { type PoolConfig } from 'pg'

interface buildOpts extends FastifyServerOptions {
  exposeDocs?: boolean
}

export async function createServer(opts: buildOpts = {}): Promise<FastifyInstance> {
  const app = fastify(opts)

  const config = getConfig()
  app.decorate('merchantConfigByHost', config.merchantConfigByHost)
  app.decorate('resolveMerchantByHost', (host: string) => {
    const normalized = normalizeHost(host)
    if (!normalized) return undefined
    const merchantConfig = config.merchantConfigByHost[normalized]
    if (!merchantConfig) return undefined
    return {
      host: normalized,
      config: merchantConfig,
    }
  })
  app.decorate('createStripeSyncForHost', async (host: string) => {
    const merchantRuntime = app.resolveMerchantByHost(host)
    if (!merchantRuntime) return undefined

    const poolConfig: PoolConfig = {
      max: config.maxPostgresConnections ?? 10,
      connectionString: merchantRuntime.config.databaseUrl,
      keepAlive: true,
      ssl: config.sslConnectionOptions,
    }

    return StripeSync.create({
      ...merchantRuntime.config,
      stripeApiVersion: config.stripeApiVersion,
      stripeAccountId: config.stripeAccountId,
      revalidateObjectsViaStripeApi: config.revalidateObjectsViaStripeApi,
      ...(config.partnerId ? { partnerId: config.partnerId } : {}),
      logger,
      poolConfig,
    })
  })

  /**
   * Expose swagger docs
   */
  if (opts.exposeDocs) {
    await app.register(fastifySwagger, {
      mode: 'dynamic',
      swagger: {
        info: {
          title: 'Stripe Sync Engine',
          version: '0.0.1',
        },
      },
    })

    await app.register(fastifySwaggerUi, {
      routePrefix: '/docs',
    })
  }

  /**
   * Add a content parser for stripe webhooks
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      let newBody
      switch (req.routeOptions.url) {
        case '/webhooks':
          newBody = { raw: body }
          break
        default:
          newBody = JSON.parse(body.toString())
          break
      }
      done(null, newBody)
    } catch (error) {
      error.statusCode = 400
      done(error, undefined)
    }
  })

  /**
   * Add common schemas
   */
  app.addSchema(errorSchema)

  /**
   * Expose all routes in './routes'
   */
  await app.register(autoload, {
    dir: join(__dirname, 'routes'),
  })

  await app.ready()

  return app
}
