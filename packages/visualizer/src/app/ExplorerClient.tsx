'use client'

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { usePGlite } from '@/lib/pglite'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { sql } from '@codemirror/lang-sql'
import { basicSetup } from 'codemirror'

type QueryResult = {
  rows: Record<string, unknown>[]
  fields: { name: string; dataTypeID: number }[]
  rowCount: number
}

type QueryContext = { mode: 'table'; tableName: string } | { mode: 'custom' } | null

type DragState =
  | { type: 'pane' }
  | {
      type: 'column'
      columnKey: string
      startWidth: number
      startX: number
    }

const MIN_EDITOR_PANE_SIZE = 28
const MAX_EDITOR_PANE_SIZE = 72
const MIN_COLUMN_WIDTH = 140
const DEFAULT_CELL_PREVIEW_LENGTH = 120

export default function ExplorerClient() {
  const { status, error, query, manifest } = usePGlite()
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [editorPaneSize, setEditorPaneSize] = useState(44)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [queryContext, setQueryContext] = useState<QueryContext>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const mainPaneRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const tableOrderByColumnRef = useRef<Record<string, string>>({})

  const setEditorSql = useCallback((sqlText: string) => {
    const editorView = editorViewRef.current
    if (!editorView) return

    editorView.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: sqlText,
      },
    })
  }, [])

  const executeQuery = useCallback(
    async (sqlText: string) => {
      if (!sqlText.trim()) {
        setQueryError('Please enter a SQL query')
        return false
      }

      setIsExecuting(true)
      setQueryError(null)
      setQueryResult(null)

      try {
        const result = await query(sqlText)
        const rows = (result.rows ?? []) as Record<string, unknown>[]
        const fields = (result.fields ?? []) as { name: string; dataTypeID: number }[]

        setQueryResult({
          rows,
          fields,
          rowCount: (result as { rowCount?: number }).rowCount ?? rows.length,
        })
        return true
      } catch (err) {
        setQueryError(err instanceof Error ? err.message : 'Unknown error')
        return false
      } finally {
        setIsExecuting(false)
      }
    },
    [query]
  )

  const runEditorQuery = useCallback(
    async (sqlText: string) => {
      setQueryContext({ mode: 'custom' })
      setCurrentPage(1)
      await executeQuery(sqlText)
    },
    [executeQuery]
  )

  const runTableQuery = useCallback(
    async (tableName: string, page: number, pageSize: number) => {
      const offset = (page - 1) * pageSize
      let orderByColumn = tableOrderByColumnRef.current[tableName]

      if (!orderByColumn) {
        try {
          const primaryKeyResult = await query(`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema = 'stripe'
              AND tc.table_name = '${tableName}'
              AND tc.constraint_type = 'PRIMARY KEY'
            ORDER BY kcu.ordinal_position
            LIMIT 1
          `)

          const primaryKeyRows = primaryKeyResult.rows ?? []
          const primaryKeyColumn = (primaryKeyRows[0] as { column_name?: string } | undefined)
            ?.column_name

          orderByColumn = primaryKeyColumn ? primaryKeyColumn : 'ctid'
        } catch {
          orderByColumn = 'ctid'
        }

        tableOrderByColumnRef.current[tableName] = orderByColumn
      }

      const sqlText = `SELECT * FROM stripe.${tableName} ORDER BY ${quoteIdentifier(orderByColumn)} LIMIT ${pageSize} OFFSET ${offset}`
      setEditorSql(sqlText)
      const querySucceeded = await executeQuery(sqlText)

      if (!querySucceeded && orderByColumn !== 'ctid') {
        tableOrderByColumnRef.current[tableName] = 'ctid'
        const fallbackSqlText = `SELECT * FROM stripe.${tableName} ORDER BY ctid LIMIT ${pageSize} OFFSET ${offset}`
        setEditorSql(fallbackSqlText)
        await executeQuery(fallbackSqlText)
      }
    },
    [executeQuery, query, setEditorSql]
  )

  useEffect(() => {
    if (status !== 'ready' || !editorContainerRef.current || editorViewRef.current) return

    let view: EditorView | null = null

    const runQuery = async () => {
      if (!view) return
      const sqlText = view.state.doc.toString()
      await runEditorQuery(sqlText)
    }

    const startState = EditorState.create({
      doc: '-- Select a table from the left or write your own SQL',
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
            color: 'rgb(15 23 42)',
            backgroundColor: 'rgb(255 255 255)',
          },
          '&.cm-focused': {
            outline: 'none',
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          },
          '.cm-content': {
            padding: '16px 0',
          },
          '.cm-line': {
            padding: '0 16px',
          },
          '.cm-gutters': {
            backgroundColor: 'rgb(255 255 255)',
            color: 'rgb(148 163 184)',
            borderRight: '1px solid rgb(226 232 240)',
          },
          '.cm-activeLine': {
            backgroundColor: 'rgba(99, 102, 241, 0.06)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
          },
          '.cm-selectionBackground, ::selection': {
            backgroundColor: 'rgba(99, 102, 241, 0.18)',
          },
          '.cm-cursor': {
            borderLeftColor: 'rgb(15 23 42)',
          },
        }),
      ],
    })

    view = new EditorView({ state: startState, parent: editorContainerRef.current })
    editorViewRef.current = view

    return () => {
      if (view) view.destroy()
      if (editorViewRef.current === view) editorViewRef.current = null
    }
  }, [runEditorQuery, status])

  useEffect(() => {
    const stopDragging = () => {
      dragStateRef.current = null
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current
      if (!dragState) return

      if (dragState.type === 'pane') {
        const bounds = mainPaneRef.current?.getBoundingClientRect()
        if (!bounds) return

        const nextSize = ((event.clientY - bounds.top) / bounds.height) * 100
        setEditorPaneSize(clamp(nextSize, MIN_EDITOR_PANE_SIZE, MAX_EDITOR_PANE_SIZE))
        return
      }

      const nextWidth = Math.max(
        MIN_COLUMN_WIDTH,
        dragState.startWidth + (event.clientX - dragState.startX)
      )

      setColumnWidths((currentWidths) => {
        if (currentWidths[dragState.columnKey] === nextWidth) {
          return currentWidths
        }

        return {
          ...currentWidths,
          [dragState.columnKey]: nextWidth,
        }
      })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
      stopDragging()
    }
  }, [])

  const handleTableClick = useCallback(
    async (tableName: string) => {
      setSelectedTable(tableName)
      setQueryContext({ mode: 'table', tableName })
      setCurrentPage(1)
      await runTableQuery(tableName, 1, rowsPerPage)
    },
    [rowsPerPage, runTableQuery]
  )

  const handleRunClick = useCallback(() => {
    const editorView = editorViewRef.current
    if (!editorView) return
    void runEditorQuery(editorView.state.doc.toString())
  }, [runEditorQuery])

  const isTableMode = queryContext?.mode === 'table'
  const tableName = queryContext?.mode === 'table' ? queryContext.tableName : null

  const totalRecords =
    isTableMode && tableName
      ? (manifest?.manifest[tableName] ?? queryResult?.rows.length ?? 0)
      : (queryResult?.rowCount ?? queryResult?.rows.length ?? 0)

  const pageCount = isTableMode ? Math.max(1, Math.ceil(totalRecords / rowsPerPage)) : 1

  const displayedRows = queryResult?.rows ?? []

  const changePage = useCallback(
    async (nextPage: number) => {
      if (!isTableMode) return
      const boundedPage = clamp(nextPage, 1, pageCount)
      if (boundedPage === currentPage) return

      setCurrentPage(boundedPage)

      if (queryContext?.mode === 'table') {
        await runTableQuery(queryContext.tableName, boundedPage, rowsPerPage)
      }
    },
    [currentPage, isTableMode, pageCount, queryContext, rowsPerPage, runTableQuery]
  )

  const handleRowsPerPageChange = useCallback(
    async (nextRowsPerPage: number) => {
      if (nextRowsPerPage === rowsPerPage) return
      setRowsPerPage(nextRowsPerPage)
      setCurrentPage(1)

      if (!isTableMode) return

      if (queryContext?.mode === 'table') {
        await runTableQuery(queryContext.tableName, 1, nextRowsPerPage)
      }
    },
    [isTableMode, queryContext, runTableQuery]
  )

  const handlePaneResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStateRef.current = { type: 'pane' }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const handleColumnResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, columnKey: string, startingWidth: number) => {
      event.preventDefault()
      event.stopPropagation()

      dragStateRef.current = {
        type: 'column',
        columnKey,
        startWidth: startingWidth,
        startX: event.clientX,
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    []
  )

  if (status === 'loading') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white px-8 py-7 shadow-sm">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
          <p className="text-sm text-slate-500">Loading database...</p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <div className="flex max-w-lg flex-col items-center gap-3 rounded-2xl border border-red-200 bg-white px-8 py-7 text-center shadow-sm">
          <span className="text-4xl">⚠️</span>
          <h2 className="text-lg font-semibold text-slate-950">Database Error</h2>
          <p className="text-sm text-slate-600">{error}</p>
        </div>
      </div>
    )
  }

  const tables = manifest?.manifest ? Object.entries(manifest.manifest) : []
  const columns =
    queryResult?.fields.map((field, index) => {
      const columnKey = getColumnKey(field.name, index)
      return {
        field,
        columnKey,
        width: columnWidths[columnKey] ?? getDefaultColumnWidth(field.name),
      }
    }) ?? []
  const totalColumnWidth = columns.reduce((sum, column) => sum + column.width, 0)

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-[13px] text-slate-900">
      <aside className="flex h-full w-72 min-w-0 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-white px-4 py-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-500">
                Explorer
              </p>
              <h2 className="mt-1 text-sm font-semibold">Tables</h2>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {tables.length}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
          {tables.map(([tableName, rowCount]) => (
            <button
              key={tableName}
              type="button"
              title={tableName}
              onClick={() => handleTableClick(tableName)}
              className={`mb-1 flex w-full min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-all duration-150 ease-out hover:-translate-y-px active:translate-y-0 ${
                selectedTable === tableName
                  ? 'border-indigo-200 bg-indigo-50 text-slate-950 shadow-sm'
                  : 'border-transparent bg-white text-slate-700 hover:border-slate-200 hover:bg-slate-50 hover:shadow-sm'
              }`}
            >
              <div className="truncate font-mono text-[13px] font-medium">{tableName}</div>
              <div
                className={`mt-1 truncate text-[11px] ${
                  selectedTable === tableName ? 'text-indigo-600' : 'text-slate-500'
                }`}
              >
                {rowCount.toLocaleString()} rows
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden bg-slate-100/70 p-3">
        <div
          ref={mainPaneRef}
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-[0_12px_28px_-22px_rgba(15,23,42,0.28)]"
        >
          <section
            className="flex min-h-[220px] flex-col overflow-hidden"
            style={{ flexBasis: `${editorPaneSize}%` }}
          >
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 text-slate-900">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-500">
                  Query
                </p>
                <h3 className="mt-1 text-sm font-semibold">SQL Editor</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRunClick}
                  disabled={isExecuting}
                  className="inline-flex h-10 min-w-[8rem] cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 transition-all duration-150 ease-out hover:-translate-y-px hover:bg-indigo-500 hover:shadow-md hover:shadow-indigo-600/20 active:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none"
                >
                  {isExecuting ? 'Running…' : 'Run'}
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden bg-white">
              <div ref={editorContainerRef} className="h-full min-h-0 overflow-hidden" />
            </div>
          </section>

          <div
            role="separator"
            aria-label="Resize editor and results"
            onPointerDown={handlePaneResizeStart}
            className="group relative flex h-4 cursor-row-resize items-center justify-center bg-white transition-colors duration-150 ease-out"
          >
            <div className="h-px w-full bg-slate-200 transition-colors group-hover:bg-indigo-200" />
            <div className="absolute flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 shadow-sm transition-all duration-150 ease-out group-hover:scale-105 group-hover:border-indigo-200">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300 group-hover:bg-indigo-400" />
            </div>
          </div>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 text-slate-900">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-500">
                  Results
                </p>
                <h3 className="mt-1 text-sm font-semibold">
                  {isTableMode && tableName ? `stripe.${tableName}` : 'Query Output'}
                </h3>
              </div>
              {(isTableMode || queryResult) && (
                <div className="flex shrink-0 items-center justify-end gap-2 text-[12px] text-slate-600">
                  {isTableMode ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void changePage(currentPage - 1)
                        }}
                        disabled={currentPage <= 1 || isExecuting}
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-slate-300 bg-slate-50 text-xs font-medium text-slate-600 transition-all duration-150 ease-out hover:-translate-y-px hover:border-indigo-300 hover:bg-white hover:text-indigo-600 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300"
                        aria-label="Previous page"
                      >
                        ←
                      </button>

                      <span className="text-[12px] font-medium tabular-nums text-slate-600">
                        Page {currentPage} / {pageCount}
                      </span>

                      <button
                        type="button"
                        onClick={() => {
                          void changePage(currentPage + 1)
                        }}
                        disabled={currentPage >= pageCount || isExecuting}
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-slate-300 bg-slate-50 text-xs font-medium text-slate-600 transition-all duration-150 ease-out hover:-translate-y-px hover:border-indigo-300 hover:bg-white hover:text-indigo-600 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300"
                        aria-label="Next page"
                      >
                        →
                      </button>

                      <select
                        value={rowsPerPage}
                        onChange={(event) => {
                          void handleRowsPerPageChange(Number(event.target.value))
                        }}
                        className="h-7 cursor-pointer rounded-md border border-slate-300 bg-slate-50 px-2 text-[12px] font-medium text-slate-700 outline-none transition-all duration-150 ease-out hover:border-indigo-300 hover:bg-white focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100"
                        aria-label="Rows per page"
                      >
                        {[25, 50, 100, 250].map((value) => (
                          <option key={value} value={value}>
                            {value} rows
                          </option>
                        ))}
                      </select>

                      <span className="text-[12px] font-medium tabular-nums text-slate-600">
                        {totalRecords.toLocaleString()} {totalRecords === 1 ? 'record' : 'records'}
                      </span>
                    </>
                  ) : (
                    <span className="text-[12px] font-medium tabular-nums text-slate-600">
                      {totalRecords.toLocaleString()} {totalRecords === 1 ? 'record' : 'records'}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-slate-100/80">
              {isExecuting && (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
                  <p className="text-sm text-slate-500">Executing query…</p>
                </div>
              )}

              {queryError && (
                <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <span>⚠️</span>
                  <span>{queryError}</span>
                </div>
              )}

              {queryResult && !isExecuting && (
                <div className="h-full overflow-auto bg-slate-100/80">
                  <table
                    className="[table-layout:fixed] border-separate border-spacing-0 text-[12px]"
                    style={{ width: columns.length > 0 ? `${totalColumnWidth}px` : '100%' }}
                  >
                    <colgroup>
                      {columns.map((column) => (
                        <col
                          key={column.columnKey}
                          style={{
                            width: column.width,
                            minWidth: column.width,
                            maxWidth: column.width,
                          }}
                        />
                      ))}
                    </colgroup>
                    <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_rgba(226,232,240,1)]">
                      <tr>
                        {columns.map((column) => (
                          <th
                            key={column.columnKey}
                            className="relative border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-left align-middle text-[10px] font-semibold tracking-[0.12em] text-slate-600 last:border-r-0"
                            style={{ width: column.width }}
                          >
                            <div className="truncate pr-4" title={column.field.name}>
                              {column.field.name}
                            </div>
                            <div
                              role="separator"
                              aria-label={`Resize ${column.field.name} column`}
                              onPointerDown={(event) =>
                                handleColumnResizeStart(event, column.columnKey, column.width)
                              }
                              className="absolute inset-y-0 -right-2 z-20 flex w-5 cursor-col-resize touch-none items-center justify-center rounded transition-colors duration-150 ease-out hover:bg-indigo-50"
                            >
                              <div className="h-5 w-px bg-slate-300 transition-all duration-150 ease-out hover:h-6 hover:bg-indigo-500" />
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedRows.map((row, rowIndex) => (
                        <tr
                          key={rowIndex}
                          className="transition-colors duration-150 ease-out odd:bg-white even:bg-slate-50/65 hover:bg-indigo-50/50"
                        >
                          {columns.map((column) => {
                            const cellValue = formatCellValue(row[column.field.name])
                            const previewValue = getCellPreview(cellValue)
                            return (
                              <td
                                key={column.columnKey}
                                className="border-b border-r border-slate-100 px-3 py-3 align-top text-[12px] leading-5 text-slate-700 last:border-r-0"
                                style={{ width: column.width, maxWidth: column.width }}
                              >
                                <div
                                  title={cellValue}
                                  className={`truncate ${
                                    cellValue === 'NULL' ? 'italic text-slate-400' : ''
                                  }`}
                                >
                                  {previewValue}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!isExecuting && !queryError && !queryResult && (
                <div className="flex h-full items-center justify-center px-8 text-center">
                  <div className="max-w-sm">
                    <p className="text-[13px] font-medium text-slate-500">
                      Choose a table or run an ad-hoc query
                    </p>
                    <p className="mt-2 text-[13px] text-slate-400">
                      The editor and result grid are both draggable so you can tune the workspace as
                      you explore.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function quoteIdentifier(identifier: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier
  }

  return `"${identifier.replace(/"/g, '""')}"`
}

function getColumnKey(fieldName: string, index: number): string {
  return `${index}:${fieldName}`
}

function getDefaultColumnWidth(fieldName: string): number {
  if (fieldName === '_raw_data' || fieldName.includes('metadata')) {
    return 220
  }

  if (
    fieldName === 'id' ||
    fieldName.endsWith('_id') ||
    fieldName.includes('cursor') ||
    fieldName.includes('account')
  ) {
    return 180
  }

  if (fieldName.endsWith('_at') || fieldName.includes('time') || fieldName.includes('date')) {
    return 190
  }

  if (fieldName.includes('status') || fieldName.includes('type')) {
    return 150
  }

  return clamp(fieldName.length * 10 + 56, MIN_COLUMN_WIDTH, 220)
}

function formatCellValue(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function getCellPreview(value: string): string {
  if (value.length <= DEFAULT_CELL_PREVIEW_LENGTH) {
    return value
  }

  return `${value.slice(0, DEFAULT_CELL_PREVIEW_LENGTH - 1)}…`
}
