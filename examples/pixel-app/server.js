/**
 * PixelDraw — Metronome + Cache Sidecar entitlement demo.
 *
 * Architecture:
 *   Browser → POST /api/draw → check balance via cache-sidecar → sidecar records event + forwards to Metronome
 *   Sync Engine (separate process) keeps Redis fresh via source-metronome → destination-redis pipeline
 *   Cache Sidecar manages optimistic balance enforcement over the synced data
 *
 * Env vars:
 *   METRONOME_CUSTOMER_ID — Customer ID in Metronome
 *   SIDECAR_URL           — Cache sidecar URL (default: http://localhost:4100)
 *   PORT                  — Server port (default: 4000)
 */

import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

const PORT = process.env.PORT || 4000
const METRONOME_CUSTOMER_ID = process.env.METRONOME_CUSTOMER_ID
const SIDECAR_URL = process.env.SIDECAR_URL || 'http://localhost:4100'

if (!METRONOME_CUSTOMER_ID) {
  console.error('ERROR: Set METRONOME_CUSTOMER_ID')
  process.exit(1)
}

// ---- Sidecar calls ----

async function getBalance() {
  const res = await fetch(`${SIDECAR_URL}/v1/balance/${METRONOME_CUSTOMER_ID}`)
  if (!res.ok) {
    if (res.status === 503) return null
    const text = await res.text()
    throw new Error(`Sidecar balance failed: ${res.status} ${text}`)
  }
  return await res.json()
}

async function recordEvent(color) {
  const res = await fetch(`${SIDECAR_URL}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: METRONOME_CUSTOMER_ID,
      event_type: 'pixel_draw',
      properties: { color },
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sidecar event failed: ${res.status} ${text}`)
  }
  return await res.json()
}

// ---- API routes ----

/** Health check — proxies to sidecar */
app.get('/api/health', async (_req, res) => {
  try {
    const sidecarRes = await fetch(`${SIDECAR_URL}/v1/health`)
    const data = await sidecarRes.json()
    res.json({ ok: data.ok, sidecar: 'connected', redis: data.redis })
  } catch {
    res.status(503).json({ ok: false, sidecar: 'disconnected' })
  }
})

/** Get current credit balance via sidecar */
app.get('/api/credits', async (_req, res) => {
  const data = await getBalance()
  if (data === null) {
    return res.status(503).json({
      error: 'Balance not available. Start the sync engine to populate Redis.',
    })
  }
  res.json({
    balance: data.optimistic_balance,
    checkpoint_balance: data.checkpoint_balance,
    pending_events: data.pending_events,
    confidence: data.confidence,
  })
})

/** Draw a pixel — the hot path */
app.post('/api/draw', async (req, res) => {
  const { color, x, y } = req.body
  if (!color || x == null || y == null) {
    return res.status(400).json({ error: 'color, x, y required' })
  }

  // 1. Check optimistic balance via sidecar
  const balanceData = await getBalance()
  if (balanceData === null) {
    return res.status(503).json({
      allowed: false,
      error: 'Balance not available. Start the sync engine to populate Redis.',
    })
  }
  if (balanceData.optimistic_balance <= 0) {
    return res.status(402).json({
      allowed: false,
      error: 'Out of credits',
      balance: 0,
    })
  }

  // 2. Record event via sidecar (handles Metronome forwarding internally)
  try {
    const eventResult = await recordEvent(color)
    res.json({
      allowed: true,
      balance: eventResult.optimistic_balance,
      pending_events: eventResult.pending_events,
      color,
      x,
      y,
    })
  } catch (err) {
    console.error('Event recording error:', err.message)
    // Still allow the draw since balance was positive
    res.json({
      allowed: true,
      balance: balanceData.optimistic_balance,
      color,
      x,
      y,
    })
  }
})

// ---- Start ----

app.listen(PORT, () => {
  console.log(`
+==================================================+
|  PixelDraw — http://localhost:${PORT}              |
|  Metronome customer: ${METRONOME_CUSTOMER_ID.slice(0, 20)}...    |
|  Sidecar: ${SIDECAR_URL.padEnd(39)}|
+==================================================+
  `)
})
