'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { usePGlite } from '@/lib/pglite'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { sql } from '@codemirror/lang-sql'
import { basicSetup } from 'codemirror'

interface QueryResult {
  rows: Record<string, unknown>[]
  fields: { name: string; dataTypeID: number }[]
  rowCount: number
}

export default function ExplorerClient() {
  const { status, error, query, manifest } = usePGlite()
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorContainerRef.current || editorView) return

    let view: EditorView | null = null

    const runQuery = async () => {
      if (!view) return
      const sql = view.state.doc.toString()
      await executeQuery(sql)
    }

    const startState = EditorState.create({
      doc: '-- Select a table from the left sidebar or write your own SQL query\n-- Press Ctrl+Enter or click Run to execute',
      extensions: [
        basicSetup,
        sql(),
        keymap.of([
          {
            key: 'Ctrl-Enter',
            run: () => {
              runQuery()
              return true
            },
          },
          {
            key: 'Cmd-Enter',
            run: () => {
              runQuery()
              return true
            },
          },
        ]),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          },
          '.cm-content': {
            padding: '10px 0',
          },
          '.cm-gutters': {
            backgroundColor: '#f5f5f5',
            borderRight: '1px solid #e0e0e0',
          },
        }),
      ],
    })

    view = new EditorView({
      state: startState,
      parent: editorContainerRef.current,
    })

    setEditorView(view)

    return () => {
      if (view) view.destroy()
    }
  }, [])

  // Execute query function
  const executeQuery = useCallback(
    async (sql: string) => {
      if (!sql.trim()) {
        setQueryError('Please enter a SQL query')
        return
      }

      setIsExecuting(true)
      setQueryError(null)
      setQueryResult(null)

      try {
        const result = await query(sql)
        setQueryResult(result)
      } catch (err) {
        console.error('Query execution error:', err)
        setQueryError(err instanceof Error ? err.message : 'Unknown error executing query')
      } finally {
        setIsExecuting(false)
      }
    },
    [query]
  )

  // Handle table click
  const handleTableClick = useCallback(
    async (tableName: string) => {
      setSelectedTable(tableName)
      const sql = `SELECT * FROM stripe.${tableName} LIMIT 100`

      if (editorView) {
        editorView.dispatch({
          changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: sql,
          },
        })
      }

      await executeQuery(sql)
    },
    [editorView, executeQuery]
  )

  // Handle Run button
  const handleRunClick = useCallback(() => {
    if (!editorView) return
    const sql = editorView.state.doc.toString()
    executeQuery(sql)
  }, [editorView, executeQuery])

  // Loading state
  if (status === 'loading') {
    return (
      <div style={styles.container}>
        <div style={styles.loadingContainer}>
          <div style={styles.spinner} />
          <div style={styles.loadingText}>Loading database...</div>
        </div>
      </div>
    )
  }

  // Error state
  if (status === 'error') {
    return (
      <div style={styles.container}>
        <div style={styles.errorContainer}>
          <div style={styles.errorIcon}>⚠️</div>
          <div style={styles.errorTitle}>Database Error</div>
          <div style={styles.errorMessage}>{error}</div>
        </div>
      </div>
    )
  }

  // Ready state - show explorer
  const tables = manifest?.manifest ? Object.entries(manifest.manifest) : []

  return (
    <div style={styles.container}>
      {/* Left Sidebar - Table List */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <h2 style={styles.sidebarTitle}>Tables</h2>
          <div style={styles.tableCount}>{tables.length} tables</div>
        </div>
        <div style={styles.tableList}>
          {tables.map(([tableName, rowCount]) => (
            <div
              key={tableName}
              style={{
                ...styles.tableItem,
                ...(selectedTable === tableName ? styles.tableItemSelected : {}),
              }}
              onClick={() => handleTableClick(tableName)}
            >
              <div style={styles.tableName}>{tableName}</div>
              <div style={styles.rowCount}>{rowCount.toLocaleString()} rows</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel - Split into Editor (top) and Results (bottom) */}
      <div style={styles.rightPanel}>
        {/* Top - SQL Editor */}
        <div style={styles.editorPanel}>
          <div style={styles.editorHeader}>
            <h3 style={styles.editorTitle}>SQL Editor</h3>
            <button
              onClick={handleRunClick}
              disabled={isExecuting}
              style={{
                ...styles.runButton,
                ...(isExecuting ? styles.runButtonDisabled : {}),
              }}
            >
              {isExecuting ? 'Running...' : 'Run (Ctrl+Enter)'}
            </button>
          </div>
          <div style={styles.editorContainer} ref={editorContainerRef} />
        </div>

        {/* Bottom - Results Grid */}
        <div style={styles.resultsPanel}>
          <div style={styles.resultsHeader}>
            <h3 style={styles.resultsTitle}>Results</h3>
            {queryResult && (
              <div style={styles.resultsMeta}>
                {queryResult.rowCount} {queryResult.rowCount === 1 ? 'row' : 'rows'}
              </div>
            )}
          </div>
          <div style={styles.resultsContainer}>
            {isExecuting && (
              <div style={styles.resultsLoading}>
                <div style={styles.spinner} />
                <div>Executing query...</div>
              </div>
            )}

            {queryError && (
              <div style={styles.resultsError}>
                <div style={styles.errorIcon}>⚠️</div>
                <div>{queryError}</div>
              </div>
            )}

            {queryResult && !isExecuting && (
              <div style={styles.tableWrapper}>
                <table style={styles.resultsTable}>
                  <thead>
                    <tr>
                      {queryResult.fields.map((field, idx) => (
                        <th key={idx} style={styles.tableHeader}>
                          {field.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryResult.rows.map((row, rowIdx) => (
                      <tr key={rowIdx}>
                        {queryResult.fields.map((field, colIdx) => (
                          <td key={colIdx} style={styles.tableCell}>
                            {formatCellValue(row[field.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!isExecuting && !queryError && !queryResult && (
              <div style={styles.resultsEmpty}>
                Select a table from the left sidebar or write a SQL query and click Run
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Helper function to format cell values
function formatCellValue(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

// Styles
const styles = {
  container: {
    display: 'flex',
    height: '100vh',
    width: '100%',
    backgroundColor: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  } as React.CSSProperties,

  // Loading & Error States
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    gap: '20px',
  } as React.CSSProperties,

  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid #f0f0f0',
    borderTop: '4px solid #0070f3',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  } as React.CSSProperties,

  loadingText: {
    fontSize: '16px',
    color: '#666',
  } as React.CSSProperties,

  errorContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    gap: '12px',
    padding: '40px',
  } as React.CSSProperties,

  errorIcon: {
    fontSize: '48px',
  } as React.CSSProperties,

  errorTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#333',
  } as React.CSSProperties,

  errorMessage: {
    fontSize: '14px',
    color: '#666',
    textAlign: 'center' as const,
    maxWidth: '600px',
  } as React.CSSProperties,

  // Sidebar (Left Panel)
  sidebar: {
    width: '280px',
    height: '100%',
    borderRight: '1px solid #e0e0e0',
    backgroundColor: '#fafafa',
    display: 'flex',
    flexDirection: 'column' as const,
    flexShrink: 0,
  } as React.CSSProperties,

  sidebarHeader: {
    padding: '20px',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#fff',
  } as React.CSSProperties,

  sidebarTitle: {
    fontSize: '18px',
    fontWeight: 600,
    margin: '0 0 4px 0',
    color: '#333',
  } as React.CSSProperties,

  tableCount: {
    fontSize: '13px',
    color: '#666',
  } as React.CSSProperties,

  tableList: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '8px',
  } as React.CSSProperties,

  tableItem: {
    padding: '12px',
    margin: '2px 0',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
    backgroundColor: '#fff',
    border: '1px solid transparent',
  } as React.CSSProperties,

  tableItemSelected: {
    backgroundColor: '#e6f2ff',
    border: '1px solid #0070f3',
  } as React.CSSProperties,

  tableName: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#333',
    marginBottom: '4px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  } as React.CSSProperties,

  rowCount: {
    fontSize: '12px',
    color: '#666',
  } as React.CSSProperties,

  // Right Panel Container
  rightPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
  } as React.CSSProperties,

  // Editor Panel (Top Right)
  editorPanel: {
    height: '40%',
    display: 'flex',
    flexDirection: 'column' as const,
    borderBottom: '1px solid #e0e0e0',
  } as React.CSSProperties,

  editorHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#fafafa',
  } as React.CSSProperties,

  editorTitle: {
    fontSize: '14px',
    fontWeight: 600,
    margin: 0,
    color: '#333',
  } as React.CSSProperties,

  runButton: {
    padding: '8px 16px',
    fontSize: '14px',
    fontWeight: 500,
    color: '#fff',
    backgroundColor: '#0070f3',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  } as React.CSSProperties,

  runButtonDisabled: {
    backgroundColor: '#ccc',
    cursor: 'not-allowed',
  } as React.CSSProperties,

  editorContainer: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#fff',
  } as React.CSSProperties,

  // Results Panel (Bottom Right)
  resultsPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,

  resultsHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#fafafa',
  } as React.CSSProperties,

  resultsTitle: {
    fontSize: '14px',
    fontWeight: 600,
    margin: 0,
    color: '#333',
  } as React.CSSProperties,

  resultsMeta: {
    fontSize: '13px',
    color: '#666',
  } as React.CSSProperties,

  resultsContainer: {
    flex: 1,
    overflow: 'auto',
    backgroundColor: '#fff',
  } as React.CSSProperties,

  resultsLoading: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: '12px',
    color: '#666',
  } as React.CSSProperties,

  resultsError: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '20px',
    margin: '20px',
    backgroundColor: '#fff5f5',
    border: '1px solid #feb2b2',
    borderRadius: '6px',
    color: '#c53030',
  } as React.CSSProperties,

  resultsEmpty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '40px',
    textAlign: 'center' as const,
    color: '#999',
    fontSize: '14px',
  } as React.CSSProperties,

  tableWrapper: {
    overflow: 'auto',
    width: '100%',
    height: '100%',
  } as React.CSSProperties,

  resultsTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '13px',
  } as React.CSSProperties,

  tableHeader: {
    position: 'sticky' as const,
    top: 0,
    padding: '12px',
    textAlign: 'left' as const,
    backgroundColor: '#fafafa',
    borderBottom: '2px solid #e0e0e0',
    fontWeight: 600,
    color: '#333',
    whiteSpace: 'nowrap' as const,
    zIndex: 1,
  } as React.CSSProperties,

  tableCell: {
    padding: '10px 12px',
    borderBottom: '1px solid #f0f0f0',
    color: '#333',
    maxWidth: '400px',
    overflow: 'hidden',
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
}

// Add keyframes for spinner animation
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `
  document.head.appendChild(style)
}
