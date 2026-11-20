// 共享小工具：JSON 响应、config 表读写、审计日志、kill switch 状态。
// 被 index.js / fulfill.js / bot.js / admin.js 共用。

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function getConfig(db, key) {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setConfig(db, key, value) {
  await db.prepare(
    'INSERT INTO config (key, value, updated_at) VALUES (?, ?, unixepoch()) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()'
  ).bind(key, value).run();
}

// 每一次状态变化都记一条，actor 只能是 system / devin-bot / admin。
export async function audit(db, { orderId = null, cardId = null, actor, action, detail = '' }) {
  await db.prepare(
    'INSERT INTO audit_log (order_id, card_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())'
  ).bind(orderId, cardId, actor, action, detail).run();
}

export async function killSwitchOn(db) {
  return (await getConfig(db, 'kill_switch')) === 'on';
}

export async function heartbeatStale(db, staleAfterMs = 10 * 60 * 1000) {
  const last = Number(await getConfig(db, 'last_bot_heartbeat')) || 0;
  return Date.now() - last > staleAfterMs;
}
