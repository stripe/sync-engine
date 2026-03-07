'use client'

import { useState } from 'react'
import { DeployForm } from '@/components/DeployForm'
import { SyncStatus } from '@/components/SyncStatus'
import { SyncProgress } from '@/components/SyncProgress'
import { InstallationStatus } from '@/components/InstallationStatus'

export default function Home() {
  const [deploying, setDeploying] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [installationComplete, setInstallationComplete] = useState(false)

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: 40 }}>
      <h1 style={{ marginBottom: 8 }}>Stripe Sync</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>Deploy Stripe sync to your Supabase project</p>

      {!sessionId && !deploying && (
        <DeployForm
          onDeploying={setDeploying}
          onSuccess={(id) => {
            setDeploying(false)
            setSessionId(id)
            setInstallationComplete(false)
          }}
        />
      )}

      <div style={{ marginTop: sessionId || deploying ? 0 : 32 }}>
        {deploying && (
          <div style={statusStyle}>
            <span style={{ fontSize: 20 }}>🚀</span>
            <span>Deploying...</span>
          </div>
        )}

        {!deploying && sessionId && !installationComplete && (
          <div>
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>Installation Progress</h2>
            <InstallationStatus
              sessionId={sessionId}
              onComplete={() => setInstallationComplete(true)}
            />
          </div>
        )}

        {!deploying && sessionId && installationComplete && (
          <div>
            <SyncStatus sessionId={sessionId} />
            <div style={{ marginTop: 24 }}>
              <SyncProgress sessionId={sessionId} />
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

const statusStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '16px 20px',
  background: '#f0f7ff',
  borderRadius: 8,
  fontSize: 16,
}
