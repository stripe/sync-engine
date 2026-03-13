import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'node:http'
import { runMigrations } from '@stripe/sync-engine'
import { createServer } from './app'
import { getConfig } from './utils/config'
import { logger } from './logger'

const main = async () => {
  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = await createServer({
    loggerInstance: logger,
    disableRequestLogging: true,
    exposeDocs: false,
    requestIdHeader: 'Request-Id',
  })

  const config = getConfig()

  if (!config.disableMigrations) {
    const migratedDatabaseUrls = new Set<string>()
    for (const merchantConfig of Object.values(config.merchantConfigByHost)) {
      if (migratedDatabaseUrls.has(merchantConfig.databaseUrl)) continue
      migratedDatabaseUrls.add(merchantConfig.databaseUrl)
      await runMigrations({
        databaseUrl: merchantConfig.databaseUrl,
        logger: logger,
        ssl: config.sslConnectionOptions,
      })
    }
  }

  // Start the server
  app.listen({ port: Number(config.port), host: '0.0.0.0' }, (err, address) => {
    if (err) {
      logger.error(err)
      process.exit(1)
    }
    logger.info(`Server listening at ${address}`)
  })
}

main()
