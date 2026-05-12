export interface PricingStrategy {
  estimateCost(eventType: string, properties?: Record<string, unknown>): number
}

/**
 * Fixed-cost pricing: every event costs the same amount of credits.
 * Good enough for MVP — swap in a lookup-based strategy later.
 */
export class FixedCostPricing implements PricingStrategy {
  constructor(private readonly cost: number) {}

  estimateCost(_eventType: string, _properties?: Record<string, unknown>): number {
    return this.cost
  }
}
