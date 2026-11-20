# 架构

## 一句话

店面下单 → Stripe 收款 → webhook 回调 → Worker 锁卡发卡；Devin Bot 只处理异常和对账；任何环节出错都有 kill switch 兜底，只进不出。

## 模块

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `src/index.js` | 路由 + 定时任务入口 | 全部模块 |
| `src/util.js` | JSON 响应、config 读写、审计日志、kill switch 状态 | D1 |
| `src/fulfill.js` | 锁卡、发卡、退款（真正改卡状态的地方） | `util.js`、`stripe.js` |
| `src/stripe.js` | 回调验签、退款、查流水 | Stripe API |
| `src/risk.js` | 风控打分、分流阈值、熔断条件（纯函数，可单测） | 无 |
| `src/bot.js` | 指纹画像、分流、异常单重试、熔断检查 | `risk.js`、`fulfill.js`、`reconcile.js` |
| `src/reconcile.js` | 夜间对账：Stripe 流水 vs D1 订单 | `stripe.js` |
| `src/ratelimit.js` | 下单限流（D1 计数，60 秒窗口） | D1 |
| `src/idempotency.js` | 幂等键，响应缓存 24 小时 | D1 |
| `src/admin.js` | kill switch、held 队列、人工发卡/退款 | `fulfill.js` |

## 数据流

```
买家 → POST /v1/orders → pending 订单（限流 + 幂等 + 熔断检查）
  → Stripe PaymentIntent → 付款
  → POST /webhooks/stripe（验签）→ 分流 auto/hold/block
  → auto：锁卡 → 发卡 → fulfilled
  → hold：扣单，等验证/人工
  → block：直接退款
```

## Bot 在哪里

- `POST /v1/bot/tasks`：`retry-fulfill`（重发失败的单）、`reconcile`（对账）、`check-breaker`（熔断检查）。
- `POST /v1/bot/heartbeat`：每 5 分钟报一次到。
- 定时任务每天 02:00 UTC：对账 + 清限流表 + 熔断检查（见 `wrangler.toml` 的 `[triggers]`）。
- Bot 只处理它标出来的单，不碰正常订单。

## 失败模式

| 故障 | 表现 | 兜底 |
| --- | --- | --- |
| Stripe 回调丢了 | 订单停在 pending | bot 重试任务按 `stripe_payment_intent` 补查，见 ops-runbook |
| 库存没了 | 发卡返回 `out_of_stock` | bot 自动退款，订单改 refunded |
| Bot 挂了 | 心跳断了超过 10 分钟 | 下单接口 503，店面挂维护页 |
| 退款失败 | audit 记 `refund_failed` | 熔断计数 +1，2 次就跳闸 |
| Kill switch 跳闸 | 只进不出 | 恢复必须人工点 `POST /v1/admin/kill-switch` |

## 为什么不用队列

量还小，D1 + 定时任务够用。订单量上来之后把 `retry-fulfill` 换成 Cloudflare Queues，
接口不变，bot 任务改成消费队列。
