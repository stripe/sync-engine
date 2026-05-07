const noop = () => {}

function createChild() {
  return logger
}

const logger: any = {
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  fatal: console.error.bind(console),
  trace: console.debug.bind(console),
  child: createChild,
  level: 'debug',
  silent: noop,
  isLevelEnabled: () => true,
}

export const log = logger
export type Logger = typeof logger
export type DestinationStream = any
export type LoggerOptions = any
export type RoutedLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type RoutedLogEntry = { level: RoutedLogLevel; message: string }
export type LoggerContext = { name?: string; sync_engine_request_id?: string | null }

export const destination = () => ({})
export function getLoggerContext() { return undefined }
export function getEngineRequestId() { return null }
export function runWithLogContext<T>(_patch: unknown, fn: () => T): T { return fn() }
export function withoutLogCapture<T>(fn: () => T): T { return fn() }
export function bindLogContext<T>(_patch: unknown, fn: (...args: any[]) => T) { return fn }
export function createAsyncQueue<T>() {
  const items: T[] = []
  return {
    push: (item: T) => { items.push(item) },
    wait: async () => items.shift(),
    [Symbol.asyncIterator]: async function* () { while (true) yield await new Promise<T>(noop) },
  }
}
export function createLogger() { return logger }
export default logger
