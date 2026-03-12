import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/sessions'

const SYNC_PROGRESS_QUERY = `
  SELECT json_build_object(
    'run', (
      SELECT row_to_json(r) FROM (
        SELECT account_id, started_at, closed_at, triggered_by, status,
               total_processed, total_objects, complete_count, error_count,
               running_count, pending_count, error_message
        FROM stripe.sync_runs ORDER BY started_at DESC LIMIT 1
      ) r
    ),
    'objects', COALESCE((
      SELECT json_agg(row_to_json(p) ORDER BY p.object)
      FROM stripe.sync_obj_progress p
    ), '[]'::json)
  ) AS result
`

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

    const response = await fetch(
      `https://api.supabase.com/v1/projects/${session.projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: SYNC_PROGRESS_QUERY }),
      }
    )

    if (!response.ok) {
      const text = await response.text()
      return NextResponse.json({ error: `Database query failed: ${text}` }, { status: 500 })
    }

    const rows = await response.json()
    const data = rows?.[0]?.result ?? { run: null, objects: [] }

    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
