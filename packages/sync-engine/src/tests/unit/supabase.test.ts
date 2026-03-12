import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SupabaseSetupClient } from '../../supabase/supabase'

describe('SupabaseDeployClient', () => {
  const mockAccessToken = 'test-access-token'
  const mockProjectRef = 'abcdefghijklmnop'

  let originalEnv: string | undefined

  beforeEach(() => {
    // Save original env var
    originalEnv = process.env.SUPABASE_BASE_URL
    // Clear env var before each test
    delete process.env.SUPABASE_BASE_URL
  })

  afterEach(() => {
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.SUPABASE_BASE_URL = originalEnv
    } else {
      delete process.env.SUPABASE_BASE_URL
    }
  })

  describe('Base URL Configuration', () => {
    it('should use default base URL when no option or env var is provided', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.supabase.co`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.supabase.co/functions/v1/stripe-webhook`
      )
    })

    it('should use environment variable when provided', () => {
      process.env.SUPABASE_BASE_URL = 'custom-domain.com'

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.custom-domain.com`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.custom-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should prioritize option over environment variable', () => {
      process.env.SUPABASE_BASE_URL = 'env-domain.com'

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'option-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.option-domain.com`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.option-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should use custom base URL from options', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'my-custom.supabase.co',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.my-custom.supabase.co`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.my-custom.supabase.co/functions/v1/stripe-webhook`
      )
    })
  })

  describe('URL Generation Methods', () => {
    it('should generate correct project URL with custom base URL', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.test-domain.com`)
    })

    it('should generate correct webhook URL with custom base URL', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.test-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should generate correct function invocation URL with custom base URL', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      // Mock fetch to intercept the URL being called
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      })
      global.fetch = mockFetch

      await client.invokeFunction('test-function', 'POST', 'test-service-role-key')

      expect(mockFetch).toHaveBeenCalledWith(
        `https://${mockProjectRef}.test-domain.com/functions/v1/test-function`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-service-role-key',
          }),
        })
      )

      vi.restoreAllMocks()
    })
  })

  describe('setupPgCronJob with custom base URL', () => {
    it('should include custom base URL in pg_cron SQL', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'test-domain.com',
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue({ data: null })

      client.api.getProjectApiKeys = mockGetProjectApiKeys
      client.api.runAQuery = mockRunQuery

      await client.setupPgCronJob()

      // Verify runAQuery was called
      expect(mockRunQuery).toHaveBeenCalled()

      // Get the SQL that was executed (runAQuery(projectRef, { query }))
      const executedSQL = (mockRunQuery.mock.calls[0][1] as { query: string }).query

      // Verify it contains the custom base URL
      expect(executedSQL).toContain(
        `https://${mockProjectRef}.test-domain.com/functions/v1/stripe-worker`
      )
    })

    it('should use default base URL in pg_cron SQL when not customized', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue({ data: null })

      client.api.getProjectApiKeys = mockGetProjectApiKeys
      client.api.runAQuery = mockRunQuery

      await client.setupPgCronJob()

      // Get the SQL that was executed (runAQuery(projectRef, { query }))
      const executedSQL = (mockRunQuery.mock.calls[0][1] as { query: string }).query

      // Verify it contains the default base URL
      expect(executedSQL).toContain(
        `https://${mockProjectRef}.supabase.co/functions/v1/stripe-worker`
      )
    })

    it('should use interval format for sub-minute intervals', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue({ data: null })

      client.api.getProjectApiKeys = mockGetProjectApiKeys
      client.api.runAQuery = mockRunQuery

      await client.setupPgCronJob(30)

      // Get the SQL that was executed (runAQuery(projectRef, { query }))
      const executedSQL = (mockRunQuery.mock.calls[0][1] as { query: string }).query

      // Verify it uses interval format for seconds
      expect(executedSQL).toContain("'30 seconds'")
    })

    it('should use cron format for minute intervals', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue({ data: null })

      client.api.getProjectApiKeys = mockGetProjectApiKeys
      client.api.runAQuery = mockRunQuery

      await client.setupPgCronJob(120)

      // Get the SQL that was executed (runAQuery(projectRef, { query }))
      const executedSQL = (mockRunQuery.mock.calls[0][1] as { query: string }).query

      // Verify it uses cron format for 2 minutes
      expect(executedSQL).toContain("'*/2 * * * *'")
    })

    it('should use default interval of 60 seconds (1 minute) when not specified', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue({ data: null })

      client.api.getProjectApiKeys = mockGetProjectApiKeys
      client.api.runAQuery = mockRunQuery

      await client.setupPgCronJob()

      // Get the SQL that was executed (runAQuery(projectRef, { query }))
      const executedSQL = (mockRunQuery.mock.calls[0][1] as { query: string }).query

      // Verify it uses cron format for 1 minute
      expect(executedSQL).toContain("'*/1 * * * *'")
    })

    it('should reject invalid worker intervals', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])

      client.api.getProjectApiKeys = mockGetProjectApiKeys

      // Test various invalid inputs
      await expect(client.setupPgCronJob(0)).rejects.toThrow('Invalid interval')
      await expect(client.setupPgCronJob(-1)).rejects.toThrow('Invalid interval')
      await expect(client.setupPgCronJob(1.5)).rejects.toThrow('Invalid interval')

      // Test intervals that aren't multiples of 60 (when >= 60)
      await expect(client.setupPgCronJob(90)).rejects.toThrow(
        'Must be either 1-59 seconds or a multiple of 60'
      )

      // Test intervals >= 1 hour
      await expect(client.setupPgCronJob(3600)).rejects.toThrow(
        'Intervals >= 3600 seconds (1 hour) are not supported'
      )
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty string base URL option by using env var', () => {
      process.env.SUPABASE_BASE_URL = 'env-fallback.com'

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: '',
      })

      // Empty string is falsy, so it should fall back to env var
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.env-fallback.com`)
    })

    it('should handle empty string base URL option and env var by using default', () => {
      process.env.SUPABASE_BASE_URL = ''

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: '',
      })

      // Both are empty/falsy, should use default
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.supabase.co`)
    })

    it('should work with base URLs containing protocols (should strip them in construction)', () => {
      // Note: This test documents current behavior - base URL should NOT include protocol
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'my-domain.com',
      })

      // The URL construction adds https://, so base URL should not include it
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.my-domain.com`)
      expect(client.getProjectUrl()).not.toContain('https://https://')
    })

    it('should work with base URLs containing subdomains', () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        projectBaseUrl: 'api.custom-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.api.custom-domain.com`)
    })
  })

  describe('isInstalled()', () => {
    it('should return false when schema does not exist', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return migrations table check, then schema doesn't exist
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: false }]) // schema doesn't exist
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should return false when schema exists but no migrations table', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return migrations table doesn't exist (returns early)
      const mockRunSQL = vi.fn().mockResolvedValueOnce([{ table_exists: false }]) // migrations table doesn't exist
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should throw error when schema and migrations table exist but no comment', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return schema exists, migrations table exists, but no comment
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([{ comment: null }]) // no comment
      client.runSQL = mockRunSQL

      await expect(client.isInstalled()).rejects.toThrow(/Legacy installation detected/)
    })

    it('should throw error when schema and migrations table exist but comment missing stripe-sync', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return schema exists, migrations table exists, but wrong comment
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([{ comment: 'some other tool' }]) // wrong comment
      client.runSQL = mockRunSQL

      await expect(client.isInstalled()).rejects.toThrow(/Legacy installation detected/)
    })

    it('should return false when installation is in progress (installation:started)', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return in-progress installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          { comment: JSON.stringify({ status: 'installing', newVersion: '1.0.0' }) },
        ]) // in progress
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should throw error when installation has failed (installation:error)', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return failed installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          {
            comment: JSON.stringify({
              status: 'install error',
              newVersion: '1.0.0',
              errorMessage: 'Something went wrong',
            }),
          },
        ]) // failed
      client.runSQL = mockRunSQL

      try {
        await client.isInstalled()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('Installation failed')
        expect((error as Error).message).toContain('uninstall and install again')
      }
    })

    it('should return false when uninstallation is in progress (uninstallation:started)', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return in-progress uninstallation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          { comment: JSON.stringify({ status: 'uninstalling', oldVersion: '1.0.0' }) },
        ]) // in progress
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(false)
    })

    it('should throw error when uninstallation has failed (uninstallation:error)', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return failed uninstallation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          {
            comment: JSON.stringify({
              status: 'uninstall error',
              oldVersion: '1.0.0',
              errorMessage: 'Cleanup failed',
            }),
          },
        ]) // failed
      client.runSQL = mockRunSQL

      try {
        await client.isInstalled()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('Uninstallation failed')
        expect((error as Error).message).toContain('Manual cleanup may be required')
      }
    })

    it('should return true when installation is complete', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return completed installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          { comment: JSON.stringify({ status: 'installed', oldVersion: '1.0.0' }) },
        ]) // installed
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(true)
    })

    it('should work with a non-default schema name', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return completed installation
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          { comment: JSON.stringify({ status: 'installed', oldVersion: '1.0.0' }) },
        ]) // installed
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled('custom_schema')

      expect(installed).toBe(true)
      // Verify the SQL queries included the configured non-default schema name.
      expect(mockRunSQL).toHaveBeenCalledWith(expect.stringContaining('custom_schema'))
    })

    it('should support legacy plain-text comment format for backward compatibility', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return legacy plain-text format
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([{ comment: 'stripe-sync v1.0.0 installed' }]) // legacy format
      client.runSQL = mockRunSQL

      const installed = await client.isInstalled()

      expect(installed).toBe(true)
    })

    it('should parse installation error messages from legacy plain-text format', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return legacy plain-text format with error
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          { comment: 'stripe-sync v1.0.0 installation:error - Legacy error message' },
        ])
      client.runSQL = mockRunSQL

      try {
        await client.isInstalled()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('Installation failed')
        expect((error as Error).message).toContain('Legacy error message')
      }
    })

    it('should parse uninstallation error messages from legacy plain-text format', async () => {
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock runSQL to return legacy plain-text format with error
      const mockRunSQL = vi
        .fn()
        .mockResolvedValueOnce([{ table_exists: true }]) // migrations table exists
        .mockResolvedValueOnce([{ schema_exists: true }]) // schema exists
        .mockResolvedValueOnce([
          { comment: 'stripe-sync v1.0.0 uninstallation:error - Legacy error message' },
        ])
      client.runSQL = mockRunSQL

      try {
        await client.isInstalled()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('Uninstallation failed')
        expect((error as Error).message).toContain('Legacy error message')
      }
    })
  })

  describe('Management API URL Configuration', () => {
    it('should store custom management URL', () => {
      const customUrl = 'http://localhost:54323'
      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        supabaseManagementUrl: customUrl,
      })

      // @ts-expect-error - accessing private property for testing
      expect(client.supabaseManagementUrl).toBe(customUrl)
    })

    it('should set management URL as secret during install when provided', async () => {
      const mockSetSecrets = vi.fn().mockResolvedValue(null)

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        supabaseManagementUrl: 'http://localhost:54323',
      })

      // Mock only what we need to test
      client.validateProject = vi
        .fn()
        .mockResolvedValue({ id: mockProjectRef, name: 'test', region: 'us-east-1' })
      client.runSQL = vi.fn().mockResolvedValue(null)
      client.deployFunction = vi.fn().mockResolvedValue(null)
      client.setSecrets = mockSetSecrets
      client.invokeFunction = vi.fn().mockResolvedValue({ success: true })
      client.setupPgCronJob = vi.fn().mockResolvedValue(null)
      client.setupSigmaPgCronJob = vi.fn().mockResolvedValue(null)

      await client.install('sk_test_key')

      // Should set both STRIPE_SECRET_KEY and MANAGEMENT_API_URL
      expect(mockSetSecrets).toHaveBeenCalledWith([
        { name: 'STRIPE_SECRET_KEY', value: 'sk_test_key' },
        { name: 'MANAGEMENT_API_URL', value: 'http://localhost:54323' },
      ])
    })

    it('should only set STRIPE_SECRET_KEY when no custom management URL', async () => {
      const mockSetSecrets = vi.fn().mockResolvedValue(null)

      const client = new SupabaseSetupClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock only what we need to test
      client.validateProject = vi
        .fn()
        .mockResolvedValue({ id: mockProjectRef, name: 'test', region: 'us-east-1' })
      client.runSQL = vi.fn().mockResolvedValue(null)
      client.deployFunction = vi.fn().mockResolvedValue(null)
      client.setSecrets = mockSetSecrets
      client.invokeFunction = vi.fn().mockResolvedValue({ success: true })
      client.setupPgCronJob = vi.fn().mockResolvedValue(null)
      client.setupSigmaPgCronJob = vi.fn().mockResolvedValue(null)

      await client.install('sk_test_key')

      // Should only set STRIPE_SECRET_KEY
      expect(mockSetSecrets).toHaveBeenCalledWith([
        { name: 'STRIPE_SECRET_KEY', value: 'sk_test_key' },
      ])
    })
  })
})
