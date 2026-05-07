import { useState, useRef, useCallback } from 'react'
import { startSync } from './lib/sync'

export default function App() {
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const [messages, setMessages] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [queryResult, setQueryResult] = useState<string>('')
  const abortRef = useRef<AbortController | null>(null)

  const addMessage = useCallback((msg: string) => {
    setMessages((prev) => [...prev.slice(-200), msg])
  }, [])

  const handleStart = async () => {
    if (!apiKey) return
    setStatus('running')
    setMessages([])
    abortRef.current = new AbortController()

    try {
      await startSync({
        apiKey,
        websocket: true,
        signal: abortRef.current.signal,
        onMessage: (msg: unknown) => {
          const m = msg as { type?: string; record?: { stream?: string } }
          if (m.type === 'record') {
            addMessage(`record: ${m.record?.stream}`)
          } else {
            addMessage(JSON.stringify(m).slice(0, 120))
          }
        },
      })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setStatus('error')
        addMessage(`Error: ${(err as Error).message}`)
      }
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    setStatus('idle')
  }

  return (
    <div style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <h1>Stripe Sync Engine — Browser</h1>

      <div style={{ marginBottom: '1rem' }}>
        <input
          type="password"
          placeholder="sk_live_... or sk_test_..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ width: '400px', padding: '0.5rem', fontFamily: 'monospace' }}
        />
        {status === 'idle' ? (
          <button onClick={handleStart} style={{ marginLeft: '0.5rem', padding: '0.5rem 1rem' }}>
            Start Sync
          </button>
        ) : (
          <button onClick={handleStop} style={{ marginLeft: '0.5rem', padding: '0.5rem 1rem' }}>
            Stop
          </button>
        )}
        <span style={{ marginLeft: '1rem' }}>{status}</span>
      </div>

      <div
        style={{
          background: '#111',
          color: '#0f0',
          padding: '1rem',
          height: '300px',
          overflowY: 'auto',
          fontSize: '12px',
          marginBottom: '1rem',
        }}
      >
        {messages.map((m, i) => (
          <div key={i}>{m}</div>
        ))}
      </div>

      <div>
        <textarea
          placeholder="SELECT * FROM stripe.customers LIMIT 10"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', height: '60px', fontFamily: 'monospace', padding: '0.5rem' }}
        />
        <button
          onClick={() => setQueryResult('TODO: wire PGlite query')}
          style={{ padding: '0.5rem 1rem' }}
        >
          Run Query
        </button>
        {queryResult && <pre style={{ marginTop: '0.5rem' }}>{queryResult}</pre>}
      </div>
    </div>
  )
}
