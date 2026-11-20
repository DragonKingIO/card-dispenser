import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreOrder, triage, shouldTripBreaker, heartbeatStale } from '../src/risk.js';

test('全新指纹首单买最高面额 → hold', () => {
  const { score } = scoreOrder({
    isNewFingerprint: true,
    fingerprintChanged: false,
    isFirstOrder: true,
    isTopSku: true,
    ordersLastHour: 1,
    ordersLastDay: 1,
    amountCents: 5000,
    skuPriceCents: 5000,
  });
  assert.equal(score, 50);
  assert.equal(triage(score), 'hold');
});

test('老用户正常复购 → auto', () => {
  const { score } = scoreOrder({
    isNewFingerprint: false,
    fingerprintChanged: false,
    isFirstOrder: false,
    isTopSku: false,
    ordersLastHour: 1,
    ordersLastDay: 2,
    amountCents: 1000,
    skuPriceCents: 1000,
  });
  assert.equal(score, 0);
  assert.equal(triage(score), 'auto');
});

test('同一指纹 1 小时 5 单 → block', () => {
  const { score } = scoreOrder({
    isNewFingerprint: true,
    fingerprintChanged: false,
    isFirstOrder: false,
    isTopSku: false,
    ordersLastHour: 5,
    ordersLastDay: 6,
    amountCents: 5000,
    skuPriceCents: 5000,
  });
  assert.ok(score >= 70);
  assert.equal(triage(score), 'block');
});

test('金额与标价不一致 → +10 分', () => {
  const { score, reasons } = scoreOrder({
    isNewFingerprint: false,
    fingerprintChanged: false,
    isFirstOrder: false,
    isTopSku: false,
    ordersLastHour: 1,
    ordersLastDay: 1,
    amountCents: 4999,
    skuPriceCents: 5000,
  });
  assert.equal(score, 10);
  assert.deepEqual(reasons, ['amount_mismatch']);
});

test('分流边界：39 auto，40 hold，69 hold，70 block', () => {
  assert.equal(triage(39), 'auto');
  assert.equal(triage(40), 'hold');
  assert.equal(triage(69), 'hold');
  assert.equal(triage(70), 'block');
});

test('熔断条件', () => {
  assert.equal(shouldTripBreaker({ errorsLast10m: 5, refundFailures: 0, inventoryMismatch: 0 }), true);
  assert.equal(shouldTripBreaker({ errorsLast10m: 0, refundFailures: 2, inventoryMismatch: 0 }), true);
  assert.equal(shouldTripBreaker({ errorsLast10m: 0, refundFailures: 0, inventoryMismatch: 3 }), true);
  assert.equal(shouldTripBreaker({ errorsLast10m: 4, refundFailures: 1, inventoryMismatch: 2 }), false);
});

test('心跳过期判定', () => {
  const now = Date.now();
  assert.equal(heartbeatStale(now - 11 * 60 * 1000, now), true);
  assert.equal(heartbeatStale(now - 9 * 60 * 1000, now), false);
});
