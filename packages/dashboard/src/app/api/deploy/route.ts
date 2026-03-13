import { NextRequest, NextResponse } from 'next/server'
import { install } from '@stripe/sync-engine/supabase'
import { createSession } from '@/lib/sessions'

interface DeployRequest {
  supabaseAccessToken: string
  supabaseProjectRef: string
  stripeKey: string
}

export async function POST(request: NextRequest) {
  try {
    const body: DeployRequest = await request.json()
    const { supabaseAccessToken, supabaseProjectRef, stripeKey } = body

    if (!supabaseAccessToken || !supabaseProjectRef || !stripeKey) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    await install({
      supabaseAccessToken,
      supabaseProjectRef,
      stripeKey,
    })

    // Create session to store credentials server-side (for Management API queries)
    const sessionId = createSession(supabaseProjectRef, supabaseAccessToken)

    return NextResponse.json({
      success: true,
      sessionId,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
