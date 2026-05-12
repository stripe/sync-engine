export interface ResourceDefinition {
  /** Stream/table name */
  name: string
  /** API endpoint path */
  endpoint: string
  /** HTTP method */
  method: 'GET' | 'POST'
  /** JSON Schema for the record shape */
  jsonSchema: Record<string, unknown>
  /** Primary key field paths */
  primaryKey: string[][]
  /** If true, requires iterating parent customers first */
  perCustomer?: boolean
  /** If true, requires iterating parent customers AND their contracts */
  perContract?: boolean
  /** If true, endpoint returns a single object (not a paginated list) */
  singleObject?: boolean
  /** If true, do not send `limit` in pagination requests */
  skipLimit?: boolean
}

export const resources: ResourceDefinition[] = [
  {
    name: 'customers',
    endpoint: '/v1/customers',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        external_id: { type: 'string' },
        ingest_aliases: { type: 'array', items: { type: 'string' } },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
        archived_at: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'billable_metrics',
    endpoint: '/v1/billable-metrics',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        group_keys: { type: 'array' },
        aggregation_type: { type: 'string' },
        aggregation_key: { type: ['string', 'null'] },
        event_type_filter: { type: 'object' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'plans',
    endpoint: '/v1/plans',
    method: 'GET',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'contracts',
    endpoint: '/v2/contracts/list',
    method: 'POST',
    primaryKey: [['id']],
    perCustomer: true,
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customer_id: { type: 'string' },
        rate_card_id: { type: ['string', 'null'] },
        starting_at: { type: 'string' },
        ending_before: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'products',
    endpoint: '/v1/contract-pricing/products/list',
    method: 'POST',
    primaryKey: [['id']],
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'rate_cards',
    endpoint: '/v1/contract-pricing/rate-cards/list',
    method: 'POST',
    primaryKey: [['id']],
    skipLimit: true,
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        custom_fields: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'net_balance',
    endpoint: '/v1/contracts/customerBalances/getNetBalance',
    method: 'POST',
    primaryKey: [['customer_id'], ['credit_type_id']],
    perCustomer: true,
    singleObject: true,
    jsonSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        balance: { type: 'number' },
        credit_type_id: { type: 'string' },
        _synced_at: { type: 'integer' },
      },
    },
  },
  {
    name: 'entitlements',
    endpoint: '/v1/contracts/getContractRateSchedule',
    method: 'POST',
    primaryKey: [['customer_id'], ['contract_id'], ['product_id']],
    perContract: true,
    jsonSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        contract_id: { type: 'string' },
        product_id: { type: 'string' },
        product_name: { type: 'string' },
        product_tags: { type: 'array', items: { type: 'string' } },
        product_custom_fields: { type: 'object' },
        rate_card_id: { type: 'string' },
        entitled: { type: 'boolean' },
        starting_at: { type: 'string' },
        ending_before: { type: ['string', 'null'] },
        list_rate: { type: 'object' },
        override_rate: { type: 'object' },
        _synced_at: { type: 'integer' },
      },
    },
  },
]
