// 管理接口：kill switch、held 队列、人工发卡/退款。
// 统一用 x-admin-token 鉴权（ADMIN_TOKEN），不要把这个接口公开。
import { json, getConfig, setConfig, audit } from './util.js';
import { fulfillOrder, refundOrder } from './fulfill.js';

export async function handleAdmin(request, db, env) {
  const url = new URL(request.url);
  const token = request.headers.get('x-admin-token');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (url.pathname === '/v1/admin/kill-switch') {
    if (request.method === 'GET') {
      return json({ kill_switch: (await getConfig(db, 'kill_switch')) || 'off' });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      if (body.value !== 'on' && body.value !== 'off') {
        return json({ error: 'value must be on|off' }, 400);
      }
      await setConfig(db, 'kill_switch', body.value);
      await audit(db, { actor: 'admin', action: 'kill_switch_' + body.value, detail: body.reason || '' });
      return json({ kill_switch: body.value });
    }
  }

  // 被风控扣住的单，按时间倒序，最多 50 条。
  if (url.pathname === '/v1/admin/holds' && request.method === 'GET') {
    const rows = await db.prepare(
      "SELECT * FROM orders WHERE status = 'held' ORDER BY created_at DESC LIMIT 50"
    ).all();
    return json({ holds: rows.results });
  }

  // 人工发卡：验证通过的 held 单，手动放行。
  if (url.pathname === '/v1/admin/fulfill' && request.method === 'POST') {
    const { order_id } = await request.json();
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(order_id).first();
    if (!order) return json({ error: 'order_not_found' }, 404);
    const result = await fulfillOrder(db, order);
    await audit(db, { orderId: order.id, actor: 'admin', action: 'manual_fulfill', detail: JSON.stringify(result) });
    return json({ order_id, ...result });
  }

  // 人工退款：验证不过的 held 单，或买家申请退款。
  if (url.pathname === '/v1/admin/refund' && request.method === 'POST') {
    const { order_id, reason } = await request.json();
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(order_id).first();
    if (!order) return json({ error: 'order_not_found' }, 404);
    const result = await refundOrder(db, env.STRIPE_SECRET_KEY, order, reason || 'requested_by_customer');
    return json({ order_id, ...result });
  }

  return json({ error: 'not_found' }, 404);
}
