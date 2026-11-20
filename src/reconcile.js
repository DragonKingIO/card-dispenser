// 夜间对账：Stripe 最近 24 小时 charges vs D1 订单。
// 找出三类差异：Stripe 已收但 D1 没订单 / D1 订单金额与 Stripe 不一致 /
// Stripe 已收但 D1 还停在 pending/paid 没发卡。
import { stripeListCharges } from './stripe.js';

export async function reconcileDay(db, stripeSecret) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const charges = await stripeListCharges(stripeSecret, { limit: 100, createdGte: since });
  const mismatches = [];
  let checked = 0;
  for (const ch of charges.data) {
    checked++;
    const order = await db.prepare(
      'SELECT * FROM orders WHERE stripe_payment_intent = ?'
    ).bind(ch.payment_intent).first();
    if (!order) {
      mismatches.push({ type: 'missing_order', charge: ch.id, amount: ch.amount });
      continue;
    }
    if (order.amount_cents !== ch.amount) {
      mismatches.push({
        type: 'amount_mismatch',
        order_id: order.id,
        expected: ch.amount,
        actual: order.amount_cents,
      });
    }
    if (ch.status === 'succeeded' && (order.status === 'pending' || order.status === 'paid')) {
      mismatches.push({ type: 'unfulfilled', order_id: order.id });
    }
  }
  return { checked, mismatches };
}
