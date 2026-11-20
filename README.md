# card-dispenser

自动发卡系统后端：Cloudflare Worker + D1 + Stripe。

买家下单 → Stripe 收款 → webhook 回调 → Worker 锁卡、发卡；Devin Bot 接 webhook 任务，负责分流、异常单重试/退款和夜间对账。Bot 出错时有三层 kill switch 兜底。

## 结构

```
card-dispenser/
├── wrangler.toml        # Worker + D1 绑定 + 每天 02:00 UTC 定时任务
├── migrations/          # D1 迁移：0001 核心表，0002 幂等键 + 限流
├── src/
│   ├── index.js         # 路由 + 定时任务入口
│   ├── util.js          # JSON 响应、config 读写、审计日志、kill switch 状态
│   ├── fulfill.js       # 锁卡、发卡、退款（真正改卡状态的地方）
│   ├── stripe.js        # 回调验签（HMAC-SHA256）、退款、查流水
│   ├── risk.js          # 风控打分、分流阈值、熔断条件（纯函数，可单测）
│   ├── bot.js           # 指纹画像、分流、异常单重试、熔断检查
│   ├── reconcile.js     # 夜间对账：Stripe 流水 vs D1 订单
│   ├── ratelimit.js     # 下单限流（D1 计数，60 秒窗口）
│   ├── idempotency.js   # 幂等键，响应缓存 24 小时
│   └── admin.js         # kill switch、held 队列、人工发卡/退款
├── test/                # node:test：风控打分、熔断条件、心跳过期
├── docs/
│   ├── api-contract.md  # API 契约
│   ├── architecture.md  # 架构、模块分工、失败模式
│   ├── erd.mmd          # 表结构图
│   ├── sequence.mmd     # 下单到发卡时序图
│   ├── sequence-killswitch.mmd  # 三层熔断时序图
│   ├── threat-model.md  # 威胁模型
│   └── ops-runbook.md   # 运维手册：部署、每天看什么、事故处理
├── .github/workflows/ci.yml  # 推代码就跑测试 + 语法检查 + 迁移校验
├── package.json
└── .env.example         # 需要填的密钥和配置
```

## 表

- `cards`：一张卡一行，状态只有四种：`unsold` / `locked` / `issued` / `refunded`。出库先查状态再改，同一张卡不可能发两次。
- `orders`：订单，`stripe_payment_intent` 唯一，状态 `pending` / `paid` / `held` / `fulfilled` / `refunded` / `failed`，带 `risk_score`。
- `refunds`：退款记录。`audit_log`：每一次状态变化都记一条，`actor` 是 `system` / `devin-bot` / `admin`。
- `config`：kill switch 就存在这里，`kill_switch` 只有 `on` / `off`；`last_bot_heartbeat` 记 bot 上次心跳时间。
- `idempotency_keys`：幂等键，响应缓存 24 小时。`rate_limits`：限流计数，60 秒窗口。

## 风控分流

打分见 `src/risk.js`：全新指纹 +30、首单最高面额 +20、1 小时内同指纹 ≥3 单每多一单 +15（上限 45）、
金额与标价不一致 +10。`< 40` 自动发卡，`40–69` 扣单等验证，`≥ 70` 直接退款。

## Kill switch（三层）

1. 手动开关：`POST /v1/admin/kill-switch`，一点就停。停了之后不再发卡、不再退款，所有单子进人工队列。
2. 自动跳闸：十分钟内报错超过 5 次，或退款失败 2 次，或库存对不上超过 3 张，开关自动跳闸，同样只进不出。
3. 心跳保底：bot 每 5 分钟发一次心跳，断了超过 10 分钟，下单接口直接 503，店面挂维护页，钱收不进来，也就不会出现收了钱发不出卡的情况。

开关跳了之后恢复必须人工点，bot 自己不能恢复。

## 本地跑起来

```bash
npm install
npm test
npx wrangler d1 create card-dispenser   # 把返回的 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply card-dispenser --local
cp .env.example .dev.vars               # 填 Stripe 密钥
npm run dev
```

部署见 `docs/ops-runbook.md`。

## Devin Bot 接在哪里

- `POST /v1/bot/tasks`：`retry-fulfill`（重发失败的单）、`reconcile`（夜间对账）、`check-breaker`（熔断检查）。
- `POST /v1/bot/heartbeat`：bot 每 5 分钟报一次到。
- 定时任务每天 02:00 UTC：对账 + 清限流表 + 熔断检查。
- 订单 webhook 里 kill switch 开着或心跳断了，订单直接进 `held`，bot 只处理它标出来的单。

## 状态

- 已就绪：表结构、API 契约、时序图、Worker 全部路由、Stripe 验签、风控分流、限流幂等、对账、kill switch、测试、CI。
- 待接：`pending` 订单超 30 分钟未付款自动释放锁卡（威胁模型第 6 条）；店面 checkout 页；`src/stripe.js` 的 `created[gte]` 对账分页（超过 100 笔要翻页）。
