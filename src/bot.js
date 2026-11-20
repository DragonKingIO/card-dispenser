// Devin Bot 任务：分流、异常单重试、熔断检查。
// 所有写库动作都记 audit_log，actor 一律 'devin-bot'，方便事后追责。
import { audit, getConfig, setConfig, killSwitchOn } from './util.js';
import { scoreOrder, triage, evaluateBreaker } from './risk.js';
import { fulfillOrder, refundOrder } from './fulfill.js';
import { reconcileDay } from './reconcile.js';

// 指纹画像：这个指纹是新的吗？最近 1 小时 / 24 小时下了几单？是首单吗？
export async function getVelocity(db, fingerprint) {
  const hour = await db.prepare(
    'SELECT COUNT(*) AS n FROM orders WHERE buyer_fingerprint = ? AND created_at > unixepoch() - 3600'
  ).bind(fingerprint).first();
  const day = await db.prepare(
    'SELECT COUNT(*) AS n FROM orders WHERE buyer_fingerprint = ? AND created_at > unixepoch() - 86400'
  ).bind(fingerprint).first();
  const total = await db.prepare(
    'SELECT COUNT(*) AS n FROM orders WHERE buyer_fingerprint = ?'
  ).bind(fingerprint).first();
  return {
    ordersLastHour: hour ? hour.n : 0,
    ordersLastDay: day ? day.n : 0,
    isNewFingerprint: (total ? total.n : 0) === 0,
    isFirstOrder: (total ? total.n : 0) <= 1,
  };
}

// 分流一单：打分 → auto / hold / block，只写 risk_score 和决策，不直接发卡。
export async function triageOrder(db, order, ctx) {
  const { score, reasons } = scoreOrder({
    isNewFingerprint: ctx.isNewFingerprint,
    fingerprintChanged: ctx.fingerprintChanged,
    isFirstOrder: ctx.isFirstOrder,
    isTopSku: ctx.isTopSku,
    ordersLastHour: ctx.ordersLastHour,
    ordersLastDay: ctx.ordersLastDay,
    amountCents: order.amount_cents,
    skuPriceCents: ctx.skuPriceCents,
  });
  const decision = triage(score);
  const nextStatus = decision === 'auto' ? 'paid' : decision === 'hold' ? 'held' : 'failed';
  await db.prepare(
    'UPDATE orders SET risk_score = ?, status = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(score, nextStatus, order.id).run();
  await audit(db, {
    orderId: order.id,
    actor: 'devin-bot',
    action: 'triage',
    detail: JSON.stringify({ score, reasons, decision }),
  });
  return { order_id: order.id, score, reasons, decision };
}

// 异常单重试：付款成功但没发出去的单（24 小时内，最多 20 单）。
// 有库存就重发，没有就自动退款。held 单等人工/验证，bot 不自动碰。
// kill switch 开着时整批跳过，什么都不干。
export async function retryFailedOrders(db, env, limit = 20) {
  if (await killSwitchOn(db)) return { skipped: true, reason: 'kill_switch_on', results: [] };
  const rows = await db.prepare(
    "SELECT * FROM orders WHERE status = 'paid' AND created_at > unixepoch() - 86400 ORDER BY created_at LIMIT ?"
  ).bind(limit).all();
  const results = [];
  for (const order of rows.results) {
    const res = await fulfillOrder(db, order);
    await audit(db, { orderId: order.id, actor: 'devin-bot', action: 'retry_fulfill', detail: JSON.stringify(res) });
    if (!res.ok && res.reason === 'out_of_stock') {
      const refund = await refundOrder(db, env.STRIPE_SECRET_KEY, order, 'out_of_stock');
      results.push({ order_id: order.id, fulfill: res, refund });
    } else {
      results.push({ order_id: order.id, fulfill: res });
    }
  }
  return { skipped: false, results };
}

// 熔断检查：读最近 10 分钟审计事件，够条件就自动跳闸并记一条。
// 跳闸后恢复必须人工点，bot 自己不能恢复。
export async function checkBreaker(db) {
  const rows = await db.prepare(
    'SELECT action, created_at FROM audit_log WHERE created_at > unixepoch() - 600 ORDER BY created_at DESC LIMIT 200'
  ).all();
  const events = rows.results.map((r) => ({
    type:
      r.action === 'error'
        ? 'error'
        : r.action === 'refund_failed'
          ? 'refund_failed'
          : r.action === 'inventory_mismatch'
            ? 'inventory_mismatch'
            : 'other',
    at: r.created_at * 1000,
  }));
  const verdict = evaluateBreaker(events);
  if (verdict.trip && !(await killSwitchOn(db))) {
    await setConfig(db, 'kill_switch', 'on');
    await audit(db, { actor: 'devin-bot', action: 'kill_switch_auto_trip', detail: JSON.stringify(verdict) });
    return { tripped: true, ...verdict };
  }
  return { tripped: false, ...verdict };
}

export async function runReconcile(db, stripeSecret) {
  return reconcileDay(db, stripeSecret);
}

export { getConfig };
