# API 契约（v1）

Base URL（本地）：`http://localhost:8787`；线上：Worker 域名。
所有返回都是 JSON。`order_id` 是 D1 里的订单主键。

## 通用规则

- 下单限流：同一指纹 10 次/分钟，超了返回 `429 { "error": "rate_limited" }`。
- 下单支持 `Idempotency-Key` 请求头：带同一个 key 重试，直接返回第一次的响应，不重复建单。
- Kill switch 开着时，下单返回 `503 { "error": "kill_switch_on" }`；
  bot 心跳断了超过 10 分钟，下单返回 `503 { "error": "bot_heartbeat_stale" }`。
- 管理接口统一用 `x-admin-token` 请求头鉴权（`ADMIN_TOKEN`）。

## 健康检查

```
GET /health
```

返回：

```json
{ "ok": true, "kill_switch": "off", "bot_heartbeat_stale": false }
```

## 下单

```
POST /v1/orders
Content-Type: application/json
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

{ "sku": "gift-50", "amount_cents": 5000, "currency": "usd",
  "stripe_payment_intent": "pi_xxx", "buyer_fingerprint": "fp_xxx" }
```

成功 `201`：

```json
{ "order_id": 12, "status": "pending" }
```

SKU 标价：`gift-10` 1000 分、`gift-25` 2500 分、`gift-50` 5000 分、`gift-100` 10000 分。
金额与标价不一致会加风控分，未知 SKU 返回 `400 { "error": "unknown_sku" }`。

## Stripe 回调

```
POST /webhooks/stripe
Stripe-Signature: t=...,v1=...
```

只处理 `payment_intent.succeeded`：先验签（HMAC-SHA256，`STRIPE_WEBHOOK_SECRET`，
时间戳超过 5 分钟拒掉），验签失败 `400 { "error": "bad_signature" }`。
验签通过后按 `stripe_payment_intent` 找到订单，分流：

| 分流 | 条件 | 结果 |
| --- | --- | --- |
| `auto` | 风控分 < 40 | 锁卡、发卡，订单 `fulfilled` |
| `hold` | 风控分 40–69 | 订单 `held`，等验证/人工 |
| `block` | 风控分 ≥ 70 | 直接退款，订单 `refunded` |

## Bot 任务

```
POST /v1/bot/tasks
Content-Type: application/json
```

异常单重试发卡（24 小时内 `paid` 未发的单，最多 20 单）：

```json
{ "type": "retry-fulfill", "limit": 20 }
```

返回：`{ "skipped": false, "results": [{ "order_id": 12, "fulfill": { "ok": true, "cardId": 88 } }] }`。
缺货时自动退款：`{ "order_id": 12, "fulfill": { "ok": false, "reason": "out_of_stock" }, "refund": { "ok": true } }`。
Kill switch 开着时整批跳过：`{ "skipped": true, "reason": "kill_switch_on", "results": [] }`。

夜间对账：

```json
{ "type": "reconcile" }
```

返回：`{ "checked": 41, "mismatches": [{ "type": "unfulfilled", "order_id": 12 }] }`。
差异类型：`missing_order`（Stripe 已收但 D1 没订单）、`amount_mismatch`（金额不一致）、
`unfulfilled`（Stripe 已收但 D1 没发卡）。

熔断检查：

```json
{ "type": "check-breaker" }
```

返回：`{ "tripped": false, "errorsLast10m": 1, "refundFailures": 0, "inventoryMismatch": 0 }`。

## Bot 心跳

```
POST /v1/bot/heartbeat
```

bot 每 5 分钟调一次。返回 `{ "ok": true }`。

## 管理接口

```
GET  /v1/admin/kill-switch
POST /v1/admin/kill-switch   { "value": "on" | "off", "reason": "..." }
GET  /v1/admin/holds
POST /v1/admin/fulfill       { "order_id": 12 }
POST /v1/admin/refund        { "order_id": 12, "reason": "requested_by_customer" }
```

恢复 kill switch 必须人工调这个接口，bot 自己不能恢复。
`GET /v1/admin/holds` 返回被扣住的单，最多 50 条，按时间倒序。
