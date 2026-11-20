# SLO 与 error budget

## SLO

| 指标 | 目标 | 窗口 |
| --- | --- | --- |
| 付款到发卡成功率（paid → fulfilled） | ≥ 99.5% | 30 天滚动 |
| 下单接口可用性（非 5xx 比例） | ≥ 99.9% | 30 天滚动 |
| Webhook 处理 p99 | < 2 秒 | 30 天滚动 |
| 对账差异 | 0 | 每天 |

成功率只算 Stripe 已收款的单：`paid` 之后 5 分钟内没变成 `fulfilled` 就算失败，
包括缺货自动退款的单（缺货是库存问题，不是发卡问题，但一样算进失败里，逼着补库存）。

## Error budget

- 成功率 99.5% 对应 30 天里允许 0.5% 的单失败。量小的时候按单数算，不按百分比硬套。
- budget 烧完：停新功能，只修 reliability 的东西，直到 budget 恢复。
- budget 没烧完：正常迭代。

## 怎么量

- 成功率：每天对账任务（`POST /v1/bot/tasks {"type":"reconcile"}`）顺带统计，
  结果写进 `audit_log`（`action='nightly_reconcile'`）。
- 可用性：`GET /health` + 下单接口的 5xx 比例。
- 对账差异：`mismatches` 非空就当天处理，不隔夜。
