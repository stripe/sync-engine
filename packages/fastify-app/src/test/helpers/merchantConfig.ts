export const TEST_PRIMARY_MERCHANT_HOST = 'merchant-a.local'
export const TEST_SECONDARY_MERCHANT_HOST = 'merchant-b.local'

export function ensureTestMerchantConfig(): void {
  if (process.env.MERCHANT_CONFIG_JSON) return

  process.env.STRIPE_ACCOUNT_ID = process.env.STRIPE_ACCOUNT_ID || 'acct_test_account'

  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable&search_path=stripe'
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? 'sk_test_merchant'

  process.env.MERCHANT_CONFIG_JSON = JSON.stringify({
    [TEST_PRIMARY_MERCHANT_HOST]: {
      databaseUrl,
      stripeSecretKey,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_merchant_a',
    },
    [TEST_SECONDARY_MERCHANT_HOST]: {
      databaseUrl,
      stripeSecretKey,
      stripeWebhookSecret: 'whsec_test_merchant_b',
    },
  })
}
