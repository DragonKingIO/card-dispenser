# Oncall 手册

## 值班安排

- 一线：Devin Bot，全天候。接告警、定位、开 PR、跑对账。
- 二线：人。只处理 bot 标出来、实在拿不准的单，以及 kill switch 恢复。
- 目标：人不用值夜班，早上起来看一眼 bot 交班的汇总就行。

## 严重度

| 级别 | 定义 | 响应 |
| --- | --- | --- |
| sev1 | 正在丢单 / 正在错发卡 | 立即处理，bot 自动建任务并通知人 |
| sev2 | 退化，比如有单付了钱没发出去 | 白天处理，bot 先自动重试 / 退款 |
| sev3 | 观察，比如 held 队列里等验证的单 | 不用立即处理，按队列顺序人工验证 |

## 接到 sev1 怎么办

1. 先止血：确认 kill switch 是不是已经跳了。没跳、还在继续错发卡，手动 `POST /v1/admin/kill-switch {"value":"on"}`。
2. 再定位：按 `docs/devin-ops-loop.md` 第 2 节走，audit_log → git log → 定位提交。
3. 修：开 PR，CI 过了、review 过了就合，`npx wrangler deploy` 上线。
4. 验证：上线后盯 30 分钟，`GET /health` 正常、没有新的 sev1，才算修完。
5. 恢复：确认根因修好了，再 `POST /v1/admin/kill-switch {"value":"off"}`。恢复必须人工点，bot 不能自己恢复。
6. 事后：48 小时内写 postmortem（模板在 `docs/postmortem-template.md`）。

## 回滚

Worker 部署是整体替换，出问题直接 `npx wrangler rollback`。
D1 迁移只加表加列，不删字段，回滚代码不需要回滚库。

## 升级

- bot 连续两次重试同一单都失败 → 升级给人，不再自动重试。
- 同一个根因 24 小时内出两次 sev1 → 升级：停新功能，先修 reliability。
- 钱对不上（对账 `mismatches` 非空）→ 当天处理，不隔夜。
