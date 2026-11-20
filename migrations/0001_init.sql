-- 0001_init: 核心表
-- 导入：npx wrangler d1 migrations apply card-dispenser --local

-- 一张卡一行，状态只有四种：unsold / locked / issued / refunded
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unsold',
  order_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_sku_status ON cards (sku, status);

-- 订单，stripe_payment_intent 唯一
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_payment_intent TEXT UNIQUE,
  sku TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  buyer_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  risk_score INTEGER DEFAULT 0,
  card_id INTEGER REFERENCES cards(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_fingerprint ON orders (buyer_fingerprint, created_at);

-- 退款记录
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  stripe_refund_id TEXT,
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- 审计日志：每一次状态变化都记一条
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  card_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);

-- 配置表：kill switch 和 bot 心跳就存在这里
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO config (key, value, updated_at)
VALUES ('kill_switch', 'off', unixepoch());
INSERT OR IGNORE INTO config (key, value, updated_at)
VALUES ('last_bot_heartbeat', '0', unixepoch());
