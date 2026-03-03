import dotenv from 'dotenv'
import inquirer from 'inquirer'
import chalk from 'chalk'

export type ListenMode = 'websocket' | 'webhook' | 'disabled'

export interface Config {
  stripeApiKey: string
  ngrokAuthToken?: string // Optional - if not provided, use WebSocket mode
  databaseUrl: string
  enableSigma?: boolean
}

export interface CliOptions {
  stripeKey?: string
  ngrokToken?: string
  databaseUrl?: string
  enableSigma?: boolean
  interval?: number
  workerCount?: number
  rateLimit?: number
  listenMode?: ListenMode
  listenOnly?: boolean
}

/**
 * Load configuration from .env file, environment variables, and interactive prompts.
 * Values are masked with *** when prompting for sensitive information.
 */
export async function loadConfig(options: CliOptions): Promise<Config> {
  // Load .env file
  dotenv.config()

  const config: Partial<Config> = {}

  // Get Stripe API key
  config.stripeApiKey = options.stripeKey || process.env.STRIPE_API_KEY || ''

  // Get ngrok auth token
  config.ngrokAuthToken = options.ngrokToken || process.env.NGROK_AUTH_TOKEN || ''

  // Get database URL
  config.databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

  // Get Sigma sync option
  config.enableSigma = options.enableSigma ?? false

  // Prompt for missing required values
  const questions = []

  if (!config.stripeApiKey) {
    questions.push({
      type: 'password',
      name: 'stripeApiKey',
      message: 'Enter your Stripe API key:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.trim() === '') {
          return 'Stripe API key is required'
        }
        if (!input.startsWith('sk_') && !input.startsWith('rk_')) {
          return 'Stripe API key should start with "sk_" or "rk_"'
        }
        return true
      },
    })
  }

  // ngrok auth token is optional - if not provided, WebSocket mode will be used
  // No prompt needed

  if (!config.databaseUrl) {
    questions.push({
      type: 'password',
      name: 'databaseUrl',
      message: 'Enter your Postgres DATABASE_URL:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.trim() === '') {
          return 'DATABASE_URL is required'
        }
        if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
          return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
        }
        return true
      },
    })
  }

  if (questions.length > 0) {
    console.log(chalk.yellow('\nMissing configuration. Please provide:'))
    const answers = await inquirer.prompt(questions)
    Object.assign(config, answers)
  }

  // Default to false if not set
  if (config.enableSigma === undefined) {
    config.enableSigma = false
  }

  return config as Config
}
