import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlerts } from '../src/alerts.js';

const now = Date.now();
const at = (minutesAgo) => now - minutesAgo * 60 * 1000;

test('熔断跳闸 → sev1，带 check-breaker 任务', () => {
  const events = Array.from({ length: 5 }, () => ({ type: 'error', at: at(2) }));
  const alerts = evaluateAlerts({
    auditEvents: events,
    killSwitchOn: false,
    heartbeatStale: false,
    heldCount: 0,
    unfulfilledCount: 0,
    nowMs: now,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'sev1');
  assert.equal(alerts[0].devin_task.type, 'check-breaker');
});

test('心跳断了 → sev1', () => {
  const alerts = evaluateAlerts({
    auditEvents: [],
    killSwitchOn: false,
    heartbeatStale: true,
    heldCount: 0,
    unfulfilledCount: 0,
    nowMs: now,
  });
  assert.equal(alerts[0].severity, 'sev1');
  assert.match(alerts[0].title, /heartbeat/);
});

test('有未发卡订单 → sev2，带 retry 任务', () => {
  const alerts = evaluateAlerts({
    auditEvents: [],
    killSwitchOn: false,
    heartbeatStale: false,
    heldCount: 0,
    unfulfilledCount: 3,
    nowMs: now,
  });
  assert.equal(alerts[0].severity, 'sev2');
  assert.equal(alerts[0].devin_task.type, 'retry-fulfill');
});

test('只有 held 单 → sev3，无自动任务', () => {
  const alerts = evaluateAlerts({
    auditEvents: [],
    killSwitchOn: false,
    heartbeatStale: false,
    heldCount: 2,
    unfulfilledCount: 0,
    nowMs: now,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'sev3');
  assert.equal(alerts[0].devin_task, null);
});

test('一切正常 → 无告警', () => {
  const alerts = evaluateAlerts({
    auditEvents: [],
    killSwitchOn: false,
    heartbeatStale: false,
    heldCount: 0,
    unfulfilledCount: 0,
    nowMs: now,
  });
  assert.equal(alerts.length, 0);
});
