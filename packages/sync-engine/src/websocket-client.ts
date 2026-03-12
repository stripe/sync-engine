import WebSocket from 'ws'

const CLI_VERSION = '1.33.0'

// Timing constants (matching Stripe CLI)
const PONG_WAIT = 10 * 1000 // 10 seconds - max time to wait for pong
const PING_PERIOD = (PONG_WAIT * 2) / 10 // 2 seconds - send ping before pong timeout
const CONNECT_ATTEMPT_WAIT = 10 * 1000 // 10 seconds - retry interval on connection failure

export interface WebhookProcessingResult {
  status: number
  databaseUrl: string

  event_type?: string
  event_id?: string
  error?: string
}

export interface WebhookResponse {
  forward_url: string
  status: number
  http_headers: Record<string, string>
  body: string
  type: 'webhook_response'
  webhook_conversation_id: string
  webhook_id: string
  request_headers: Record<string, string>
  request_body: string
  notification_id: string
}

export interface StripeWebSocketOptions {
  stripeApiKey: string
  onEvent: (
    event: StripeWebhookEvent
  ) => Promise<WebhookProcessingResult | void> | WebhookProcessingResult | void
  onReady?: (secret: string) => void
  onError?: (error: Error) => void
  onClose?: (code: number, reason: string) => void
}

export interface StripeWebSocketClient {
  close: () => void
  isConnected: () => boolean
}

interface CliSession {
  websocket_url: string
  websocket_id: string
  websocket_authorized_feature: string
  secret: string
  reconnect_delay: number
}

export interface StripeWebhookEvent {
  type: string
  webhook_id: string
  webhook_conversation_id: string
  event_payload: string
  http_headers: Record<string, string>
  endpoint: {
    url: string
    status: string
  }
}

interface EventAck {
  type: 'event_ack'
  event_id: string
  webhook_conversation_id: string
  webhook_id: string
}

function getClientUserAgent(): string {
  return JSON.stringify({
    name: 'stripe-cli',
    version: CLI_VERSION,
    publisher: 'stripe',
    os: process.platform,
  })
}

async function createCliSession(stripeApiKey: string): Promise<CliSession> {
  const params = new URLSearchParams()
  params.append('device_name', 'stripe-sync-engine')
  params.append('websocket_features[]', 'webhooks')

  const response = await fetch('https://api.stripe.com/v1/stripecli/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeApiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `Stripe/v1 stripe-cli/${CLI_VERSION}`,
      'X-Stripe-Client-User-Agent': getClientUserAgent(),
    },
    body: params.toString(),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create CLI session: ${error}`)
  }

  return (await response.json()) as CliSession
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function createStripeWebSocketClient(
  options: StripeWebSocketOptions
): Promise<StripeWebSocketClient> {
  const { stripeApiKey, onEvent, onReady, onError, onClose } = options

  // Create session
  const session = await createCliSession(stripeApiKey)

  let ws: WebSocket | null = null
  let pingInterval: NodeJS.Timeout | null = null
  let connected = false
  let shouldRun = true
  let lastPongReceived: number = Date.now()

  // Signals for the run loop
  let notifyCloseResolve: (() => void) | null = null
  let stopResolve: (() => void) | null = null

  function cleanupConnection() {
    if (pingInterval) {
      clearInterval(pingInterval)
      pingInterval = null
    }
    if (ws) {
      ws.removeAllListeners()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Resetting connection')
      }
      ws = null
    }
    connected = false
  }

  function setupWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      lastPongReceived = Date.now()
      const wsUrl = `${session.websocket_url}?websocket_feature=${encodeURIComponent(session.websocket_authorized_feature)}`

      ws = new WebSocket(wsUrl, {
        headers: {
          'Accept-Encoding': 'identity',
          'User-Agent': `Stripe/v1 stripe-cli/${CLI_VERSION}`,
          'X-Stripe-Client-User-Agent': getClientUserAgent(),
          'Websocket-Id': session.websocket_id,
        },
      })

      const connectionTimeout = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.CONNECTING) {
          ws.terminate()
          reject(new Error('WebSocket connection timeout'))
        }
      }, CONNECT_ATTEMPT_WAIT)

      ws.on('pong', () => {
        lastPongReceived = Date.now()
      })

      ws.on('open', () => {
        clearTimeout(connectionTimeout)
        connected = true

        // Start ping/pong heartbeat
        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            const timeSinceLastPong = Date.now() - lastPongReceived
            if (timeSinceLastPong > PONG_WAIT) {
              // Connection stale - trigger reconnect
              if (onError) {
                onError(new Error(`WebSocket stale: no pong in ${timeSinceLastPong}ms`))
              }
              if (notifyCloseResolve) {
                notifyCloseResolve()
                notifyCloseResolve = null
              }
              ws.terminate()
              return
            }
            ws.ping()
          }
        }, PING_PERIOD)

        if (onReady) {
          onReady(session.secret)
        }

        resolve()
      })

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString()) as StripeWebhookEvent

          // Send acknowledgment IMMEDIATELY (before processing)
          const ack: EventAck = {
            type: 'event_ack',
            event_id: message.webhook_id,
            webhook_conversation_id: message.webhook_conversation_id,
            webhook_id: message.webhook_id,
          }

          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(ack))
          }

          // Process the event after ack is sent
          let response: WebhookResponse
          try {
            const result = await onEvent(message)
            response = {
              type: 'webhook_response',
              webhook_id: message.webhook_id,
              webhook_conversation_id: message.webhook_conversation_id,
              forward_url: 'stripe-sync-engine',
              status: result?.status ?? 200,
              http_headers: {},
              body: JSON.stringify({
                event_type: result?.event_type,
                event_id: result?.event_id,
                database_url: result?.databaseUrl,
                error: result?.error,
              }),
              request_headers: message.http_headers,
              request_body: message.event_payload,
              notification_id: message.webhook_id,
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err)
            response = {
              type: 'webhook_response',
              webhook_id: message.webhook_id,
              webhook_conversation_id: message.webhook_conversation_id,
              forward_url: 'stripe-sync-engine',
              status: 500,
              http_headers: {},
              body: JSON.stringify({ error: errorMessage }),
              request_headers: message.http_headers,
              request_body: message.event_payload,
              notification_id: message.webhook_id,
            }
            if (onError) {
              onError(err instanceof Error ? err : new Error(errorMessage))
            }
          }

          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response))
          }
        } catch (err) {
          if (onError) {
            onError(err instanceof Error ? err : new Error(String(err)))
          }
        }
      })

      ws.on('error', (error: Error) => {
        clearTimeout(connectionTimeout)
        if (onError) {
          onError(error)
        }
        if (!connected) {
          reject(error)
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(connectionTimeout)
        connected = false

        if (pingInterval) {
          clearInterval(pingInterval)
          pingInterval = null
        }

        if (onClose) {
          onClose(code, reason.toString())
        }

        // Signal unexpected close to the run loop
        if (notifyCloseResolve) {
          notifyCloseResolve()
          notifyCloseResolve = null
        }
      })
    })
  }

  // Main run loop (following Stripe CLI pattern)
  async function runLoop() {
    while (shouldRun) {
      connected = false

      // 1. Try to connect with retry on failure
      let connectError: Error | null = null
      do {
        try {
          await setupWebSocket()
          connectError = null
        } catch (err) {
          connectError = err instanceof Error ? err : new Error(String(err))
          if (onError) {
            onError(connectError)
          }
          if (shouldRun) {
            // Wait before retrying
            await sleep(CONNECT_ATTEMPT_WAIT)
          }
        }
      } while (connectError && shouldRun)

      if (!shouldRun) break

      // 2. Connection established - wait for disconnect or stop().
      //    Ping/pong heartbeat detects stale connections and terminates them,
      //    which triggers the close handler and unblocks this promise.
      await new Promise<void>((resolve) => {
        notifyCloseResolve = resolve
        stopResolve = resolve
      })

      notifyCloseResolve = null
      stopResolve = null
    }

    // Final cleanup
    cleanupConnection()
  }

  // Start the run loop (non-blocking)
  runLoop()

  return {
    close: () => {
      shouldRun = false
      // Signal the run loop to exit
      if (stopResolve) {
        stopResolve()
        stopResolve = null
      }
      cleanupConnection()
    },
    isConnected: () => connected,
  }
}
