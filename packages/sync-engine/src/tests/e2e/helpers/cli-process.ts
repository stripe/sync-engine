/**
 * CLI background process manager for integration tests
 * Manages starting/stopping the sync engine CLI
 */
import { spawn, execSync, ChildProcess } from 'child_process'
import * as fs from 'fs'
import { waitFor, sleep } from '../../testSetup'

export class CliProcess {
  private process: ChildProcess | null = null
  private logFile: string
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
    this.logFile = `/tmp/cli-test-${Date.now()}.log`
  }

  async start(env: Record<string, string> = {}): Promise<void> {
    const logStream = fs.createWriteStream(this.logFile)

    this.process = spawn(
      'node',
      ['dist/cli/index.js', 'sync', 'all', '--listen-mode', 'websocket', '--listen-only'],
      {
        cwd: this.cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    )

    this.process.stdout?.pipe(logStream)
    this.process.stderr?.pipe(logStream)

    await waitFor(() => this.isRunning() && this.getLogs().length > 0, 30000, {
      intervalMs: 1000,
      message: `CLI failed to start. Logs:\n${this.getLogs()}`,
    })
  }

  isRunning(): boolean {
    if (!this.process) return false
    try {
      process.kill(this.process.pid!, 0)
      return true
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    if (this.process && this.isRunning()) {
      this.process.kill('SIGTERM')
      await sleep(2000)
    }
    this.process = null
  }

  getLogs(): string {
    try {
      return fs.readFileSync(this.logFile, 'utf-8')
    } catch {
      return ''
    }
  }

  getLogFile(): string {
    return this.logFile
  }
}

export function runCliCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: Record<string, string>
    timeout?: number
  }
): string {
  const { cwd, env = {}, timeout = 120000 } = options
  const fullCommand = `node dist/cli/index.js ${command} ${args.join(' ')}`

  const result = execSync(fullCommand, {
    cwd,
    env: { ...process.env, ...env },
    timeout,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return result
}

export function buildCli(cwd: string): void {
  execSync('npm run build', { cwd, stdio: 'pipe' })
}
