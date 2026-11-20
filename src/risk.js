// 风控打分与分流：纯函数，不碰 D1，可单测。
// 分数只看订单本身 + 指纹画像，不看任何外部黑名单。

export const RISK_WEIGHTS = {
  newFingerprint: 30, // 全新设备指纹
  fingerprintChanged: 25, // 老账号换设备
  highValueFirstOrder: 20, // 首单就是最高面额
  velocityHour: 15, // 1 小时内同指纹下单 ≥ 3 次，每多一次 +15，上限 45
  velocityDay: 10, // 24 小时内同指纹下单 ≥ 5 次
  amountMismatch: 10, // 金额与 SKU 标价不一致
};

export function scoreOrder({
  isNewFingerprint,
  fingerprintChanged,
  isFirstOrder,
  isTopSku,
  ordersLastHour,
  ordersLastDay,
  amountCents,
  skuPriceCents,
}) {
  let score = 0;
  const reasons = [];
  if (isNewFingerprint) {
    score += RISK_WEIGHTS.newFingerprint;
    reasons.push('new_fingerprint');
  }
  if (fingerprintChanged) {
    score += RISK_WEIGHTS.fingerprintChanged;
    reasons.push('fingerprint_changed');
  }
  if (isFirstOrder && isTopSku) {
    score += RISK_WEIGHTS.highValueFirstOrder;
    reasons.push('first_order_top_sku');
  }
  if (ordersLastHour >= 3) {
    const extra = Math.min(45, (ordersLastHour - 2) * RISK_WEIGHTS.velocityHour);
    score += extra;
    reasons.push('velocity_hour');
  }
  if (ordersLastDay >= 5) {
    score += RISK_WEIGHTS.velocityDay;
    reasons.push('velocity_day');
  }
  if (skuPriceCents != null && amountCents !== skuPriceCents) {
    score += RISK_WEIGHTS.amountMismatch;
    reasons.push('amount_mismatch');
  }
  return { score, reasons };
}

// 分流阈值：< 40 自动发卡；40–69 扣单等验证；≥ 70 直接拒绝并退款。
export function triage(score) {
  if (score >= 70) return 'block';
  if (score >= 40) return 'hold';
  return 'auto';
}

// 熔断条件：十分钟内报错 ≥ 5 次，或退款失败 ≥ 2 次，或库存对不上 ≥ 3 张。
export function shouldTripBreaker({ errorsLast10m, refundFailures, inventoryMismatch }) {
  return errorsLast10m >= 5 || refundFailures >= 2 || inventoryMismatch >= 3;
}

// 从最近 10 分钟的审计事件里算熔断指标。
export function evaluateBreaker(auditEvents, nowMs = Date.now()) {
  const windowStart = nowMs - 10 * 60 * 1000;
  const recent = auditEvents.filter((e) => e.at >= windowStart);
  const errorsLast10m = recent.filter((e) => e.type === 'error').length;
  const refundFailures = recent.filter((e) => e.type === 'refund_failed').length;
  const inventoryMismatch = recent.filter((e) => e.type === 'inventory_mismatch').length;
  return {
    errorsLast10m,
    refundFailures,
    inventoryMismatch,
    trip: shouldTripBreaker({ errorsLast10m, refundFailures, inventoryMismatch }),
  };
}

export function heartbeatStale(lastHeartbeatMs, nowMs = Date.now(), staleAfterMs = 10 * 60 * 1000) {
  return nowMs - lastHeartbeatMs > staleAfterMs;
}
