// 限流：D1 做计数，窗口 60 秒。Worker 无常驻内存，计数必须落库，
// 所以只对下单和 bot 任务限流，不对每个读请求限流。
export async function checkRateLimit(db, key, limit, windowSec = 60) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % windowSec);
  const row = await db.prepare(
    'SELECT count FROM rate_limits WHERE key = ? AND window_start = ?'
  ).bind(key, windowStart).first();
  const count = row ? row.count : 0;
  if (count >= limit) return { allowed: false, remaining: 0 };
  await db.prepare(
    'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ' +
    'ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1'
  ).bind(key, windowStart).run();
  return { allowed: true, remaining: limit - count - 1 };
}

// 定时任务每小时清一次过期窗口，表不会无限长。
export async function cleanupRateLimits(db) {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(cutoff).run();
}
