import { createHmac, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { log } from './logger.js'

/**
 * Verify a Metronome webhook signature.
 * Metronome signs: HMAC-SHA256(secret, date + "\n" + body)
 * Header: Metronome-Webhook-Signature
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  date: string,
  secret: string
): void {
  const expected = createHmac('sha256', secret).update(`${date}\n${body}`).digest('hex')

  const sigBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new Error('Webhook signature verification failed')
  }
}

export interface MetronomeWebhookEvent {
  type: string
  id?: string
  customer_id?: string
  contract_id?: string
  timestamp?: string
  properties?: Record<string, unknown>
}

export interface WebhookInput {
  event: MetronomeWebhookEvent
  raw_body: string
  verified: boolean
}

export type WebhookPushFn = (input: WebhookInput) => void | Promise<void>

/**
 * Start an HTTP server that receives Metronome webhook events.
 * Verifies signatures if a secret is provided, then pushes parsed events.
 */
export function startWebhookServer(
  port: number,
  secret: string | undefined,
  push: WebhookPushFn
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8')

      try {
        let verified = false
        if (secret) {
          const signature = req.headers['metronome-webhook-signature'] as string | undefined
          const date = req.headers['date'] as string | undefined
          if (!signature || !date) {
            res.writeHead(400).end('Missing Metronome-Webhook-Signature or Date header')
            return
          }
          verifyWebhookSignature(body, signature, date, secret)
          verified = true
        }

        const event = JSON.parse(body) as MetronomeWebhookEvent
        log.info(
          { eventType: event.type, eventId: event.id, verified },
          'metronome: webhook received'
        )

        const result = push({ event, raw_body: body, verified })
        if (result && typeof result.then === 'function') {
          await result
        }
        res.writeHead(200).end('{"received":true}')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ error: message }, 'metronome: webhook processing error')
        res.writeHead(400).end(message)
      }
    })
  })

  server.listen(port, () => {
    log.info({ port }, 'metronome: webhook server listening')
  })

  return server
}
