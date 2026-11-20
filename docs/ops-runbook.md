# 运维手册

## 部署

```bash
npm install
npx wrangler d1 create card-dispenser   # 把 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply card-dispenser --local   # 本地先跑一遍
npx wrangler d1 migrations apply card-dispenser --remote  # 再上远程
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

密钥不要写进 `wrangler.toml`，不要提交 `.dev.vars`。

## 每天看什么

- `GET /health`：`kill_switch` 是不是 `off`，`bot_heartbeat_stale` 是不是 `false`。
- 对账报告：定时任务每天 02:00 UTC 跑完写进 `audit_log`（`action='nightly_reconcile'`），
  `mismatches` 非空就去查。
- `GET /v1/admin/holds`：被扣住的单，验证通过手动放行（`POST /v1/admin/fulfill`），
  验证不过手动退款（`POST /v1/admin/refund`）。

## 事故处理

### Kill switch 跳了

1. `GET /v1/admin/kill-switch` 确认状态。
2. 查 `audit_log` 里 `action='kill_switch_auto_trip'` 那条，看是哪项指标触发的。
3. 修好根因（补库存 / 修 Stripe 配置 / 重启 bot）。
4. `POST /v1/admin/kill-switch {"value":"off","reason":"..."}` 恢复。
5. 恢复后 bot 会自动重发 24 小时内 `paid` 未发的单。

### 买家说付了钱没收到卡

1. 按 `stripe_payment_intent` 查订单状态。
2. `pending`：回调丢了，等 bot 重试，或手动调 `POST /v1/bot/tasks {"type":"retry-fulfill"}`。
3. `held`：风控扣单，走验证流程。
4. `fulfilled` 但买家说没收到：查 `audit_log` 的 `fulfill` 记录，确认卡号和发出时间，再决定补发还是退款。

### Stripe 回调一直 400

1. 检查 `STRIPE_WEBHOOK_SECRET` 是不是轮换过，Worker 里的 secret 要同步更新。
2. 检查 Stripe 后台 webhook 的 URL 是不是新部署的域名。
3. 验签失败不读事件体，所以 400 本身不丢单，回调会在 Stripe 后台重试。

## 回滚

Worker 部署是整体替换，出问题直接 `npx wrangler rollback`。
D1 迁移只加表加列，不删字段，回滚代码不需要回滚库。
