// 幂等键：客户端每次下单带 Idempotency-Key，重试不会重复建单。
// key + 指纹唯一，响应缓存 24 小时，过期后同一 key 可以复用。
export async function getIdempotentResponse(db, key) {
  if (!key) return null;
  const row = await db.prepare(
    'SELECT response_json FROM idempotency_keys WHERE key = ? AND created_at > unixepoch() - 86400'
  ).bind(key).first();
  return row ? JSON.parse(row.response_json) : null;
}

export async function saveIdempotentResponse(db, key, fingerprint, response) {
  if (!key) return;
  await db.prepare(
    'INSERT OR IGNORE INTO idempotency_keys (key, fingerprint, response_json, created_at) VALUES (?, ?, ?, unixepoch())'
  ).bind(key, fingerprint, JSON.stringify(response)).run();
}
