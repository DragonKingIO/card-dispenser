# Devin Bot 运维与开发闭环

这篇写的是发卡系统上线之后，Devin Bot 怎么在日常开发和运维里真正干活，
不是概念，是按仓库里已有的代码和接口写的流程。

## 角色分工

- Devin Bot：一线 oncall。接告警、定位问题、开 PR 修 bug、跑对账、写 postmortem 初稿。
- 人：二线。只做三件事：合 PR、点 kill switch 恢复、处理 sev3 的人工验证。
- 目标：把 toil（重复手工活）压到最低，人只拍板，不值夜班。

## 1. 告警从哪来

三个来源，全部进 `POST /v1/bot/tasks {"type":"alerts"}`，评估逻辑在 `src/alerts.js`：

| 来源 | 触发 | 严重度 |
| --- | --- | --- |
| Worker 运行时 | kill switch 自动跳闸、退款失败、心跳断了超过 10 分钟 | sev1 |
| 定时对账 | 每天 02:00 UTC 跑 `reconcile`，Stripe 流水跟 D1 订单对不上 | sev2 |
| 用户反馈 | 买家说付了钱没收到卡，或 held 队列里有单 | sev2 / sev3 |

分级规则：

- **sev1**：正在丢单 / 正在错发卡，立即处理。bot 自动建任务，同时人收到通知。
- **sev2**：退化，白天处理就行。比如 24 小时内有付了钱没发出去的单。
- **sev3**：观察，不用立即处理。比如 held 队列里等验证的单。

告警疲劳控制：同一个根因 10 分钟内只发一次，熔断指标本身就有 10 分钟窗口（见 `src/risk.js` 的 `evaluateBreaker`）。

## 2. 排查：从告警到 commit

bot 拿到一个 sev，按固定流程走：

1. **拉链路**：去 `audit_log` 里把相关订单的整条链路拉出来——什么时候建的单、什么时候锁的卡、哪一步失败的、谁（`system` / `devin-bot` / `admin`）动的。
2. **定位提交**：去 `git log` 里找最近改过相关文件的提交。比如报错集中在 `src/fulfill.js`，就看最近动过这个文件的提交，再结合报错时间，定位到是哪个提交引入的问题。
3. **复现**：用订单号 + 日志在本地复现，复现不了就先把订单改成 `held`，不让它继续错下去。
4. **修**：只改出问题的那一块，开 PR，附上订单号、日志片段和复现步骤。

## 3. 修复：PR → review → 上线

1. bot 开 PR，改动范围只限定位到的那一块。
2. CI 先跑：`npm test`（17 个测试）、全部 `src/*.js` 语法检查、两个迁移的 SQL 校验（见 `.github/workflows/ci.yml`）。
3. 人 review diff，没问题就合。合并不需要等我起床以外的任何人。
4. 合完 `npx wrangler deploy` 上线。量小直接全量，不做 canary，出问题 `npx wrangler rollback` 一条命令就回去（见 `docs/ops-runbook.md`）。
5. 上线后 bot 盯 30 分钟：`GET /health` 正常、没有新的 sev1，才算修完。

## 4. 日常迭代

1. 人在 GitHub 上开 issue（模板在 `.github/ISSUE_TEMPLATE/`），写清楚要做什么、验收标准是什么。
2. bot 按 `docs/api-contract.md` 和现在的模块结构去实现，不改契约以外的东西。
3. 写完开 PR（模板在 `.github/pull_request_template.md`），CI 过了人再 review，合了就上线。
4. SLO 见 `docs/slo.md`：30 天内付款到发卡成功率 99.5%。error budget 烧完就停新功能，只修 reliability 的东西。

## 5. 事后：postmortem

sev1 修完 48 小时内要写 postmortem，模板在 `docs/postmortem-template.md`。
blameless，只写事实：影响面、时间线、root cause、action items。
action items 要有负责人（bot 或人）和截止时间，下次同类问题直接按 action items 走，
不再从头排查。

## 6. 这套闭环对应的代码

| 环节 | 代码 / 文档 |
| --- | --- |
| 告警分级 | `src/alerts.js`、`test/alerts.test.js` |
| 熔断条件 | `src/risk.js` 的 `evaluateBreaker` |
| 异常单重试 | `src/bot.js` 的 `retryFailedOrders` |
| 对账 | `src/reconcile.js` |
| 任务入口 | `POST /v1/bot/tasks`（`alerts` / `retry-fulfill` / `reconcile` / `check-breaker`） |
| 定时任务 | 每天 02:00 UTC：对账 + 清限流表 + 熔断检查 |
| SLO | `docs/slo.md` |
| oncall 手册 | `docs/oncall-runbook.md` |
| postmortem 模板 | `docs/postmortem-template.md` |
