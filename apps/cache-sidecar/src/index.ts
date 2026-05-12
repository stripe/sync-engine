import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { FixedCostPricing } from './pricing.js'
import { createRedisClient } from './redis.js'
import { createApp } from './server.js'

const config = loadConfig()
const redis = createRedisClient(config)
const pricing = new FixedCostPricing(config.FIXED_EVENT_COST)

const app = createApp({ redis, config, pricing })

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(
    JSON.stringify({
      msg: 'cache-sidecar started',
      port: info.port,
      redis_url: config.REDIS_URL,
    })
  )
})

function shutdown() {
  console.log(JSON.stringify({ msg: 'shutting down' }))
  redis.disconnect()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
