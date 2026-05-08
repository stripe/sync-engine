import type { drive_v3, sheets_v4 } from 'googleapis'
import { log } from './logger.js'
import { serializeRowKey } from './metadata.js'

/**
 * Low-level Sheets API write operations.
 *
 * Takes an already-authenticated `sheets_v4.Sheets` client (injected by caller).
 * Handles spreadsheet creation, tab management, header rows, and batch appends.
 */

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 32000
const MAX_RETRIES = 5

// Stripe design-system palette
const COLORS = {
  blurple:       { red: 0.325, green: 0.227, blue: 0.992 }, // #533AFD — brand, purple600
  white:         { red: 1.000, green: 1.000, blue: 1.000 }, // #ffffff
  surfaceBg:     { red: 0.965, green: 0.973, blue: 0.980 }, // #f6f8fa — neutral50 / backgroundColor-container
  tableHeaderBg: { red: 0.922, green: 0.933, blue: 0.945 }, // #ebeef1 — neutral100
  textPrimary:   { red: 0.255, green: 0.271, blue: 0.322 }, // #414552 — neutral700 / textColor-primary
  textSecondary: { red: 0.408, green: 0.451, blue: 0.522 }, // #687385 — neutral500 / textColor-secondary
  attentionBg:   { red: 0.996, green: 0.976, blue: 0.855 }, // #fef9da — attention50
  attentionText: { red: 0.659, green: 0.173, blue: 0.000 }, // #a82c00 — attention600
  linkBlue:      { red: 0.020, green: 0.439, blue: 0.871 }, // #0570de — info500
} as const

// Per-spreadsheet hard cap (https://support.google.com/drive/answer/37603); enforce locally for a clear error.
export const MAX_CELLS_PER_SPREADSHEET = 10_000_000

/** Format a Unix timestamp (seconds) as an ISO 8601 string for storage in a Sheets cell. */
export function unixToIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
  // → "2021-01-01 12:00:00Z" — human-readable, lexicographically sortable, losslessly reversible
}
/** Convert an ISO timestamp string written by {@link unixToIso} back to a Unix timestamp. */
export function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

/** Convert 0-based column index to letter(s): 0→A, 25→Z, 26→AA. */
function colIndexToLetter(idx: number): string {
  let result = ''
  let n = idx + 1
  while (n > 0) {
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result
    n = Math.floor((n - 1) / 26)
  }
  return result
}

/** snake_case field name → "Sentence case" display label. System fields (_x) are returned as-is. */
export function fieldToDisplay(field: string): string {
  if (field.startsWith('_')) return field
  const words = field.split('_').map((w) => w.toLowerCase())
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)
  return words.join(' ')
}

/** Inverse of {@link fieldToDisplay}. Idempotent — safe to apply to already-field-format strings. */
export function displayToField(display: string): string {
  if (display.startsWith('_')) return display
  return display.toLowerCase().replace(/\s+/g, '_')
}

async function withRetry<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  let delay = BACKOFF_BASE_MS
  const overallStart = Date.now()
  if (label) {
    log.debug({ label }, 'withRetry start')
  }
  for (let attempt = 0; ; attempt++) {
    const attemptStart = Date.now()
    try {
      const result = await fn()
      if (label) {
        const attemptMs = Date.now() - attemptStart
        const totalMs = Date.now() - overallStart
        if (attempt === 0) {
          log.debug({ label, attemptMs }, 'withRetry OK first-try')
        } else {
          log.debug(
            { label, attempts: attempt + 1, attemptMs, totalMs },
            'withRetry OK after retries'
          )
        }
      }
      return result
    } catch (err: unknown) {
      const attemptMs = Date.now() - attemptStart
      const rawCode =
        err instanceof Error && 'code' in err ? (err as { code?: number | string }).code : undefined
      const status = typeof rawCode === 'number' ? rawCode : undefined
      const isRateLimit = status === 429
      const isServerError = status !== undefined && status >= 500
      const retriable = isRateLimit || isServerError

      if (retriable && attempt < MAX_RETRIES) {
        if (label) {
          log.warn(
            {
              label,
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              status,
              attemptMs,
              backingOffMs: delay,
            },
            'withRetry retry'
          )
        }
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        continue
      }

      if (label) {
        const totalMs = Date.now() - overallStart
        const reason = retriable
          ? `exhausted ${MAX_RETRIES} retries`
          : `non-retriable (status=${rawCode ?? 'none'})`
        log.error(
          { err, label, reason, attempts: attempt + 1, attemptMs, totalMs },
          'withRetry FAIL'
        )
      }
      throw err
    }
  }
}

/** Create a new spreadsheet and return its ID. */
export async function createSpreadsheet(sheets: sheets_v4.Sheets, title: string): Promise<string> {
  const res = await withRetry(() =>
    sheets.spreadsheets.create({
      requestBody: { properties: { title } },
      fields: 'spreadsheetId',
    })
  )
  const id = res.data.spreadsheetId
  if (!id) throw new Error('Failed to create spreadsheet — no ID returned')
  return id
}

/** Metadata returned by {@link getSpreadsheetMeta} for reuse across setup steps. */
export interface SpreadsheetMeta {
  sheets: Array<{
    title: string
    sheetId: number
    hasProtection: boolean
  }>
}

export interface EnumValidationRule {
  allowedValues: string[]
}

export type StreamEnumValidationRules = Map<string, Map<string, EnumValidationRule>>

/** Fetch spreadsheet metadata once for reuse by ensureSheets, ensureIntroSheet, protectSheets. */
export async function getSpreadsheetMeta(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<SpreadsheetMeta> {
  const meta = await withRetry(
    () =>
      sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title),protectedRanges(protectedRangeId))',
      }),
    'getSpreadsheetMeta'
  )
  return {
    sheets: (meta.data.sheets ?? []).map((s) => ({
      title: s.properties?.title ?? '',
      sheetId: s.properties?.sheetId ?? 0,
      hasProtection: (s.protectedRanges ?? []).length > 0,
    })),
  }
}

/**
 * Ensure tabs exist for all streams in one pass.
 *
 * 1. Uses pre-fetched metadata to find existing/missing tabs.
 * 2. Creates all missing tabs in a single batchUpdate (renames Sheet1 for first if present).
 * 3. Writes all header rows in a single values.batchUpdate.
 *
 * Returns a Map of stream name → numeric sheetId.
 */
export async function ensureSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  streamHeaders: Array<{ streamName: string; headers: string[] }>
): Promise<Map<string, number>> {
  const existingByName = new Map(meta.sheets.map((s) => [s.title, s.sheetId]))
  const result = new Map<string, number>()
  const toCreate: string[] = []

  for (const { streamName } of streamHeaders) {
    const existingId = existingByName.get(streamName)
    if (existingId !== undefined) {
      result.set(streamName, existingId)
    } else {
      toCreate.push(streamName)
    }
  }

  if (toCreate.length > 0) {
    const requests: sheets_v4.Schema$Request[] = []
    let renamedSheet1 = false

    // Rename Sheet1 for the first missing tab if available
    const sheet1 = meta.sheets.find((s) => s.title === 'Sheet1')
    if (sheet1) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet1.sheetId, title: toCreate[0] },
          fields: 'title',
        },
      })
      result.set(toCreate[0], sheet1.sheetId)
      renamedSheet1 = true
    }

    const startIdx = renamedSheet1 ? 1 : 0
    for (let i = startIdx; i < toCreate.length; i++) {
      requests.push({ addSheet: { properties: { title: toCreate[i] } } })
    }

    const res = await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests },
        }),
      'ensureSheets:create'
    )

    const replies = res.data.replies ?? []
    let replyIdx = renamedSheet1 ? 1 : 0
    for (let i = startIdx; i < toCreate.length; i++) {
      const sheetId = replies[replyIdx]?.addSheet?.properties?.sheetId
      if (sheetId == null) {
        throw new Error(`Failed to get sheetId for new sheet "${toCreate[i]}"`)
      }
      result.set(toCreate[i], sheetId)
      replyIdx++
    }
  }

  // Write all header rows in one values.batchUpdate
  const headerData = streamHeaders
    .filter(({ headers }) => headers.length > 0)
    .map(({ streamName, headers }) => ({
      range: `'${streamName}'!A1`,
      values: [headers.map(fieldToDisplay)],
    }))

  if (headerData.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: headerData },
        }),
      'ensureSheets:headers'
    )
  }

  // Freeze header row and first column on all data sheets
  const freezeRequests: sheets_v4.Schema$Request[] = []
  for (const sheetId of result.values()) {
    freezeRequests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    })
  }
  if (freezeRequests.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: freezeRequests },
        }),
      'ensureSheets:freeze'
    )
  }

  return result
}

/**
 * Ensure a single tab exists with a header row.
 * Used by the write path for on-demand tab creation (new stream or header change).
 * For bulk setup, prefer {@link ensureSheets}.
 */
export async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamName: string,
  headers: string[]
): Promise<number> {
  const meta = await getSpreadsheetMeta(sheets, spreadsheetId)
  const result = await ensureSheets(sheets, spreadsheetId, meta, [{ streamName, headers }])
  return result.get(streamName)!
}

async function writeHeaderRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headers: string[]
): Promise<void> {
  if (headers.length === 0) return
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers.map(fieldToDisplay)] },
    })
  )
}

/** Read the first row from a sheet tab and treat it as headers. */
export async function readHeaderRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<string[]> {
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!1:1`,
    })
  )
  const [headerRow] = res.data.values ?? []
  return Array.isArray(headerRow) ? headerRow.map((value) => String(value)) : []
}

function columnLabel(index: number): string {
  let value = index
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label || 'A'
}

function cloneEnumValidationRule(rule: EnumValidationRule): EnumValidationRule {
  return { allowedValues: [...rule.allowedValues] }
}

function toDataValidationRule(rule: EnumValidationRule): Record<string, unknown> {
  return {
    condition: {
      type: 'ONE_OF_LIST',
      values: rule.allowedValues.map((value) => ({ userEnteredValue: value })),
    },
    strict: true,
    showCustomUi: true,
  }
}

function parseEnumValidationRule(dataValidation: unknown): EnumValidationRule | undefined {
  const condition = (dataValidation as { condition?: { type?: string; values?: unknown[] } })
    ?.condition
  if (condition?.type !== 'ONE_OF_LIST') return undefined
  const allowedValues = (condition.values ?? [])
    .map((value) => (value as { userEnteredValue?: string })?.userEnteredValue)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return allowedValues.length > 0 ? { allowedValues } : undefined
}

function validationReadRange(streamName: string, columnCount: number): string {
  return `'${streamName}'!A2:${columnLabel(columnCount)}2`
}

export async function setEnumValidations(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetIds: Map<string, number>,
  streamHeaders: Array<{ streamName: string; headers: string[] }>,
  desiredRules: StreamEnumValidationRules
): Promise<void> {
  const requests: sheets_v4.Schema$Request[] = []

  for (const { streamName, headers } of streamHeaders) {
    const sheetId = sheetIds.get(streamName)
    if (sheetId === undefined) {
      throw new Error(`Missing sheetId for "${streamName}" while applying enum validations`)
    }
    const streamRules = desiredRules.get(streamName)
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      const header = headers[columnIndex]
      const rule = streamRules?.get(header)
      requests.push({
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
          ...(rule ? { rule: toDataValidationRule(rule) } : {}),
        },
      })
    }
  }

  if (requests.length === 0) return

  await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      }),
    'setEnumValidations'
  )
}

export async function readEnumValidations(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamHeaders: Array<{ streamName: string; headers: string[] }>
): Promise<StreamEnumValidationRules> {
  const targets = streamHeaders.filter(({ headers }) => headers.length > 0)
  if (targets.length === 0) return new Map()

  const response = await withRetry(
    () =>
      sheets.spreadsheets.get({
        spreadsheetId,
        ranges: targets.map(({ streamName, headers }) =>
          validationReadRange(streamName, headers.length)
        ),
        fields: 'sheets(properties(title,sheetId),data(rowData(values(dataValidation))))',
      }),
    'readEnumValidations'
  )

  const headersByStream = new Map(targets.map(({ streamName, headers }) => [streamName, headers]))
  const out: StreamEnumValidationRules = new Map()

  for (const sheet of response.data.sheets ?? []) {
    const streamName = sheet.properties?.title
    if (!streamName) continue
    const headers = headersByStream.get(streamName)
    if (!headers) continue
    const cells = sheet.data?.[0]?.rowData?.[0]?.values ?? []
    const streamRules = new Map<string, EnumValidationRule>()
    for (let index = 0; index < headers.length; index++) {
      const header = headers[index]
      const rule = parseEnumValidationRule(cells[index]?.dataValidation)
      if (rule) streamRules.set(header, cloneEnumValidationRule(rule))
    }
    if (streamRules.size > 0) out.set(streamName, streamRules)
  }

  return out
}

/** Look up the numeric sheetId for a tab by name. Returns undefined if not found. */
export async function findSheetId(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<number | undefined> {
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
  )
  const tab = meta.data.sheets?.find((s) => s.properties?.title === sheetName)
  return tab?.properties?.sheetId ?? undefined
}

function parseUpdatedRows(updatedRange: string): { startRow: number; endRow: number } {
  const match = updatedRange.match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/i)
  if (!match) throw new Error(`Unable to parse updated range: ${updatedRange}`)
  return {
    startRow: Number(match[1]),
    endRow: Number(match[2] ?? match[1]),
  }
}

/** Apply Stripe-branded formatting to the Overview tab. */
async function formatIntroSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  streamCount: number
): Promise<void> {
  // Row layout (0-based): 0=title, 1=spacer, 2-3=description, 4=spacer,
  // 5=table header, 6..5+N=stream rows, 6+N=spacer, 7+N=timestamp, 8+N=spacer, 9+N=warning,
  // 10+N=spacer, 11+N=guide header, 12+N=spacer, 13+N=sub-header 1, 14-16+N=bullets,
  // 17+N=spacer, 18+N=sub-header 2, 19+N=bullet, 20+N=dashboard link
  const TABLE_HEADER_ROW = 5
  const WARNING_ROW = 9 + streamCount
  const GUIDE_HEADER_ROW = 11 + streamCount
  const WORKING_SUBHEADER_ROW = 13 + streamCount
  const MANAGING_SUBHEADER_ROW = 18 + streamCount
  const GUIDE_END_ROW = 21 + streamCount // exclusive

  const requests: sheets_v4.Schema$Request[] = [
    // Column widths: A=240, B=40, C-D=120
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 240 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 40 },  fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 4 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } },
    // Title row height
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 56 }, fields: 'pixelSize' } },
    // Merge A1:D1 into a single hero cell
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }, mergeType: 'MERGE_ALL' } },
    // Title: Stripe navy bg, white bold 16pt, vertically centered, left-padded
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: COLORS.blurple,
            textFormat: { foregroundColor: COLORS.white, bold: true, fontSize: 16 },
            verticalAlignment: 'MIDDLE',
            padding: { top: 0, bottom: 0, left: 16, right: 0 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,padding)',
      },
    },
    // Description rows: muted gray text
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 4 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textPrimary, fontSize: 10 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    // Table header: medium gray bg, bold
    {
      repeatCell: {
        range: { sheetId, startRowIndex: TABLE_HEADER_ROW, endRowIndex: TABLE_HEADER_ROW + 1 },
        cell: { userEnteredFormat: { backgroundColor: COLORS.tableHeaderBg, textFormat: { bold: true, fontSize: 10 } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // Warning row: amber bg, amber-brown text
    {
      repeatCell: {
        range: { sheetId, startRowIndex: WARNING_ROW, endRowIndex: WARNING_ROW + 1 },
        cell: { userEnteredFormat: { backgroundColor: COLORS.attentionBg, textFormat: { foregroundColor: COLORS.attentionText, fontSize: 10 } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    // Merge A:C for every row in the guide section so text has room to breathe
    ...Array.from({ length: GUIDE_END_ROW - GUIDE_HEADER_ROW }, (_, i) => ({
      mergeCells: {
        range: { sheetId, startRowIndex: GUIDE_HEADER_ROW + i, endRowIndex: GUIDE_HEADER_ROW + i + 1, startColumnIndex: 0, endColumnIndex: 3 },
        mergeType: 'MERGE_ALL' as const,
      },
    })),
    // Guide section: gray text, 10pt, wrapped
    {
      repeatCell: {
        range: { sheetId, startRowIndex: GUIDE_HEADER_ROW, endRowIndex: GUIDE_END_ROW },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textPrimary, fontSize: 10 }, wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(textFormat,wrapStrategy)',
      },
    },
    // Guide header: bold 11pt
    {
      repeatCell: {
        range: { sheetId, startRowIndex: GUIDE_HEADER_ROW, endRowIndex: GUIDE_HEADER_ROW + 1 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textPrimary, bold: true, fontSize: 11 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    // Sub-headers: bold 10pt
    {
      repeatCell: {
        range: { sheetId, startRowIndex: WORKING_SUBHEADER_ROW, endRowIndex: WORKING_SUBHEADER_ROW + 1 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textPrimary, bold: true, fontSize: 10 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: MANAGING_SUBHEADER_ROW, endRowIndex: MANAGING_SUBHEADER_ROW + 1 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textPrimary, bold: true, fontSize: 10 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    // Dashboard link row: standard link blue, bold
    {
      repeatCell: {
        range: { sheetId, startRowIndex: GUIDE_END_ROW - 1, endRowIndex: GUIDE_END_ROW },
        cell: {
          userEnteredFormat: {
            textFormat: { foregroundColor: COLORS.linkBlue, bold: true, fontSize: 10 },
          },
        },
        fields: 'userEnteredFormat.textFormat',
      },
    },
  ]

  await withRetry(
    () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
    'formatIntroSheet'
  )
}

/**
 * Create or update an "Overview" intro tab at index 0.
 * Lists the synced streams and warns users not to edit data tabs.
 */
export async function ensureIntroSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  streamNames: string[]
): Promise<void> {
  const TITLE = 'Overview'
  const existingSheet = meta.sheets.find((s) => s.title === TITLE)
  let overviewSheetId: number

  if (!existingSheet) {
    // Rename "Sheet1" if it's the only tab, otherwise insert at index 0
    const sheet1 = meta.sheets.find((s) => s.title === 'Sheet1')
    if (meta.sheets.length === 1 && sheet1) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ updateSheetProperties: { properties: { sheetId: sheet1.sheetId, title: TITLE }, fields: 'title' } }],
          },
        })
      )
      overviewSheetId = sheet1.sheetId
    } else {
      const res = await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: TITLE, index: 0 } } }] },
        })
      )
      const newSheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId
      if (newSheetId == null) throw new Error('Failed to create Overview sheet — no sheetId returned')
      overviewSheetId = newSheetId
    }
  } else {
    overviewSheetId = existingSheet.sheetId
  }

  const formattedDate = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(new Date())

  const rows: string[][] = [
    ['Stripe Sync Engine'],
    [''],
    ['This spreadsheet is managed by Stripe Sync Engine.'],
    ['Data is synced automatically from your Stripe account.'],
    [''],
    ['Synced streams:', '', 'Rows'],
    ...streamNames.map((name) => [
      `  • ${name}`,
      '',
      `=COUNTA('${name}'!A2:A)`,
    ]),
    [''],
    [`Last setup: ${formattedDate}`],
    [''],
    ['⚠️  Do not edit data in the synced tabs. Changes will be overwritten on the next sync.'],
    [''],
    ['Getting started'],
    [''],
    ['Working with synced data'],
    ['  • To build reports or analysis, create a new tab and reference synced data using standard formulas or named ranges (e.g. =SUM(products.amount) or =VLOOKUP(id, customers.id, 1, FALSE)).'],
    ['  • Deleted records are automatically removed from this sheet on the next sync.'],
    ['  • Share this spreadsheet with teammates using standard Google Sheets sharing — permissions and access work exactly as normal.'],
    [''],
    ['Managing your sync'],
    ['  • Stop live syncing at any time by deleting the pipeline from the Stripe Dashboard.'],
    [`=HYPERLINK("https://dashboard.stripe.com/data-management/pipeline","https://dashboard.stripe.com/data-management/pipeline")`],
  ]

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${TITLE}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    })
  )

  await formatIntroSheet(sheets, spreadsheetId, overviewSheetId, streamNames.length)
}

// MARK: - Examples Sheet

interface ExampleSection {
  title: string
  description: string
  tableHeader: string[]
  rows: string[][]
  chartType: 'PIE' | 'COLUMN' | 'BAR' | 'LINE'
  chartTitle: string
  domainColumn: number
  seriesColumn: number
}

/**
 * Build the list of example sections to include based on which streams are available.
 * Each section is conditionally included only if its required streams and fields are present.
 * Exported for unit testing.
 */
export function buildExampleSections(
  streamHeaders: Array<{ streamName: string; headers: string[] }>
): ExampleSection[] {
  const headerMap = new Map(streamHeaders.map(({ streamName, headers }) => [streamName, headers]))
  const hasField = (stream: string, field: string) =>
    headerMap.get(stream)?.includes(field) ?? false
  const hasStream = (stream: string) => headerMap.has(stream)

  // Returns the full-column data range (row 2 onward) for a stream+field combo.
  const r = (stream: string, field: string): string => {
    const hdrs = headerMap.get(stream)!
    const idx = hdrs.indexOf(field)
    return `'${stream}'!${colIndexToLetter(idx)}2:${colIndexToLetter(idx)}`
  }

  const sections: ExampleSection[] = []

  // Subscription Status Breakdown
  if (hasStream('subscriptions') && hasField('subscriptions', 'status')) {
    const statusRange = r('subscriptions', 'status')
    const statuses = [
      'active', 'trialing', 'past_due', 'canceled',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused',
    ]
    sections.push({
      title: 'Subscription Status',
      description: 'Current subscription counts by lifecycle status.',
      tableHeader: ['Status', 'Count'],
      rows: statuses.map((s) => [s, `=COUNTIF(${statusRange},"${s}")`]),
      chartType: 'PIE',
      chartTitle: 'Subscriptions by Status',
      domainColumn: 0,
      seriesColumn: 1,
    })
  }

  // New Customers by Month (last 6 months, using Unix timestamp conversion)
  if (hasStream('customers') && hasField('customers', 'created')) {
    const createdRange = r('customers', 'created')
    const rows: string[][] = []
    for (let i = 5; i >= 0; i--) {
      // EDATE shifts the first-of-month by N months; negative = past
      const monthLabel = `=TEXT(EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),${-i}),"YYYY-MM")`
      // COUNTIFS >=/<  only works on numbers/dates, not text strings.
      // DATEVALUE(LEFT(cell,10)) parses the "yyyy-mm-dd" prefix of the ISO string into a Sheets date serial.
      const start = `EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),${-i})`
      const end = `EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),${-(i - 1)})`
      const parsed = `IFERROR(DATEVALUE(LEFT(${createdRange},10)),0)`
      rows.push([monthLabel, `=SUMPRODUCT((${parsed}>=${start})*(${parsed}<${end}))`])
    }
    sections.push({
      title: 'New Customers by Month',
      description: 'New customers created per month for the last 6 months.',
      tableHeader: ['Month', 'New Customers'],
      rows,
      chartType: 'COLUMN',
      chartTitle: 'New Customers (Last 6 Months)',
      domainColumn: 0,
      seriesColumn: 1,
    })
  }

  // Payment Volume by Status
  if (
    hasStream('payment_intents') &&
    hasField('payment_intents', 'status') &&
    hasField('payment_intents', 'amount')
  ) {
    const statusRange = r('payment_intents', 'status')
    const amountRange = r('payment_intents', 'amount')
    const statuses = [
      'succeeded', 'canceled', 'requires_payment_method',
      'processing', 'requires_capture', 'requires_action', 'requires_confirmation',
    ]
    sections.push({
      title: 'Payment Volume by Status',
      description: 'Payment counts and total amounts by status. Amounts are in the smallest currency unit (e.g. cents for USD).',
      tableHeader: ['Status', 'Count', 'Total Amount'],
      rows: statuses.map((s) => [
        s,
        `=COUNTIF(${statusRange},"${s}")`,
        `=SUMIF(${statusRange},"${s}",${amountRange})`,
      ]),
      chartType: 'BAR',
      chartTitle: 'Payments by Status',
      domainColumn: 0,
      seriesColumn: 1,
    })
  }

  // Active vs Archived Products
  if (hasStream('products') && hasField('products', 'active')) {
    const activeRange = r('products', 'active')
    sections.push({
      title: 'Products: Active vs Archived',
      description: 'Count of active vs archived products.',
      tableHeader: ['Status', 'Count'],
      rows: [
        ['Active', `=COUNTIF(${activeRange},"true")`],
        ['Archived', `=COUNTIF(${activeRange},"false")`],
      ],
      chartType: 'PIE',
      chartTitle: 'Products: Active vs Archived',
      domainColumn: 0,
      seriesColumn: 1,
    })
  }

  // Revenue by Currency (succeeded payment_intents only)
  if (
    hasStream('payment_intents') &&
    hasField('payment_intents', 'currency') &&
    hasField('payment_intents', 'amount') &&
    hasField('payment_intents', 'status')
  ) {
    const currRange = r('payment_intents', 'currency')
    const amtRange = r('payment_intents', 'amount')
    const staRange = r('payment_intents', 'status')
    const currencies = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy', 'chf', 'sek', 'nok', 'dkk']
    sections.push({
      title: 'Revenue by Currency',
      description: 'Total revenue from succeeded payment intents, grouped by currency. Add or remove rows for your currencies.',
      tableHeader: ['Currency', 'Total Amount', 'Count'],
      rows: currencies.map((c) => [
        c.toUpperCase(),
        `=SUMPRODUCT((${currRange}="${c}")*(${staRange}="succeeded")*IFERROR(VALUE(${amtRange}),0))`,
        `=SUMPRODUCT((${currRange}="${c}")*(${staRange}="succeeded"))`,
      ]),
      chartType: 'BAR',
      chartTitle: 'Revenue by Currency (Succeeded)',
      domainColumn: 0,
      seriesColumn: 1,
    })
  }

  // Multi-table: Invoice Revenue by Subscription Status
  // Uses COUNTIFS across sheets to join invoices → subscriptions by subscription ID.
  if (
    hasStream('invoices') &&
    hasField('invoices', 'subscription') &&
    hasField('invoices', 'amount_paid') &&
    hasStream('subscriptions') &&
    hasField('subscriptions', 'id') &&
    hasField('subscriptions', 'status')
  ) {
    const invSubRange = r('invoices', 'subscription')
    const invAmtRange = r('invoices', 'amount_paid')
    const subIdRange = r('subscriptions', 'id')
    const subStaRange = r('subscriptions', 'status')
    const statuses = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'paused', 'incomplete']
    sections.push({
      title: 'Invoice Revenue by Subscription Status',
      description: 'Total invoice revenue (amount_paid) by the current status of the linked subscription. Combines the invoices + subscriptions tables.',
      tableHeader: ['Subscription Status', 'Invoice Revenue'],
      rows: statuses.map((s) => [
        s,
        // COUNTIFS(subIdRange, each invoice.subscription, subStaRange, status) returns an array;
        // >0 is true when the invoice's subscription has that status.
        `=SUMPRODUCT((${invSubRange}<>"")*IFERROR(VALUE(${invAmtRange}),0)*(COUNTIFS(${subIdRange},${invSubRange},${subStaRange},"${s}")>0))`,
      ]),
      chartType: 'BAR',
      chartTitle: 'Invoice Revenue by Sub Status',
      domainColumn: 0,
      seriesColumn: 1,
    })
  }

  return sections
}

/**
 * Create (or recreate) an "Examples" sheet with formula-based pivot tables and embedded charts.
 * Sections are conditionally included based on which streams are available in the catalog.
 * The sheet is deleted and recreated on each setup call to avoid chart accumulation.
 */
export async function ensureExamplesSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  streamHeaders: Array<{ streamName: string; headers: string[] }>
): Promise<void> {
  const TITLE = 'Examples'
  const sections = buildExampleSections(streamHeaders)
  if (sections.length === 0) return

  // Delete existing Examples sheet so charts don't accumulate on re-setup.
  const existing = meta.sheets.find((s) => s.title === TITLE)
  if (existing) {
    await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ deleteSheet: { sheetId: existing.sheetId } }] },
        }),
      'ensureExamplesSheet:delete'
    )
  }

  // Create the sheet at index 1 (after Overview).
  const createRes = await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: TITLE, index: 1 } } }] },
      }),
    'ensureExamplesSheet:create'
  )
  const sheetId = createRes.data.replies?.[0]?.addSheet?.properties?.sheetId
  if (sheetId == null) throw new Error('Failed to create Examples sheet — no sheetId returned')

  // Build the full row list, tracking each section's position for chart anchoring.
  // Layout per section: title | description | table-header | N data rows | ≥2 spacer rows.
  // MIN_SECTION_HEIGHT ensures the chart (260px ≈ 12 default rows) fits within each section.
  const MIN_SECTION_HEIGHT = 14

  interface SectionPos {
    tableHeaderRow: number // 0-based row index of the table header (chart anchor)
    dataStartRow: number   // 0-based row index of first data row
    dataEndRow: number     // 0-based exclusive end of data rows
  }

  const allRows: string[][] = [
    ['Stripe Analytics'],
    ['Example pivot tables and charts based on your synced Stripe data. Edit freely — data tabs are the source of truth.'],
    [''],
  ]
  const positions: SectionPos[] = []

  for (const section of sections) {
    const titleRow = allRows.length
    allRows.push([section.title])
    allRows.push([section.description])
    const tableHeaderRow = allRows.length
    allRows.push(section.tableHeader)
    const dataStartRow = allRows.length
    for (const row of section.rows) allRows.push(row)
    const dataEndRow = allRows.length

    const sectionHeight = dataEndRow - titleRow
    const spacers = Math.max(2, MIN_SECTION_HEIGHT - sectionHeight)
    for (let i = 0; i < spacers; i++) allRows.push([''])

    positions.push({ tableHeaderRow, dataStartRow, dataEndRow })
  }

  await withRetry(
    () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${TITLE}'!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: allRows },
      }),
    'ensureExamplesSheet:values'
  )

  // Formatting
  const fmtRequests: sheets_v4.Schema$Request[] = [
    // Column widths: A=220, B=140, C=140
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    // Page title row height
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 48 }, fields: 'pixelSize' } },
    // Page title: merge + navy bg + white bold text
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 }, mergeType: 'MERGE_ALL' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: COLORS.blurple, textFormat: { foregroundColor: COLORS.white, bold: true, fontSize: 14 }, verticalAlignment: 'MIDDLE', padding: { top: 0, bottom: 0, left: 16, right: 0 } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,padding)',
      },
    },
    // Subtitle: gray 10pt wrapped
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textSecondary, fontSize: 10 }, wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(textFormat,wrapStrategy)',
      },
    },
  ]

  for (const pos of positions) {
    const descRow = pos.tableHeaderRow - 1
    const titleRow = descRow - 1
    // Section title: bold 11pt
    fmtRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: titleRow, endRowIndex: titleRow + 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 11 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    })
    // Description: gray 10pt wrapped
    fmtRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: descRow, endRowIndex: descRow + 1 },
        cell: { userEnteredFormat: { textFormat: { foregroundColor: COLORS.textSecondary, fontSize: 10 }, wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(textFormat,wrapStrategy)',
      },
    })
    // Table header: gray bg + bold 10pt
    fmtRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: pos.tableHeaderRow, endRowIndex: pos.tableHeaderRow + 1 },
        cell: { userEnteredFormat: { backgroundColor: COLORS.tableHeaderBg, textFormat: { bold: true, fontSize: 10 } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    })
  }

  await withRetry(
    () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: fmtRequests } }),
    'ensureExamplesSheet:format'
  )

  // Embed charts — positioned to the right of each table starting at column E (index 4).
  const chartRequests: sheets_v4.Schema$Request[] = []
  const CHART_COL = 4  // column E
  const CHART_WIDTH = 420
  const CHART_HEIGHT = 260

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const pos = positions[i]
    const domainRange = {
      sheetId,
      startRowIndex: pos.dataStartRow,
      endRowIndex: pos.dataEndRow,
      startColumnIndex: section.domainColumn,
      endColumnIndex: section.domainColumn + 1,
    }
    const seriesRange = {
      sheetId,
      startRowIndex: pos.dataStartRow,
      endRowIndex: pos.dataEndRow,
      startColumnIndex: section.seriesColumn,
      endColumnIndex: section.seriesColumn + 1,
    }
    const anchor = { sheetId, rowIndex: pos.tableHeaderRow, columnIndex: CHART_COL }

    if (section.chartType === 'PIE') {
      chartRequests.push({
        addChart: {
          chart: {
            spec: {
              title: section.chartTitle,
              pieChart: {
                legendPosition: 'RIGHT_LEGEND',
                domain: { sourceRange: { sources: [domainRange] } },
                series: { sourceRange: { sources: [seriesRange] } },
              },
            },
            position: {
              overlayPosition: {
                anchorCell: anchor,
                widthPixels: CHART_WIDTH,
                heightPixels: CHART_HEIGHT,
              },
            },
          },
        },
      })
    } else {
      const chartType =
        section.chartType === 'BAR' ? 'BAR' : section.chartType === 'LINE' ? 'LINE' : 'COLUMN'
      // BAR charts use BOTTOM_AXIS for series (horizontal); COLUMN/LINE use LEFT_AXIS (vertical).
      const seriesAxis = chartType === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS'
      chartRequests.push({
        addChart: {
          chart: {
            spec: {
              title: section.chartTitle,
              basicChart: {
                chartType,
                legendPosition: 'NO_LEGEND',
                domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
                series: [
                  {
                    series: { sourceRange: { sources: [seriesRange] } },
                    targetAxis: seriesAxis,
                  },
                ],
                axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
              },
            },
            position: {
              overlayPosition: {
                anchorCell: anchor,
                widthPixels: CHART_WIDTH,
                heightPixels: CHART_HEIGHT,
              },
            },
          },
        },
      })
    }
  }

  if (chartRequests.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: chartRequests } }),
      'ensureExamplesSheet:charts'
    )
  }
}

/**
 * Add warning-only protection to sheets that don't already have it.
 * Uses pre-fetched metadata to skip already-protected sheets and batches
 * all `addProtectedRange` requests into a single API call.
 */
export async function protectSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  sheetIds: number[]
): Promise<void> {
  const alreadyProtected = new Set(meta.sheets.filter((s) => s.hasProtection).map((s) => s.sheetId))
  const requests: sheets_v4.Schema$Request[] = []
  for (const sheetId of sheetIds) {
    if (alreadyProtected.has(sheetId)) continue
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId },
          description: 'Managed by Stripe Sync Engine — edits may be overwritten on next sync',
          warningOnly: true,
        },
      },
    })
  }
  if (requests.length === 0) return
  await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      }),
    'protectSheets'
  )
}

function sanitizeNamedRangePart(s: string): string {
  const safe = s.replace(/[^a-zA-Z0-9_]/g, '_')
  return /^[^a-zA-Z_]/.test(safe) ? `_${safe}` : safe
}

/**
 * Create (or recreate) named ranges for every column of every stream in the format
 * `stream.column` (e.g. `customers.id`). Covers data rows only (row 2 onward).
 * Existing named ranges matching the target names are deleted first to prevent duplicates.
 */
export async function ensureNamedRanges(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetIdMap: Map<string, number>,
  streamHeaders: Array<{ streamName: string; headers: string[] }>
): Promise<void> {
  if (streamHeaders.every(({ headers }) => headers.length === 0)) return

  const metaRes = await withRetry(
    () => sheets.spreadsheets.get({ spreadsheetId, fields: 'namedRanges(namedRangeId,name)' }),
    'ensureNamedRanges:fetch'
  )

  // Build the full set of names we're about to create
  const targetNames = new Set<string>()
  for (const { streamName, headers } of streamHeaders) {
    for (const header of headers) {
      targetNames.add(`${sanitizeNamedRangePart(streamName)}.${sanitizeNamedRangePart(header)}`)
    }
  }

  const requests: sheets_v4.Schema$Request[] = []

  // Delete existing named ranges that we'll recreate (prevents duplicates on re-setup)
  for (const nr of metaRes.data.namedRanges ?? []) {
    if (nr.namedRangeId && nr.name && targetNames.has(nr.name)) {
      requests.push({ deleteNamedRange: { namedRangeId: nr.namedRangeId } })
    }
  }

  // Create one named range per column, starting at row 2 (index 1) to skip the header
  for (const { streamName, headers } of streamHeaders) {
    const sheetId = sheetIdMap.get(streamName)
    if (sheetId === undefined) continue
    for (let i = 0; i < headers.length; i++) {
      requests.push({
        addNamedRange: {
          namedRange: {
            name: `${sanitizeNamedRangePart(streamName)}.${sanitizeNamedRangePart(headers[i])}`,
            range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          },
        },
      })
    }
  }

  if (requests.length === 0) return

  await withRetry(
    () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
    'ensureNamedRanges'
  )
}

// ── Sheet visual formatting ──────────────────────────────────────────────────

type SemType = 'id' | 'timestamp' | 'amount' | 'boolean' | 'enum' | 'object' | 'system' | 'text'

export interface StreamFormattingInfo {
  streamName: string
  sheetId: number
  headers: string[]
  properties?: Record<string, unknown>
}

const TAB_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  // info500 #0570de
  customers:          { red: 0.020, green: 0.439, blue: 0.871 },
  invoices:           { red: 0.020, green: 0.439, blue: 0.871 },
  // success400 #3fa40d
  subscriptions:      { red: 0.247, green: 0.643, blue: 0.051 },
  subscription_items: { red: 0.247, green: 0.643, blue: 0.051 },
  // brand/blurple #533AFD
  products:           { red: 0.325, green: 0.227, blue: 0.992 },
  prices:             { red: 0.325, green: 0.227, blue: 0.992 },
  // attention500 #c84801
  charges:            { red: 0.784, green: 0.282, blue: 0.004 },
  payment_intents:    { red: 0.784, green: 0.282, blue: 0.004 },
  // critical500 #df1b41
  refunds:            { red: 0.875, green: 0.106, blue: 0.255 },
  disputes:           { red: 0.875, green: 0.106, blue: 0.255 },
  // neutral600 #545969
  payouts:            { red: 0.329, green: 0.349, blue: 0.412 },
  // neutral500 #687385
  events:             { red: 0.408, green: 0.451, blue: 0.522 },
}

const STRIPE_DASHBOARD_PATHS: Record<string, string> = {
  customers:       'customers',
  charges:         'payments',
  payment_intents: 'payments',
  invoices:        'invoices',
  subscriptions:   'subscriptions',
  products:        'products',
  prices:          'prices',
  payouts:         'payouts',
  disputes:        'disputes',
  events:          'events',
}

const STATUS_POSITIVE = new Set([
  'active', 'paid', 'succeeded', 'complete', 'completed', 'posted',
  'available', 'accepted', 'won', 'verified', 'enabled', 'delivered',
])
const STATUS_NEGATIVE = new Set([
  'canceled', 'cancelled', 'failed', 'void', 'overdue', 'unpaid',
  'reversed', 'lost', 'refunded', 'expired', 'errored', 'blocked', 'declined', 'disabled',
])
const STATUS_WARNING = new Set([
  'pending', 'processing', 'open', 'incomplete', 'trialing', 'past_due',
  'paused', 'in_transit', 'queued', 'requires_action',
  'requires_payment_method', 'requires_confirmation', 'requires_capture',
  'chargeable', 'created',
])

const COL_WIDTHS: Record<SemType, number> = {
  id: 220, timestamp: 180, amount: 100, boolean: 80,
  enum: 120, object: 180, system: 140, text: 150,
}

const HEADER_TINTS: Partial<Record<SemType, { red: number; green: number; blue: number }>> = {
  id:        { red: 0.812, green: 0.961, blue: 0.965 }, // info100   #cff5f6
  timestamp: { red: 0.843, green: 0.969, blue: 0.761 }, // success100 #d7f7c2
  amount:    { red: 0.988, green: 0.929, blue: 0.725 }, // attention100 #fcedb9
  boolean:   { red: 0.949, green: 0.922, blue: 1.000 }, // brand100  #f2ebff
  system:    { red: 0.922, green: 0.933, blue: 0.945 }, // neutral100 #ebeef1
}

function getEffectiveSchema(prop: unknown): { type?: string; format?: string; enum?: string[] } {
  if (!prop || typeof prop !== 'object') return {}
  const p = prop as Record<string, unknown>
  const variants = (p['oneOf'] ?? p['anyOf']) as Array<Record<string, unknown>> | undefined
  if (variants) {
    const nonNull = variants.find((v) => v['type'] !== 'null')
    return (nonNull ?? p) as { type?: string; format?: string; enum?: string[] }
  }
  return p as { type?: string; format?: string; enum?: string[] }
}

/** Returns true if the field holds a Unix timestamp, regardless of whether it is a system field. */
export function isTimestampField(field: string, prop: unknown): boolean {
  const schema = getEffectiveSchema(prop)
  return (
    schema.format === 'unix-time' ||
    schema.format === 'date-time' ||
    field.endsWith('_at') ||
    field.endsWith('_date') ||
    field === 'created' ||
    field === 'updated'
  )
}

export function inferSemType(field: string, prop: unknown): SemType {
  if (field.startsWith('_')) return 'system'
  if (field === 'id' || (field.endsWith('_id') && field.length > 3)) return 'id'
  const schema = getEffectiveSchema(prop)
  if (isTimestampField(field, prop))
    return 'timestamp'
  if (
    field === 'amount' ||
    field.endsWith('_amount') ||
    field === 'unit_amount' ||
    field.endsWith('_cents') ||
    field === 'quantity'
  )
    return 'amount'
  if (schema.type === 'boolean') return 'boolean'
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum'
  if (schema.type === 'object') return 'object'
  return 'text'
}

/**
 * Apply visual formatting to data sheets after setup:
 * 1. Header tinting by semantic type (handled via ensureSheets fieldToDisplay)
 * 2. Tab colors by stream category
 * 3. Column widths by semantic type
 * 4. Row banding (alternating white / light gray)
 * 5. Conditional formatting for status enum values
 * 6. System column data dimming (gray italic)
 * 7. Stripe Dashboard deep-link companion column (ARRAYFORMULA)
 */
export async function applyDataSheetFormatting(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streams: StreamFormattingInfo[]
): Promise<void> {
  if (streams.length === 0) return

  const sheetIdSet = new Set(streams.map((s) => s.sheetId))

  // Fetch existing bandings + conditional format counts for re-setup cleanup
  const metaRes = await withRetry(
    () =>
      sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId),bandedRanges(bandedRangeId),conditionalFormats)',
      }),
    'applyDataSheetFormatting:meta'
  )

  const allRequests: sheets_v4.Schema$Request[] = []

  // Cleanup existing bandings and conditional format rules (idempotent re-setup)
  for (const sheet of metaRes.data.sheets ?? []) {
    const sheetId = sheet.properties?.sheetId
    if (sheetId == null || !sheetIdSet.has(sheetId)) continue
    for (const band of sheet.bandedRanges ?? []) {
      if (band.bandedRangeId != null) {
        allRequests.push({ deleteBanding: { bandedRangeId: band.bandedRangeId } })
      }
    }
    const ruleCount = (sheet.conditionalFormats ?? []).length
    for (let i = ruleCount - 1; i >= 0; i--) {
      allRequests.push({ deleteConditionalFormatRule: { sheetId, index: i } })
    }
  }

  for (const { streamName, sheetId, headers, properties } of streams) {
    if (headers.length === 0) continue
    const semTypes = headers.map((h) => inferSemType(h, properties?.[h]))

    // Tab color
    const tabColor = TAB_COLORS[streamName]
    if (tabColor) {
      allRequests.push({
        updateSheetProperties: { properties: { sheetId, tabColor }, fields: 'tabColor' },
      })
    }

    // Column widths
    for (let i = 0; i < headers.length; i++) {
      allRequests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: COL_WIDTHS[semTypes[i]] },
          fields: 'pixelSize',
        },
      })
    }

    // Header row: per-column background tint + bold
    for (let i = 0; i < headers.length; i++) {
      const bg = HEADER_TINTS[semTypes[i]] ?? COLORS.tableHeaderBg
      allRequests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: {
            userEnteredFormat: { backgroundColor: bg, textFormat: { bold: true, fontSize: 10 } },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      })
    }

    // Row banding (data rows only — range starts at row index 1)
    allRequests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length },
          rowProperties: {
            firstBandColor: COLORS.white,
            secondBandColor: COLORS.surfaceBg, // neutral50 #f6f8fa
          },
        },
      },
    })

    // Conditional formatting for status/enum columns
    for (let i = 0; i < headers.length; i++) {
      if (semTypes[i] !== 'enum') continue
      const schema = getEffectiveSchema(properties?.[headers[i]])
      const enumVals = schema.enum ?? []
      const range = { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }
      for (const val of enumVals) {
        const lv = val.toLowerCase()
        let bg: { red: number; green: number; blue: number } | undefined
        if (STATUS_POSITIVE.has(lv)) bg = { red: 0.843, green: 0.969, blue: 0.761 }  // success100 #d7f7c2
        else if (STATUS_NEGATIVE.has(lv)) bg = { red: 1.000, green: 0.906, blue: 0.949 }  // critical100 #ffe7f2
        else if (STATUS_WARNING.has(lv)) bg = { red: 0.988, green: 0.929, blue: 0.725 }  // attention100 #fcedb9
        if (!bg) continue
        allRequests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [range],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: val }] },
                format: { backgroundColor: bg },
              },
            },
            index: 0,
          },
        })
      }
    }

    // System column dimming: gray italic text on data rows
    for (let i = 0; i < headers.length; i++) {
      if (semTypes[i] !== 'system') continue
      allRequests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: {
            userEnteredFormat: { textFormat: { foregroundColor: COLORS.textSecondary, italic: true } },
          },
          fields: 'userEnteredFormat.textFormat',
        },
      })
    }
  }

  if (allRequests.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: allRequests } }),
      'applyDataSheetFormatting:format'
    )
  }

  // Dashboard deep-link companion columns (ARRAYFORMULA, written after the data columns).
  // Fetch grid column counts to expand sheets that don't have a spare column yet.
  const gridMetaRes = await withRetry(
    () =>
      sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,gridProperties(columnCount)))',
      }),
    'applyDataSheetFormatting:gridMeta'
  )
  const gridColCount = new Map<number, number>()
  for (const sheet of gridMetaRes.data.sheets ?? []) {
    const sid = sheet.properties?.sheetId
    const cols = sheet.properties?.gridProperties?.columnCount
    if (sid != null && cols != null) gridColCount.set(sid, cols)
  }

  const expandRequests: sheets_v4.Schema$Request[] = []
  const linkData: Array<{ range: string; values: string[][] }> = []
  for (const { streamName, sheetId, headers } of streams) {
    if (headers.length === 0) continue
    const dashPath = STRIPE_DASHBOARD_PATHS[streamName]
    if (!dashPath) continue
    const companionIdx = headers.length // 0-indexed: one past the last data column
    const currentCols = gridColCount.get(sheetId) ?? 0
    if (companionIdx >= currentCols) {
      expandRequests.push({
        appendDimension: { sheetId, dimension: 'COLUMNS', length: companionIdx - currentCols + 1 },
      })
    }
    linkData.push({
      range: `'${streamName}'!${colIndexToLetter(companionIdx)}1`,
      values: [
        [`=ARRAYFORMULA({"Open";IF(A2:A="","",HYPERLINK("https://dashboard.stripe.com/${dashPath}/"&A2:A,"Open ↗"))})`],
      ],
    })
  }
  if (expandRequests.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: expandRequests },
        }),
      'applyDataSheetFormatting:expandCols'
    )
  }
  if (linkData.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: linkData },
        }),
      'applyDataSheetFormatting:links'
    )
  }
}

/** Append rows to a named sheet tab. Values are stringified for Sheets. */
export async function appendRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  rows: unknown[][]
): Promise<{ startRow: number; endRow: number } | undefined> {
  if (rows.length === 0) return

  const res = await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    })
  )
  const updatedRange = res.data.updates?.updatedRange
  return updatedRange ? parseUpdatedRows(updatedRange) : undefined
}

/**
 * Update specific rows in a sheet by their 1-based row numbers.
 * Uses a single batchUpdate call for efficiency.
 */
export async function updateRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  updates: { rowNumber: number; values: string[] }[]
): Promise<void> {
  if (updates.length === 0) return

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map((update) => ({
          range: `'${sheetName}'!A${update.rowNumber}`,
          values: [update.values],
        })),
      },
    })
  )
}

/**
 * Permanently delete a spreadsheet file via the Drive API.
 * The Sheets API does not support deletion — Drive is required.
 */
export async function deleteSpreadsheet(
  drive: drive_v3.Drive,
  spreadsheetId: string
): Promise<void> {
  await withRetry(() => drive.files.delete({ fileId: spreadsheetId }))
}

/**
 * Pure: serialized primary key → 1-based sheet row number, from rows you've
 * already fetched. `headers` must be known. Prefer this over `buildRowMap`
 * when you also need the row data; avoids a second read.
 */
export function buildRowMapFromRows(
  allRows: unknown[][],
  headers: string[],
  primaryKey: string[][]
): Map<string, number> {
  const pkFields = primaryKey.map((path) => path[0])
  const pkIndices = pkFields.map((field) => headers.indexOf(field))
  if (pkIndices.some((i) => i === -1)) return new Map()

  // Skip header row (index 0), data starts at index 1
  const map = new Map<string, number>()
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] as string[]
    const data: Record<string, unknown> = {}
    for (let j = 0; j < pkFields.length; j++) {
      data[pkFields[j]] = row[pkIndices[j]] ?? ''
    }
    const rowKey = serializeRowKey(primaryKey, data)
    if (rowKey === '[""]' || rowKey === '[null]') continue
    map.set(rowKey, i + 1) // 1-based: row 1 = headers, so data row at index i → row i+1
  }
  return map
}

/**
 * Like `buildRowMapFromRows` but for a header-less leading-column slice.
 * Primary key fields must be the first columns. Row i → sheet row i + 2.
 */
export function buildRowMapFromPkColumns(
  pkRows: unknown[][],
  primaryKey: string[][]
): Map<string, number> {
  const pkFields = primaryKey.map((path) => path[0])
  const map = new Map<string, number>()
  for (let i = 0; i < pkRows.length; i++) {
    const row = pkRows[i] as string[]
    const data: Record<string, unknown> = {}
    for (let j = 0; j < pkFields.length; j++) {
      data[pkFields[j]] = row[j] ?? ''
    }
    const rowKey = serializeRowKey(primaryKey, data)
    if (rowKey === '[""]' || rowKey === '[null]') continue
    map.set(rowKey, i + 2)
  }
  return map
}

/**
 * Build a map from serialized primary key → 1-based row number by reading
 * existing sheet data and extracting only the primary key columns.
 *
 * `headers` must already be known (from `readHeaderRow` or first-record discovery).
 */
export async function buildRowMap(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headers: string[],
  primaryKey: string[][]
): Promise<Map<string, number>> {
  const allRows = await readSheet(sheets, spreadsheetId, sheetName)
  return buildRowMapFromRows(allRows, headers, primaryKey)
}

/** Read all values from a sheet tab. Used for verification in tests. */
export async function readSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<unknown[][]> {
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'`,
    })
  )
  return (res.data.values ?? []) as unknown[][]
}

function columnLetter(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

export interface BatchReadRequest {
  name: string
  /** Read only the first N columns starting at row 2 (header skipped). */
  columnCount?: number
}

/**
 * Read multiple sheet tabs in one `values.batchGet` call. Replaces N
 * parallel reads with 1 request and 1 read-quota unit — required for wide
 * catalogs (otherwise blows the 300/min read limit). Missing tabs map to
 * empty arrays so callers can always `.get()` safely.
 *
 * With `columnCount` set: response is a leading-column, header-less slice — use with
 * {@link buildRowMapFromPkColumns}. Without: whole tab — use with
 * {@link buildRowMapFromRows}.
 */
export async function batchReadSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  requests: Array<string | BatchReadRequest>
): Promise<Map<string, unknown[][]>> {
  const result = new Map<string, unknown[][]>()
  if (requests.length === 0) return result
  const normalized = requests.map((r) => (typeof r === 'string' ? { name: r } : r))
  const res = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: normalized.map((req) =>
        req.columnCount && req.columnCount > 0
          ? `'${req.name}'!A2:${columnLetter(req.columnCount - 1)}`
          : `'${req.name}'`
      ),
    })
  )
  const valueRanges = res.data.valueRanges ?? []
  for (let i = 0; i < normalized.length; i++) {
    const entry = valueRanges[i]
    const values = (entry?.values ?? []) as unknown[][]
    result.set(normalized[i].name, values)
  }
  return result
}

export interface StreamBatchOps {
  sheetId: number
  updates: { rowNumber: number; values: string[] }[]
  appends: string[][]
  existingRowCount: number
}

// `pasteData` column delimiter. Unit Separator (U+001F) — a control char
// that won't naturally appear in Stripe data. Row separator is always `\n`
// (not configurable), so any `\n`, `\r`, or U+001F inside cells must be
// sanitized or the paste parser misaligns columns.
export const PASTE_COL_DELIMITER = '\x1f'
const PASTE_SANITIZE_RE = /[\n\r\x1f]/g

function sanitizeForPaste(value: string): string {
  return value.replace(PASTE_SANITIZE_RE, ' ')
}

export function rowsToTsv(rows: string[][]): string {
  let out = ''
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      if (c > 0) out += PASTE_COL_DELIMITER
      out += sanitizeForPaste(row[c])
    }
    if (r < rows.length - 1) out += '\n'
  }
  return out
}

/**
 * Flush buffered updates + appends across all streams.
 *
 *   Phase 1  — parallel reads: gridProperties + per-stream row counts.
 *   Phase 3a — one batchUpdate with appendDimension requests (only if grids
 *              need to grow). Must precede data writes.
 *   Phase 3b — one batchUpdate with all pasteData requests. PASTE_VALUES +
 *              TSV is the cheapest wire payload (no formula eval, no
 *              cell-level parsing server-side).
 *
 * Returns per-stream 1-based `appendStartRow` for row_assignments.
 */
export async function applyBatch(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  opsByStream: Map<string, StreamBatchOps>
): Promise<Map<string, { appendStartRow: number }>> {
  const applyStart = Date.now()

  // ── Phase 1 (parallel reads) ────────────────────────────────────
  // gridProperties for every sheet + per-stream column-A row counts when
  // we don't already have them (streams that bypassed buildRowMap).
  type GridInfo = { rowCount: number; columnCount: number }
  const gridInfo = new Map<number, GridInfo>()
  const probes: Array<Promise<void>> = []

  probes.push(
    (async () => {
      const metaStart = Date.now()
      try {
        const res = await withRetry(
          () =>
            sheets.spreadsheets.get({
              spreadsheetId,
              fields: 'sheets(properties(sheetId,gridProperties))',
            }),
          'gridMetadata'
        )
        for (const s of res.data.sheets ?? []) {
          const id = s.properties?.sheetId
          const gp = s.properties?.gridProperties
          if (id != null && gp) {
            gridInfo.set(id, { rowCount: gp.rowCount ?? 1000, columnCount: gp.columnCount ?? 26 })
          }
        }
        log.debug({ sheets: gridInfo.size, durationMs: Date.now() - metaStart }, 'gridMetadata')
      } catch (err) {
        log.warn({ err, durationMs: Date.now() - metaStart }, 'gridMetadata failed')
      }
    })()
  )

  for (const [streamName, ops] of opsByStream) {
    if (ops.appends.length > 0 && ops.existingRowCount === 0) {
      probes.push(
        (async () => {
          const probeStart = Date.now()
          try {
            const res = await withRetry(
              () =>
                sheets.spreadsheets.values.get({
                  spreadsheetId,
                  range: `'${streamName}'!A:A`,
                  majorDimension: 'ROWS',
                }),
              `rowCountProbe(${streamName})`
            )
            ops.existingRowCount = (res.data.values ?? []).length
            log.debug(
              {
                streamName,
                rows: ops.existingRowCount,
                durationMs: Date.now() - probeStart,
              },
              'rowCountProbe'
            )
          } catch (err) {
            log.warn(
              { err, streamName, durationMs: Date.now() - probeStart },
              'rowCountProbe failed'
            )
          }
        })()
      )
    }
  }
  const phase1Start = Date.now()
  await Promise.all(probes)
  log.debug(
    { parallelCalls: probes.length, durationMs: Date.now() - phase1Start },
    'phase1 (reads) done'
  )

  // ── Phase 2 (build payloads) ────────────────────────────────────
  // `expansionRequests` run first (Phase 3a) — the grid must fit before
  // pasteData writes. `dataRequests` are all dispatched in one batchUpdate
  // (Phase 3b); each pasteData targets a distinct row range on its sheet.
  const appendStartRows = new Map<string, { appendStartRow: number }>()
  const expansionRequests: sheets_v4.Schema$Request[] = []
  const dataRequests: sheets_v4.Schema$Request[] = []
  const EXPAND_ROW_BUFFER = 1000

  // 2a) appendDimension — only for grids that don't already fit.
  const phase2aStart = Date.now()
  const projectedGridBySheet = new Map<number, { rowCount: number; columnCount: number }>()
  for (const [, ops] of opsByStream) {
    const maxUpdateRow = ops.updates.reduce((m, u) => Math.max(m, u.rowNumber), 0)
    const maxAppendRow = ops.appends.length > 0 ? ops.existingRowCount + ops.appends.length : 0
    const neededRows = Math.max(maxUpdateRow, maxAppendRow)

    const maxUpdateCol = ops.updates.reduce((m, u) => Math.max(m, u.values.length), 0)
    const maxAppendCol = ops.appends.reduce((m, row) => Math.max(m, row.length), 0)
    const neededCols = Math.max(maxUpdateCol, maxAppendCol)

    const current = gridInfo.get(ops.sheetId)
    if (!current) continue // metadata missing — best-effort; hope the grid fits

    if (neededRows > current.rowCount) {
      expansionRequests.push({
        appendDimension: {
          sheetId: ops.sheetId,
          dimension: 'ROWS',
          length: neededRows - current.rowCount + EXPAND_ROW_BUFFER,
        },
      })
    }
    if (neededCols > current.columnCount) {
      expansionRequests.push({
        appendDimension: {
          sheetId: ops.sheetId,
          dimension: 'COLUMNS',
          length: neededCols - current.columnCount,
        },
      })
    }
    // Track projected post-expansion grid so the cap check below sees column growth.
    if (neededRows > current.rowCount || neededCols > current.columnCount) {
      projectedGridBySheet.set(ops.sheetId, {
        rowCount: neededRows > current.rowCount ? neededRows + EXPAND_ROW_BUFFER : current.rowCount,
        columnCount: neededCols > current.columnCount ? neededCols : current.columnCount,
      })
    }
  }
  const expansionCount = expansionRequests.length
  log.debug(
    { expansions: expansionCount, durationMs: Date.now() - phase2aStart },
    'phase2a (expansions) planned'
  )

  // 2b) pasteData for contiguous update groups (one per group).
  const phase2bStart = Date.now()
  let updateGroupCount = 0
  let updateRowCount = 0
  let updateCellCount = 0
  let updateBytesEstimate = 0
  for (const [, ops] of opsByStream) {
    if (ops.updates.length === 0) continue
    const sortedUpdates = [...ops.updates].sort((a, b) => a.rowNumber - b.rowNumber)
    let groupStart = 0
    while (groupStart < sortedUpdates.length) {
      let groupEnd = groupStart
      while (
        groupEnd + 1 < sortedUpdates.length &&
        sortedUpdates[groupEnd + 1].rowNumber === sortedUpdates[groupEnd].rowNumber + 1
      ) {
        groupEnd++
      }
      const firstRow = sortedUpdates[groupStart].rowNumber
      const groupRows = sortedUpdates.slice(groupStart, groupEnd + 1).map((u) => {
        updateCellCount += u.values.length
        for (const v of u.values) updateBytesEstimate += v.length
        return u.values
      })
      dataRequests.push({
        pasteData: {
          coordinate: { sheetId: ops.sheetId, rowIndex: firstRow - 1, columnIndex: 0 },
          data: rowsToTsv(groupRows),
          delimiter: PASTE_COL_DELIMITER,
          type: 'PASTE_VALUES',
        },
      })
      updateGroupCount++
      updateRowCount += groupEnd - groupStart + 1
      groupStart = groupEnd + 1
    }
  }
  log.debug(
    {
      groups: updateGroupCount,
      rows: updateRowCount,
      cells: updateCellCount,
      bytes: updateBytesEstimate,
      durationMs: Date.now() - phase2bStart,
    },
    'phase2b (updates) planned'
  )

  // 2c) pasteData for appends — one request per stream.
  const phase2cStart = Date.now()
  let appendRowCount = 0
  let appendCellCount = 0
  let appendBytesEstimate = 0
  for (const [streamName, ops] of opsByStream) {
    if (ops.appends.length === 0) continue
    const startRow = ops.existingRowCount + 1
    for (const row of ops.appends) {
      appendCellCount += row.length
      for (const v of row) appendBytesEstimate += v.length
    }
    dataRequests.push({
      pasteData: {
        coordinate: { sheetId: ops.sheetId, rowIndex: startRow - 1, columnIndex: 0 },
        data: rowsToTsv(ops.appends),
        delimiter: PASTE_COL_DELIMITER,
        type: 'PASTE_VALUES',
      },
    })
    appendStartRows.set(streamName, { appendStartRow: startRow })
    appendRowCount += ops.appends.length
  }
  log.debug(
    {
      streams: appendStartRows.size,
      rows: appendRowCount,
      cells: appendCellCount,
      bytes: appendBytesEstimate,
      durationMs: Date.now() - phase2cStart,
    },
    'phase2c (appends) planned'
  )

  if (expansionRequests.length === 0 && dataRequests.length === 0) return appendStartRows

  const totalCells = updateCellCount + appendCellCount
  const totalBytesEstimate = updateBytesEstimate + appendBytesEstimate

  // Reject a batch that alone exceeds the per-spreadsheet cap — no grid state can save it.
  if (totalCells > MAX_CELLS_PER_SPREADSHEET) {
    throw new Error(
      `Google Sheets destination: refusing to flush ${totalCells.toLocaleString()} cells in a single batch (exceeds the ${MAX_CELLS_PER_SPREADSHEET.toLocaleString()}-cell-per-spreadsheet limit)`
    )
  }

  // Skip when gridInfo is empty (probe failed) and let the API respond.
  if (gridInfo.size > 0) {
    let currentGridCells = 0
    let projectedGridCells = 0
    for (const [sheetId, info] of gridInfo) {
      currentGridCells += info.rowCount * info.columnCount
      const p = projectedGridBySheet.get(sheetId) ?? info
      projectedGridCells += p.rowCount * p.columnCount
    }
    // max() catches both near-cap append and column expansion growing all rows.
    const worstCaseCells = Math.max(currentGridCells + appendCellCount, projectedGridCells)
    if (worstCaseCells > MAX_CELLS_PER_SPREADSHEET) {
      throw new Error(
        `Google Sheets destination: ${worstCaseCells.toLocaleString()} cells would exceed the ${MAX_CELLS_PER_SPREADSHEET.toLocaleString()}-cell-per-spreadsheet limit (current grid: ${currentGridCells.toLocaleString()}, projected grid: ${projectedGridCells.toLocaleString()}, append payload: ${appendCellCount.toLocaleString()})`
      )
    }
  }

  // ── Phase 3 (single batchUpdate: expansions first, then data writes) ──
  // Requests within a batchUpdate are applied in order, so appendDimension
  // runs before pasteData and the grid is guaranteed to fit.
  const allRequests = [...expansionRequests, ...dataRequests]
  if (allRequests.length === 0) return appendStartRows

  log.debug(
    {
      streams: opsByStream.size,
      totalRequests: allRequests.length,
      expansions: expansionCount,
      updateRows: updateRowCount,
      appendRows: appendRowCount,
      cells: totalCells,
      bytes: totalBytesEstimate,
    },
    'batchUpdate dispatching'
  )

  const httpStart = Date.now()
  try {
    const res = await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: allRequests },
        }),
      'batchUpdate'
    )
    log.debug(
      {
        status: res.status,
        requests: allRequests.length,
        cells: totalCells,
        replies: res.data.replies?.length ?? 0,
        wallClockMs: Date.now() - httpStart,
        applyBatchTotalMs: Date.now() - applyStart,
      },
      'batchUpdate OK'
    )
  } catch (err) {
    log.error(
      {
        err,
        totalRequests: allRequests.length,
        expansions: expansionCount,
        updateRows: updateRowCount,
        appendRows: appendRowCount,
        cells: totalCells,
        wallClockMs: Date.now() - httpStart,
        applyBatchTotalMs: Date.now() - applyStart,
      },
      'batchUpdate FAILED'
    )
    throw err
  }

  return appendStartRows
}
