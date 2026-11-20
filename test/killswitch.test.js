import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBreaker } from '../src/risk.js';

const now = Date.now();
const at = (minutesAgo) => now - minutesAgo * 60 * 1000;

test('10 分钟内 5 次 error → 跳闸', () => {
  const events = Array.from({ length: 5 }, () => ({ type: 'error', at: at(2) }));
  const v = evaluateBreaker(events, now);
  assert.equal(v.errorsLast10m, 5);
  assert.equal(v.trip, true);
});

test('10 分钟外的 error 不算', () => {
  const events = Array.from({ length: 9 }, () => ({ type: 'error', at: at(11) }));
  const v = evaluateBreaker(events, now);
  assert.equal(v.errorsLast10m, 0);
  assert.equal(v.trip, false);
});

test('2 次退款失败 → 跳闸', () => {
  const events = [
    { type: 'refund_failed', at: at(1) },
    { type: 'refund_failed', at: at(3) },
  ];
  const v = evaluateBreaker(events, now);
  assert.equal(v.refundFailures, 2);
  assert.equal(v.trip, true);
});

test('3 张库存对不上 → 跳闸', () => {
  const events = Array.from({ length: 3 }, () => ({ type: 'inventory_mismatch', at: at(5) }));
  const v = evaluateBreaker(events, now);
  assert.equal(v.inventoryMismatch, 3);
  assert.equal(v.trip, true);
});

test('零星事件不跳闸', () => {
  const events = [
    { type: 'error', at: at(1) },
    { type: 'refund_failed', at: at(2) },
    { type: 'inventory_mismatch', at: at(3) },
    { type: 'other', at: at(4) },
  ];
  const v = evaluateBreaker(events, now);
  assert.equal(v.trip, false);
});
