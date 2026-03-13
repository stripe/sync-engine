import Stripe from 'stripe'
import pkg from '../package.json' with { type: 'json' }
import { managedWebhookSchema } from './schemas/managed_webhook'
import {
  type StripeSyncConfig,
  type ResourceConfig,
  SUPPORTED_WEBHOOK_EVENTS,
  RevalidateEntity,
} from './types'
import { PostgresClient } from './database/postgres'
import { getTableName, normalizeStripeObjectName } from './resourceRegistry'

export type StripeSyncWebhookDeps = {
  stripe: Stripe
  postgresClient: PostgresClient
  config: StripeSyncConfig
  readonly accountId: string
  getAccountId: (objectAccountId?: string) => Promise<string>
  upsertAny: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) => Promise<unknown[]>
  resourceRegistry: Record<string, ResourceConfig>
}

export class StripeSyncWebhook {
  private _allowedObjects: Set<string> | null = null

  constructor(private readonly deps: StripeSyncWebhookDeps) {}

  setObjectFilter(objects: string[] | null): void {
    this._allowedObjects = objects ? new Set(objects) : null
  }

  private get syncMetadataSchemaName(): string {
    return this.deps.config.syncTablesSchemaName ?? this.deps.config.schemaName ?? 'stripe'
  }

  private quoteSyncMetadataSchemaName(): string {
    return `"${this.syncMetadataSchemaName.replaceAll('"', '""')}"`
  }

  async processWebhook(payload: Buffer | Uint8Array | string, signature: string | undefined) {
    let webhookSecret: string | undefined = this.deps.config.stripeWebhookSecret

    if (!webhookSecret) {
      const schema = this.quoteSyncMetadataSchemaName()
      const result = await this.deps.postgresClient.query(
        `SELECT secret FROM ${schema}."_managed_webhooks" WHERE account_id = $1 LIMIT 1`,
        [this.deps.accountId]
      )

      if (result.rows.length > 0) {
        webhookSecret = result.rows[0].secret as string
      }
    }

    if (!webhookSecret) {
      throw new Error(
        'No webhook secret provided. Either create a managed webhook or configure stripeWebhookSecret.'
      )
    }

    if (!signature) {
      throw new Error('Missing stripe-signature header')
    }

    const constructEventAsync = this.deps.stripe.webhooks.constructEventAsync as (
      payload: string | Buffer | Uint8Array,
      signature: string,
      secret: string
    ) => Promise<Stripe.Event>

    const event = await constructEventAsync(payload, signature, webhookSecret)

    return this.processEvent(event)
  }

  async processEvent(event: Stripe.Event) {
    if (this._allowedObjects) {
      const objectType = (event.data?.object as { object?: string })?.object
      if (objectType && !this._allowedObjects.has(normalizeStripeObjectName(objectType))) {
        this.deps.config.logger?.info(
          `Skipping webhook ${event.id}: ${event.type} — object type "${objectType}" not in sync filter`
        )
        return
      }
    }

    const objectAccountId =
      event.data?.object && typeof event.data.object === 'object' && 'account' in event.data.object
        ? (event.data.object as { account?: string }).account
        : undefined
    const accountId = await this.deps.getAccountId(objectAccountId)

    // Skip events whose data.object lacks an id — these are preview/draft objects
    // (e.g. invoice.upcoming) that cannot be persisted due to NOT NULL constraint on id
    const dataObject = event.data?.object as { id?: string } | undefined
    if (dataObject && typeof dataObject === 'object' && !dataObject.id) {
      this.deps.config.logger?.info(
        `Skipping webhook ${event.id}: ${event.type} — data.object has no id (preview/draft object)`
      )
      return
    }
    await this.handleAnyEvent(event, accountId)
  }

  public getSupportedEventTypes(): Stripe.WebhookEndpointCreateParams.EnabledEvent[] {
    return [...SUPPORTED_WEBHOOK_EVENTS].sort()
  }

  async handleDeletedEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const objectType = normalizeStripeObjectName(event.data.object.object)
    const tableName = getTableName(objectType, this.deps.resourceRegistry)
    const softDelete = await this.deps.postgresClient.columnExists(tableName, 'deleted')
    const stripeObject = event.data.object as { id: string; object: string }
    if (softDelete) {
      const deletedObject = { ...stripeObject, deleted: true }
      await this.deps.upsertAny(
        [deletedObject],
        accountId,
        false,
        this.getSyncTimestamp(event, false)
      )
    } else {
      await this.deps.postgresClient.delete(tableName, stripeObject.id)
    }
  }

  async defaultHandler(event: Stripe.Event, accountId: string): Promise<void> {
    let stripeObject = event.data.object as { id: string; object: string }
    const objectType = normalizeStripeObjectName(stripeObject.object)
    const config = this.deps.resourceRegistry[objectType]
    if (!config || !config.retrieveFn) {
      throw new Error(`Unsupported object type for handleAnyEvent: ${objectType}`)
    }
    let refetched: boolean = false
    const shouldRevalidate = this.deps.config.revalidateObjectsViaStripeApi?.includes(
      objectType as RevalidateEntity
    )
    const isFinalState = config.isFinalState && config.isFinalState(stripeObject)
    if (!isFinalState && shouldRevalidate) {
      stripeObject = await config.retrieveFn(stripeObject.id)
      refetched = true
    }
    await this.deps.upsertAny(
      [stripeObject],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleEntitlementSummaryEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const summary = event.data.object as {
      customer: string
      entitlements: {
        data: Array<{
          id: string
          object: string
          feature: string | { id: string }
          livemode: boolean
          lookup_key: string
        }>
      }
    }
    const customerId = summary.customer
    const activeEntitlements = summary.entitlements.data.map((entitlement) => ({
      id: entitlement.id,
      object: entitlement.object,
      feature:
        typeof entitlement.feature === 'string' ? entitlement.feature : entitlement.feature.id,
      customer: customerId,
      livemode: entitlement.livemode,
      lookup_key: entitlement.lookup_key,
    }))

    await this.deps.postgresClient.deleteRemovedActiveEntitlements(
      customerId,
      activeEntitlements.map((e) => e.id)
    )
    if (activeEntitlements.length > 0) {
      await this.deps.upsertAny(
        activeEntitlements,
        accountId,
        false,
        this.getSyncTimestamp(event, false)
      )
    }
  }

  private static readonly RESOURCE_DELETE_EVENTS: ReadonlySet<string> = new Set([
    'customer.deleted',
    'product.deleted',
    'price.deleted',
    'plan.deleted',
    'invoice.deleted',
    'coupon.deleted',
    'customer.tax_id.deleted',
  ])

  private isDeleteEvent(event: Stripe.Event): boolean {
    if (
      'deleted' in event.data.object &&
      (event.data.object as { deleted?: boolean }).deleted === true
    ) {
      return true
    }
    return StripeSyncWebhook.RESOURCE_DELETE_EVENTS.has(event.type)
  }

  async handleAnyEvent(event: Stripe.Event, accountId: string): Promise<void> {
    if (event.type === 'entitlements.active_entitlement_summary.updated') {
      await this.handleEntitlementSummaryEvent(event, accountId)
    } else if (this.isDeleteEvent(event)) {
      await this.handleDeletedEvent(event, accountId)
    } else {
      await this.defaultHandler(event, accountId)
    }
  }

  getSyncTimestamp(event: Stripe.Event, refetched: boolean) {
    return refetched ? new Date().toISOString() : new Date(event.created * 1000).toISOString()
  }

  async findOrCreateManagedWebhook(
    url: string,
    params?: Omit<Stripe.WebhookEndpointCreateParams, 'url'>
  ): Promise<Stripe.WebhookEndpoint> {
    const webhookParams = {
      enabled_events: this.getSupportedEventTypes(),
      ...params,
    }
    const lockKey = `webhook:${this.deps.accountId}:${url}`

    return this.deps.postgresClient.withAdvisoryLock(lockKey, async () => {
      const existingWebhook = await this.getManagedWebhookByUrl(url)

      if (existingWebhook) {
        try {
          const stripeWebhook = await this.deps.stripe.webhookEndpoints.retrieve(existingWebhook.id)
          if (stripeWebhook.status === 'enabled') {
            return stripeWebhook
          }
          this.deps.config.logger?.info(
            { webhookId: existingWebhook.id },
            'Webhook is disabled, deleting and will recreate'
          )
          await this.deps.stripe.webhookEndpoints.del(existingWebhook.id)
          await this.deps.postgresClient.delete('_managed_webhooks', existingWebhook.id)
        } catch (error) {
          const stripeError = error as { statusCode?: number; code?: string }
          if (stripeError?.statusCode === 404 || stripeError?.code === 'resource_missing') {
            this.deps.config.logger?.warn(
              { error, webhookId: existingWebhook.id },
              'Webhook not found in Stripe (404), removing from database'
            )
            await this.deps.postgresClient.delete('_managed_webhooks', existingWebhook.id)
          } else {
            this.deps.config.logger?.error(
              { error, webhookId: existingWebhook.id },
              'Error retrieving webhook from Stripe, keeping in database'
            )
            throw error
          }
        }
      }

      const allDbWebhooks = await this.listManagedWebhooks()
      for (const dbWebhook of allDbWebhooks) {
        if (dbWebhook.url !== url) {
          this.deps.config.logger?.info(
            { webhookId: dbWebhook.id, oldUrl: dbWebhook.url, newUrl: url },
            'Webhook URL mismatch, deleting'
          )
          try {
            await this.deps.stripe.webhookEndpoints.del(dbWebhook.id)
          } catch (error) {
            this.deps.config.logger?.warn(
              { error, webhookId: dbWebhook.id },
              'Failed to delete old webhook from Stripe'
            )
          }
          await this.deps.postgresClient.delete('_managed_webhooks', dbWebhook.id)
        }
      }

      try {
        const stripeWebhooks = await this.deps.stripe.webhookEndpoints.list({ limit: 100 })

        for (const stripeWebhook of stripeWebhooks.data) {
          const isManagedByMetadata =
            stripeWebhook.metadata?.managed_by?.toLowerCase().replace(/[\s\-]+/g, '') ===
            'stripesync'
          const normalizedDescription =
            stripeWebhook.description?.toLowerCase().replace(/[\s\-]+/g, '') || ''
          const isManagedByDescription = normalizedDescription.includes('stripesync')

          if (isManagedByMetadata || isManagedByDescription) {
            const existsInDb = allDbWebhooks.some((dbWebhook) => dbWebhook.id === stripeWebhook.id)
            if (!existsInDb) {
              this.deps.config.logger?.warn(
                { webhookId: stripeWebhook.id, url: stripeWebhook.url },
                'Found orphaned managed webhook in Stripe, deleting'
              )
              await this.deps.stripe.webhookEndpoints.del(stripeWebhook.id)
            }
          }
        }
      } catch (error) {
        this.deps.config.logger?.warn({ error }, 'Failed to check for orphaned webhooks')
      }

      const webhook = await this.deps.stripe.webhookEndpoints.create({
        ...webhookParams,
        url,
        metadata: {
          ...webhookParams.metadata,
          managed_by: 'stripe-sync',
          version: pkg.version,
        },
      })

      await this.upsertManagedWebhooks([webhook], this.deps.accountId)
      return webhook
    })
  }

  async getManagedWebhook(id: string): Promise<Stripe.WebhookEndpoint | null> {
    const schema = this.quoteSyncMetadataSchemaName()
    const result = await this.deps.postgresClient.query(
      `SELECT * FROM ${schema}."_managed_webhooks" WHERE id = $1 AND "account_id" = $2`,
      [id, this.deps.accountId]
    )
    return result.rows.length > 0 ? (result.rows[0] as Stripe.WebhookEndpoint) : null
  }

  async getManagedWebhookByUrl(url: string): Promise<Stripe.WebhookEndpoint | null> {
    const schema = this.quoteSyncMetadataSchemaName()
    const result = await this.deps.postgresClient.query(
      `SELECT * FROM ${schema}."_managed_webhooks" WHERE url = $1 AND "account_id" = $2`,
      [url, this.deps.accountId]
    )
    return result.rows.length > 0 ? (result.rows[0] as Stripe.WebhookEndpoint) : null
  }

  async listManagedWebhooks(): Promise<Array<Stripe.WebhookEndpoint>> {
    const schema = this.quoteSyncMetadataSchemaName()
    const result = await this.deps.postgresClient.query(
      `SELECT * FROM ${schema}."_managed_webhooks" WHERE "account_id" = $1 ORDER BY created DESC`,
      [this.deps.accountId]
    )
    return result.rows as Array<Stripe.WebhookEndpoint>
  }

  async updateManagedWebhook(
    id: string,
    params: Stripe.WebhookEndpointUpdateParams
  ): Promise<Stripe.WebhookEndpoint> {
    const webhook = await this.deps.stripe.webhookEndpoints.update(id, params)
    await this.upsertManagedWebhooks([webhook], this.deps.accountId)
    return webhook
  }

  async deleteManagedWebhook(id: string): Promise<boolean> {
    await this.deps.stripe.webhookEndpoints.del(id)
    return this.deps.postgresClient.delete('_managed_webhooks', id)
  }

  async upsertManagedWebhooks(
    webhooks: Array<Stripe.WebhookEndpoint>,
    accountId: string,
    syncTimestamp?: string
  ): Promise<Array<Stripe.WebhookEndpoint>> {
    const filteredWebhooks = webhooks.map((webhook) => {
      const filtered: Record<string, unknown> = {}
      for (const prop of managedWebhookSchema.properties) {
        if (prop in webhook) {
          filtered[prop] = webhook[prop as keyof typeof webhook]
        }
      }
      return filtered
    })

    return this.deps.postgresClient.upsertManyWithTimestampProtection(
      filteredWebhooks as unknown as Array<Stripe.WebhookEndpoint>,
      '_managed_webhooks',
      accountId,
      syncTimestamp
    )
  }
}
