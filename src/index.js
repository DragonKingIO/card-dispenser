// card-dispenser 入口：路由 + 定时任务。
// 模块分工见 README 和 docs/architecture.md。
import { json, getConfig, setConfig, audit, killSwitchOn, heartbeatStale } from './util.js';
import { verifyStripeSignature } from './stripe.js';
import { fulfillOrder, refundOrder } from './fulfill.js';
import { getVelocity, triageOrder, retryFailedOrders, checkBreaker, runReconcile } from './bot.js';
import { evaluateAlerts } from './alerts.js';
import { checkRateLimit, cleanupRateLimits } from './ratelimit.js';
import { getIdempotentResponse, saveIdempotentResponse } from './idempotency.js';
import { handleAdmin } from './admin.js';

// SKU 标价（单位：分）。金额与标价不一致直接加风控分，见 src/risk.js。
const SKU_PRICES = {
  'gift-10': 1000,
  'gift-25': 2500,
  'gift-50': 5000,
  'gift-100': 10000,
};
const TOP_SKUS = new Set(['gift-100']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        kill_switch: (await getConfig(db, 'kill_switch')) || 'off',
        bot_heartbeat_stale: await heartbeatStale(db),
      });
    }

    // 下单：限流 → 幂等 → 熔断/心跳检查 → 建 pending 订单。
    if (request.method === 'POST' && url.pathname === '/v1/orders') {
      const body = await request.json();
      const fp = body.buyer_fingerprint || 'unknown';
      const idemKey = request.headers.get('idempotency-key');
      if (idemKey) {
        const cached = await getIdempotentResponse(db, idemKey);
        if (cached) return json(cached, 201);
      }
      const rl = await checkRateLimit(db, `order:${fp}`, 10, 60);
      if (!rl.allowed) return json({ error: 'rate_limited', remaining: 0 }, 429);
      if (await killSwitchOn(db)) return json({ error: 'kill_switch_on' }, 503);
      if (await heartbeatStale(db)) return json({ error: 'bot_heartbeat_stale' }, 503);
      if (!SKU_PRICES[body.sku]) return json({ error: 'unknown_sku' }, 400);
      const row = await db.prepare(
        'INSERT INTO orders (stripe_payment_intent, sku, amount_cents, currency, buyer_fingerprint, status, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()) RETURNING id'
      ).bind(
        body.stripe_payment_intent || null,
        body.sku,
        body.amount_cents,
        body.currency || 'usd',
        fp,
        'pending'
      ).first();
      const response = { order_id: row.id, status: 'pending' };
      await audit(db, { orderId: row.id, actor: 'system', action: 'order_created', detail: body.sku });
      await saveIdempotentResponse(db, idemKey, fp, response);
      return json(response, 201);
    }

    // Stripe 回调：先验签，再按事件处理。验签失败直接 400，不读事件体。
    if (request.method === 'POST' && url.pathname === '/webhooks/stripe') {
      const raw = await request.text();
      const sig = request.headers.get('stripe-signature') || '';
      const ok = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return json({ error: 'bad_signature' }, 400);
      const event = JSON.parse(raw);
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object.id;
        const order = await db.prepare('SELECT * FROM orders WHERE stripe_payment_intent = ?').bind(pi).first();
        if (!order) return json({ received: true, order: 'unknown' });
        // 分流：打分 → auto 发卡 / hold 扣单 / block 直接退款。
        const velocity = await getVelocity(db, order.buyer_fingerprint);
        const { decision } = await triageOrder(db, order, {
          ...velocity,
          // 换设备检测由店面在 buyer_fingerprint 里带版本区分（fp_v1/fp_v2），
          // 这里只认当前指纹是否全新。
          fingerprintChanged: false,
          isTopSku: TOP_SKUS.has(order.sku),
          skuPriceCents: SKU_PRICES[order.sku],
        });
        if (decision === 'auto') {
          const result = await fulfillOrder(db, { ...order, status: 'paid' });
          return json({ received: true, decision, fulfill: result });
        }
        if (decision === 'hold') {
          return json({ received: true, decision, order: 'held' });
        }
        const refund = await refundOrder(db, env.STRIPE_SECRET_KEY, order, 'fraudulent');
        return json({ received: true, decision, refund });
      }
      return json({ received: true });
    }

    // Devin Bot 任务入口：异常单重试、对账、熔断检查。
    if (request.method === 'POST' && url.pathname === '/v1/bot/tasks') {
      const body = await request.json();
      if (body.type === 'retry-fulfill') {
        return json(await retryFailedOrders(db, env, body.limit || 20));
      }
      if (body.type === 'reconcile') {
        const report = await runReconcile(db, env.STRIPE_SECRET_KEY);
        await audit(db, { actor: 'devin-bot', action: 'reconcile', detail: JSON.stringify(report) });
        return json(report);
      }
      if (body.type === 'alerts') {
        const events = await db.prepare(
          'SELECT action, created_at FROM audit_log WHERE created_at > unixepoch() - 600 ORDER BY created_at DESC LIMIT 200'
        ).all();
        const auditEvents = events.results.map((r) => ({
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
        const held = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'held'").first();
        const unfulfilled = await db.prepare(
          "SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid', 'pending') AND created_at > unixepoch() - 86400"
        ).first();
        const alerts = evaluateAlerts({
          auditEvents,
          killSwitchOn: await killSwitchOn(db),
          heartbeatStale: await heartbeatStale(db),
          heldCount: held ? held.n : 0,
          unfulfilledCount: unfulfilled ? unfulfilled.n : 0,
        });
        return json({ alerts });
      }
      if (body.type === 'check-breaker') {
        return json(await checkBreaker(db));
      }
      return json({ error: 'unknown_task' }, 400);
    }

    // Bot 心跳：每 5 分钟报一次到，断了超过 10 分钟下单接口就 503。
    if (request.method === 'POST' && url.pathname === '/v1/bot/heartbeat') {
      await setConfig(db, 'last_bot_heartbeat', String(Date.now()));
      return json({ ok: true });
    }

    if (url.pathname.startsWith('/v1/admin/')) {
      return handleAdmin(request, db, env);
    }

    return json({ error: 'not_found' }, 404);
  },

  // 定时任务（每天 02:00 UTC，见 wrangler.toml）：对账 + 清限流表 + 熔断检查。
  async scheduled(event, env, ctx) {
    const db = env.DB;
    ctx.waitUntil((async () => {
      const report = await runReconcile(db, env.STRIPE_SECRET_KEY);
      await audit(db, { actor: 'devin-bot', action: 'nightly_reconcile', detail: JSON.stringify(report) });
      await cleanupRateLimits(db);
      await checkBreaker(db);
    })());
  },
};
