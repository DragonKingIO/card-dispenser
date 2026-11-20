# 威胁模型

只列这个系统真实会遇到的威胁，不列通用的。

## 1. 同一张卡发两次

- 场景：两个并发请求抢同一张卡，或回调重发导致重复发卡。
- 缓解：锁卡用带状态守卫的 `UPDATE ... WHERE status = 'unsold'`，`changes == 0` 算抢锁失败；
  `code` 字段唯一约束；下单要求 `Idempotency-Key`，重复请求直接返回缓存响应。
- 残余风险：D1 批次不是跨语句事务，锁卡和改订单状态分两步写，中间崩了会留下一张 `locked` 没人认领的卡。
  bot 的 `retry-fulfill` 会扫 24 小时内 `paid` 未发的单，但 `locked` 孤儿卡要靠对账发现（见对账差异类型）。

## 2. 伪造 Stripe 回调

- 场景：有人直接 POST `/webhooks/stripe`，伪造 `payment_intent.succeeded` 骗发卡。
- 缓解：验签（HMAC-SHA256，`STRIPE_WEBHOOK_SECRET`），时间戳超过 5 分钟拒掉；验签失败 400，不读事件体。
- 残余风险：`STRIPE_WEBHOOK_SECRET` 泄露等于验签失效。密钥只放 `wrangler secret`，不要进仓库、不要进 `.dev.vars` 提交。

## 3. 薅羊毛：同一人多号刷单

- 场景：新号首单买最高面额、同一设备短时间多单。
- 缓解：风控打分（全新指纹 +30、首单最高面额 +20、1 小时 ≥3 单每多一单 +15）；
  ≥40 扣单等验证，≥70 直接退款；下单限流同一指纹 10 次/分钟。
- 残余风险：指纹本身可以伪造，只能抬高成本，不能根除。真遇到团伙刷单，靠人工拉黑 + 熔断。

## 4. Bot 失控：一直发卡 / 一直退款

- 场景：bot 逻辑 bug，把 held 单全放了，或者循环退款。
- 缓解：三层 kill switch（手动开关、自动跳闸、心跳保底），跳闸后只进不出；
  恢复必须人工点，bot 自己不能恢复；所有 bot 动作记 `audit_log`，`actor='devin-bot'`。
- 残余风险：开关本身存在 D1 里，D1 挂了开关读不到。`killSwitchOn` 读不到时返回 `false`，
  也就是默认放行——这是已知取舍，D1 挂了订单也建不起来，影响有限。

## 5. 密钥泄露

- 场景：`STRIPE_SECRET_KEY` 或 `ADMIN_TOKEN` 被人拿到。
- 缓解：密钥只放 `wrangler secret` / `.dev.vars`，`.gitignore` 已覆盖；
  `ADMIN_TOKEN` 泄露只影响管理接口，不影响发卡（发卡不走 admin）；
  Stripe 密钥泄露要立刻在 Stripe 后台轮换，并检查最近退款记录。
- 残余风险：`.dev.vars` 一旦被提交进仓库，历史记录里永远有。推之前检查 `git log`。

## 6. 库存被扫空

- 场景：脚本下单不付款，把卡全锁住（锁了不付款，卡一直是 `locked`）。
- 缓解：锁库存带 TTL 的思路在订单层实现——`pending` 订单超过 30 分钟未付款，
  bot 定时任务把卡释放回 `unsold`（待接，见 README 状态）。
  下单限流 10 次/分钟/指纹，扫的速度也被压住。
