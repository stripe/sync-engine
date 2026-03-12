'use client'

import { useEffect, useState, useCallback } from 'react'

interface ObjectProgress {
  object: string
  pct_complete: number
  processed: number
}

interface SyncRun {
  account_id: string
  started_at: string
  closed_at: string | null
  status: string
  total_processed: number
  total_objects: number
  complete_count: number
  error_count: number
  running_count: number
  pending_count: number
}

interface SyncProgressProps {
  sessionId: string
}

function barColor(pct: number): string {
  if (pct >= 100) return '#16a34a'
  if (pct > 0) return '#2563eb'
  return '#9ca3af'
}

export function SyncProgress({ sessionId }: SyncProgressProps) {
  const [run, setRun] = useState<SyncRun | null>(null)
  const [objects, setObjects] = useState<ObjectProgress[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/sync-progress?sessionId=${sessionId}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error)
        return
      }
      setRun(data.run)
      setObjects(data.objects ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 2000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading) return <div style={containerStyle}>Loading...</div>

  if (error) {
    return (
      <div style={{ ...containerStyle, background: '#fff3cd', color: '#856404' }}>
        <span style={{ fontSize: 20 }}>⚠️</span> {error}
      </div>
    )
  }

  if (!run || objects.length === 0) return null

  const totalRows = objects.reduce((sum, o) => sum + Number(o.processed), 0)

  return (
    <div style={tableWrapStyle}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>Table</th>
            <th style={{ ...thStyle, textAlign: 'left', width: '35%' }}>Progress</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Rows</th>
          </tr>
        </thead>
        <tbody>
          {objects.map((obj) => {
            const pct = Number(obj.pct_complete)
            return (
              <tr key={obj.object} style={{ borderBottom: '1px solid #eee' }}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500 }}>{obj.object}</span>
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={trackStyle}>
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          borderRadius: 3,
                          background: barColor(pct),
                          transition: 'width 0.5s ease',
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 12, color: '#888', minWidth: 42, textAlign: 'right' }}>
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {Number(obj.processed).toLocaleString()}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={footerStyle}>
        <span style={{ fontWeight: 600 }}>{totalRows.toLocaleString()} total rows</span>
      </div>
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '16px 20px',
  background: '#f9f9f9',
  borderRadius: 8,
  fontSize: 16,
}

const tableWrapStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 8,
  overflow: 'hidden',
}

const thStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#888',
  background: '#fafafa',
  borderBottom: '1px solid #ddd',
}

const tdStyle: React.CSSProperties = {
  padding: '10px 16px',
  verticalAlign: 'middle',
}

const trackStyle: React.CSSProperties = {
  flex: 1,
  height: 6,
  background: '#eee',
  borderRadius: 3,
  overflow: 'hidden',
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '10px 16px',
  background: '#fafafa',
  borderTop: '1px solid #ddd',
  fontSize: 13,
}
