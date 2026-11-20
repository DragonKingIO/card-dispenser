// 告警评估：从最近的审计事件 + 健康状态里算出告警，带严重度与建议的 Devin 任务。
// 纯函数，可单测；Worker 里由 POST /v1/bot/tasks {"type":"alerts"} 调。
import { evaluateBreaker } from './risk.js';

export const SEVERITY = { SEV1: 'sev1', SEV2: 'sev2', SEV3: 'sev3' };

// sev1：正在丢单 / 正在错发卡，立即处理
// sev2：退化，白天处理就行
// sev3：观察，不用立即处理
export function evaluateAlerts({
  auditEvents,
  killSwitchOn,
  heartbeatStale,
  heldCount,
  unfulfilledCount,
  nowMs = Date.now(),
}) {
  const alerts = [];
  const breaker = evaluateBreaker(auditEvents, nowMs);
  if (breaker.trip) {
    alerts.push({
      severity: SEVERITY.SEV1,
      title: 'kill switch auto-tripped',
      detail: breaker,
      devin_task: { type: 'check-breaker' },
    });
  }
  if (heartbeatStale) {
    alerts.push({
      severity: SEVERITY.SEV1,
      title: 'bot heartbeat stale > 10m',
      detail: 'no heartbeat in 10 minutes, checkout is returning 503',
      devin_task: { type: 'check-breaker' },
    });
  }
  if (killSwitchOn) {
    alerts.push({
      severity: SEVERITY.SEV2,
      title: 'kill switch is on',
      detail: 'fulfillment paused, orders queueing as held',
      devin_task: { type: 'retry-fulfill', limit: 20 },
    });
  }
  if (unfulfilledCount > 0) {
    alerts.push({
      severity: SEVERITY.SEV2,
      title: `${unfulfilledCount} paid orders unfulfilled in 24h`,
      detail: 'paid but no card issued',
      devin_task: { type: 'retry-fulfill', limit: 20 },
    });
  }
  if (heldCount > 0) {
    alerts.push({
      severity: SEVERITY.SEV3,
      title: `${heldCount} orders held for review`,
      detail: 'risk hold, needs human verification',
      devin_task: null,
    });
  }
  return alerts;
}
