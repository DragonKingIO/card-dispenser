// 发卡与退款：真正改卡状态的地方。所有入口都先过 kill switch。
import { audit, killSwitchOn } from './util.js';
import { stripeRefund } from './stripe.js';

// 锁一张卡：先按 sku + unsold 查一张，再用带状态守卫的 UPDATE 抢锁。
// 两个并发抢同一张卡时只有一个能改成功，另一个 changes 为 0，抢不到。
export async function lockCard(db, orderId, sku) {
  const card = await db.prepare(
    "SELECT id FROM cards WHERE sku = ? AND status = 'unsold' ORDER BY id LIMIT 1"
  ).bind(sku).first();
  if (!card) return null;
  const res = await db.prepare(
    "UPDATE cards SET status = 'locked', order_id = ?, updated_at = unixepoch() WHERE id = ? AND status = 'unsold'"
  ).bind(orderId, card.id).run();
  if (res.meta.changes === 0) return null;
  await db.prepare(
    'UPDATE orders SET card_id = ?, updated_at = unixepoch() WHERE id = ?'
  ).bind(card.id, orderId).run();
  return card.id;
}

// 发卡：kill switch 开着直接拒绝；没卡可发返回缺货。
export async function fulfillOrder(db, order) {
  if (await killSwitchOn(db)) return { ok: false, reason: 'kill_switch_on' };
  const cardId = order.card_id || (await lockCard(db, order.id, order.sku));
  if (!cardId) return { ok: false, reason: 'out_of_stock' };
  await db.batch([
    db.prepare("UPDATE cards SET status = 'issued', updated_at = unixepoch() WHERE id = ?").bind(cardId),
    db.prepare("UPDATE orders SET status = 'fulfilled', updated_at = unixepoch() WHERE id = ?").bind(order.id),
  ]);
  await audit(db, { orderId: order.id, cardId, actor: 'system', action: 'fulfill', detail: `card ${cardId} issued` });
  return { ok: true, cardId };
}

// 退款：先调 Stripe，成功再改本地状态；失败只记 audit，不改状态，等 bot 重试。
// 已发出的卡改成 refunded，码作废；锁着没发的卡也一起作废。
export async function refundOrder(db, stripeSecret, order, reason) {
  try {
    const refund = await stripeRefund(stripeSecret, order.stripe_payment_intent, order.amount_cents, reason);
    await db.batch([
      db.prepare("UPDATE orders SET status = 'refunded', updated_at = unixepoch() WHERE id = ?").bind(order.id),
      db.prepare(
        "UPDATE cards SET status = 'refunded', updated_at = unixepoch() WHERE order_id = ? AND status IN ('locked', 'issued')"
      ).bind(order.id),
      db.prepare(
        'INSERT INTO refunds (order_id, stripe_refund_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?, unixepoch())'
      ).bind(order.id, refund.id, order.amount_cents, reason),
    ]);
    await audit(db, { orderId: order.id, actor: 'system', action: 'refund', detail: refund.id });
    return { ok: true, refund_id: refund.id };
  } catch (err) {
    await audit(db, { orderId: order.id, actor: 'system', action: 'refund_failed', detail: String(err) });
    return { ok: false, reason: 'stripe_refund_failed' };
  }
}
