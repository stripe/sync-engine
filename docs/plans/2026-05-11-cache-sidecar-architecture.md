# Cache Sidecar Architecture

**Status:** Prototype (working MVP)
**Date:** 2026-05-11
**Context:** Standalone sidecar for real-time UBB entitlement enforcement with optimistic writes

---

## TL;DR

- Standalone Node.js HTTP process (`apps/cache-sidecar`) sits between apps and Redis, providing sub-100ms entitlement checks by merging sync engine checkpoints with locally tracked usage events.
- Two Redis namespaces with strict ownership: `sync:*` (sync engine writes, sidecar reads) and `optimistic:*` (sidecar writes, apps never touch).
- Ships Metronome UBB-specific. Not general-purpose until a second use case proves the abstraction.

---

## Problem

Apps need real-time "can this customer do X?" answers for usage-based billing. The sync engine pipeline (source-metronome -> destination-redis) gives periodic balance snapshots, but:

1. **Staleness gap.** Checkpoints arrive every 30-60s. Customers can blow past limits between updates.
2. **No write path.** Apps emit usage events that affect balance immediately. Checkpoints don't reflect pending work.
3. **Complexity leaks.** If every app reads Redis and does its own optimistic math, you get N inconsistent implementations with different failure modes.

---

## Solution

A speculative balance cache with bounded staleness. The sidecar reads immutable checkpoints from the sync pipeline, accepts usage events from apps via HTTP, and computes a merged balance accounting for both. Reconciliation happens inline on each balance read — prunes events older than the checkpoint's processing window, recomputes the optimistic delta.

```
                         +------------------+
                         |   Metronome API  |
                         +--------+---------+
                                  |
                      (sync engine pipeline)
                                  |
                                  v
                         +--------+---------+
                         | destination-redis|
                         |   sync:* ns      |
                         +--------+---------+
                                  |
                        (sidecar reads on demand)
                                  |
                                  v
+----------+            +---------+----------+           +----------+
|  App A   |--HTTP----->|    cache-sidecar   |<--HTTP----|  App B   |
+----------+            |                    |           +----------+
                        | optimistic:* ns    |
                        | (own Redis writes) |
                        +--------------------+
```

Apps never touch Redis or Metronome directly. The sidecar is the single entitlement authority.

---

## Redis Schema (as implemented)

### `sync:*` namespace (owned by sync engine, read-only to sidecar)

| Key Pattern | Type | Value |
|-------------|------|-------|
| `sync:net_balance:{customer_id}:{credit_type_id}` | String (JSON) | `{ balance, customer_id, credit_type_id, _synced_at }` |

`_synced_at` is a unix timestamp (seconds) added by source-metronome when it polls getNetBalance.

### `optimistic:*` namespace (owned by sidecar, never touched by sync engine)

| Key Pattern | Type | Members |
|-------------|------|---------|
| `optimistic:pending:{customer_id}` | Sorted Set | score = timestamp (ms), member = JSON `{ event_id, event_type, estimated_cost, properties }` |

Design notes:
- Sorted sets give O(log N) range deletion during reconciliation.
- Member is deterministic by event_id — retries with same idempotency_key don't create duplicates.
- The sidecar NEVER writes to `sync:*`. The sync engine NEVER writes to `optimistic:*`.

---

## API Surface (as implemented)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/health` | Liveness + last checkpoint age |
| `GET` | `/v1/balance/:customer_id` | Speculative balance (inline reconciliation) |
| `POST` | `/v1/events` | Record pending usage event |

### `GET /v1/health`

```json
{ "ok": true, "redis": "connected", "last_checkpoint_age_ms": 12345 }
```

### `GET /v1/balance/:customer_id`

Performs inline reconciliation (prunes stale events), then returns merged balance.

```json
{
  "checkpoint_balance": 498.75,
  "optimistic_balance": 497.73,
  "pending_events": 3,
  "last_checkpoint_at": 1715000000,
  "confidence": "high"
}
```

Confidence: `high` < 30s stale, `medium` < 120s, `low` otherwise.

### `POST /v1/events`

Request:
```json
{ "customer_id": "cus_X", "event_type": "api_call", "properties": { "model": "gpt-4" }, "idempotency_key": "evt_Z" }
```

Response:
```json
{ "event_id": "evt_Z", "estimated_cost": 1, "optimistic_balance": 496.73, "pending_events": 4 }
```

Deduplication via `idempotency_key` — if already seen, returns `"duplicate": true` with current balance.

---

## Reconciliation (as implemented)

Reconciliation happens **inline on every GET /balance request**, not via a background loop.

Logic:
1. Read checkpoint for customer (from `sync:net_balance:{customer_id}:{credit_type_id}`)
2. Compute cutoff: `checkpoint._synced_at * 1000 - WATERMARK_BUFFER_MS`
3. `ZREMRANGEBYSCORE` to prune all pending events with timestamp <= cutoff
4. Sum remaining pending costs, subtract from checkpoint balance

`WATERMARK_BUFFER_MS` (default 10s) is a safety buffer accounting for Metronome processing lag — events within this window are kept even if they're older than the checkpoint, because we can't be sure Metronome has processed them yet.

### Known limitation

The current approach is time-based pruning with a fixed buffer. There is no way to know definitively which events are reflected in a given checkpoint value. See Reconciliation Strategies below for the full analysis.

---

## Reconciliation Strategies

**Core framing:** For paying customers, denying valid usage is WORSE than allowing brief overage. Overage is billable and self-corrects on the next checkpoint. Denial loses revenue and erodes trust. Exception: free-tier and fraud-prevention contexts need strict enforcement (never permissive).

**Background:** Event processing has variable lag and out-of-order delivery is real. External apps may send events the sidecar never sees.

### Comparison

| Strategy | Overage Risk (brief permissive) | False Denial Risk | Deploy Time | Requires Metronome? |
|----------|--------------------------------|-------------------|-------------|---------------------|
| Time-based pruning + TTL floor | Low, bounded by buffer+TTL tuning | Low in lenient mode; near-zero in strict | Days | No |
| Balance-delta pruning | Medium, on refunds/credits/external events | Medium, same non-monotonic scenarios | Days | No |
| Event confirmation | None | None | Weeks | No (uses existing API) |
| Watermark-based | None (strict mode) | None | Blocked | Yes (not shipped) |

### Time-based pruning with TTL floor

Merged strategy. Prune an event only when BOTH conditions hold: `event_timestamp < checkpoint._synced_at - buffer` AND `event_timestamp < now() - TTL`. The checkpoint is the primary signal -- it reflects Metronome's confirmed state, so we prune based on what Metronome has actually processed. The TTL is a safety net -- it bounds accumulation when the sync engine is down or checkpoints stop arriving.

- **Overage risk:** Low. Brief permissive window possible if buffer is too short relative to partition lag. Tunable per-customer.
- **False denial risk:** Low in lenient mode (short buffer, moderate TTL). Near-zero in strict mode (long TTL, conservative buffer) at the cost of pessimistic drift.
- **Right choice:** Default for paying customers (lenient). Also works for free-tier/fraud with conservative tuning (long TTL, short buffer, strict mode).
- **Deploy:** Days. No external dependencies. Current implementation uses the checkpoint-relative prune only (no TTL floor yet).

### Balance-delta pruning

Compare consecutive checkpoint values. The delta implies consumed credits. Remove oldest pending events summing to that delta.

- **Overage risk:** Medium. Breaks on refunds, credit grants, plan changes, or external event sources -- any non-monotonic balance movement.
- **False denial risk:** Medium. Same non-monotonic scenarios can cause under-pruning or over-pruning in either direction.
- **Right choice:** Single-source monotonic meters with no manual adjustments. Narrow use case.
- **Deploy:** Days. No external dependencies.

### Event confirmation (usage query)

Query Metronome's usage API to confirm specific events appear in aggregated usage before pruning. Deterministic: only prune what you can prove is processed.

- **Overage risk:** None.
- **False denial risk:** None.
- **Right choice:** High-value VIP customers where even brief pessimistic drift is unacceptable and API cost is justified.
- **Deploy:** Weeks. Requires usage API integration + rate limit management. No Metronome changes.

### Watermark-based

Metronome exposes `watermark_low` / `watermark_high` in balance responses. Prune events <= `watermark_low` (confirmed processed). Events between low and high are ambiguous.

- **Overage risk:** None in strict mode. Tiny in lenient mode (ambiguous-zone events).
- **False denial risk:** None.
- **Right choice:** Long-term production steady-state. Precise, minimal drift, no polling overhead.
- **Deploy:** Blocked. Watermark metadata in balance responses is pending vendor support. Once available, days to integrate.

---

## Pricing Strategy (as implemented)

Current MVP uses `FIXED_EVENT_COST` (default: 1). This is known to be inaccurate — real unit cost observed via Preview Events API is 0.01 (sub-cent per api_call).

See the main EP doc for the full pricing strategy comparison.

---

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `REDIS_URL` | `redis://localhost:56379` | Redis connection |
| `CHECKPOINT_PREFIX` | `sync:` | Key prefix for sync engine checkpoints |
| `OPTIMISTIC_PREFIX` | `optimistic:` | Key prefix for sidecar state |
| `CREDIT_TYPE_ID` | (required) | Metronome credit type to track |
| `PORT` | `4100` | HTTP server port |
| `WATERMARK_BUFFER_MS` | `10000` | Safety buffer for time-based pruning (ms) |
| `FIXED_EVENT_COST` | `1` | Cost deducted per event (known inaccurate, see pricing strategies) |

---

## Data Flow

End-to-end sequence (as implemented):

```
1. App emits event to Metronome (normal ingest path, unchanged)
2. App calls sidecar: POST /v1/events { customer_id, event_type, idempotency_key }
3. Sidecar estimates cost (fixed cost strategy)
4. Sidecar: ZADD optimistic:pending:{customer_id} <timestamp> <event_json>
5. Sidecar reads checkpoint + sums pending, returns optimistic balance
6. App calls: GET /v1/balance/{customer_id} -> inline reconciliation + fresh balance

   ... 30-60s pass ...

7. Sync engine polls Metronome getNetBalance API
8. destination-redis writes sync:net_balance:{cid}:{credit_type_id}
9. Next GET /balance reads fresh checkpoint, prunes stale events, returns reconciled balance
```

---

## What the prototype proves

- Optimistic balance converges to checkpoint value once pending events are reconciled
- Deduplication works via Redis sorted set (ZADD NX by event_id)
- Sync engine pipeline runs e2e with real Metronome data
- Sub-50ms response times on balance reads and event writes

---

## Gaps

1. **Pricing accuracy.** Fixed cost is 100x off from reality (1 vs 0.01). Need rate card sync or Preview API integration.
2. **Reconciliation accuracy.** Time-based buffer is a guess. No way to know which events a checkpoint reflects.
3. **No TTL floor.** If sync engine stops, pending events accumulate forever.
4. **Single credit type.** Config takes one CREDIT_TYPE_ID. Multi-credit-type customers need multiple instances or config changes.

---

## Open Questions

1. **Preview API latency budget.** Preview Events API exists but throughput constraints are TBD. If p99 > 200ms, do we block the POST /events caller or return immediately with cached/estimated price and reconcile later?
2. **Watermark availability.** Watermark metadata in balance responses is pending vendor support. If delayed, we stay on time-based pruning.
3. **Tier boundary pricing.** If a customer is near a tier edge, the price-per-unit changes. Where does tier config live?
4. **Multi-instance coordination.** If we run N sidecar instances, is Redis the coordination layer (idempotent writes by event_id), or do we need leader election?

---

## Non-Goals

- **Not a general-purpose optimistic cache framework.** Metronome UBB only. Extract generic patterns after second use case.
- **Not inside the sync engine protocol.** Sync engine is unidirectional (source -> destination). The sidecar is a separate process reading sync output.
- **Not a replacement for Metronome.** Sidecar provides speculative answers between checkpoints. Metronome remains source of truth.
- **Not handling billing or invoicing.** We report balances and enforce limits. We don't compute invoices.
