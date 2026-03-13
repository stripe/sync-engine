import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/sessions'
import { parseSchemaComment } from '@stripe/sync-engine'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })
    }

    const session = getSession(sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 })
    }

    // Read schema comment via Management API
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${session.projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `SELECT obj_description('stripe'::regnamespace) as comment`,
        }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      return NextResponse.json({ error: `Database query failed: ${text}` }, { status: 500 })
    }

    const result = await response.json()
    const comment = result && result.length > 0 ? result[0]?.comment : null

    // Parse comment (supports both JSON and legacy plain-text format)
    const parsedComment = parseSchemaComment(comment)

    // Map to response format
    let status: 'not_started' | 'in_progress' | 'completed' | 'error' = 'not_started'
    let step = ''

    if (!parsedComment) {
      status = 'not_started'
    } else {
      switch (parsedComment.status) {
        case 'installing':
          status = 'in_progress'
          step = 'installing'
          break
        case 'installed':
          status = 'completed'
          step = `installed${parsedComment.newVersion ? ` (v${parsedComment.newVersion})` : ''}`
          break
        case 'install error':
          status = 'error'
          step = parsedComment.errorMessage || 'Installation error'
          break
        case 'uninstalling':
          status = 'in_progress'
          step = 'uninstalling'
          break
        case 'uninstall error':
          status = 'error'
          step = parsedComment.errorMessage || 'Uninstallation error'
          break
      }
    }

    return NextResponse.json({ status, step, comment })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
