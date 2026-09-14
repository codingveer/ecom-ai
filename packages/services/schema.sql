-- Neu.Tail M4 backend data foundation.
-- Only the `services` process ever opens this file. Agents reach it through tool contracts.
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS loyalty_accounts;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS size_charts;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS returns;
DROP TABLE IF EXISTS fit_profiles;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS feature_usage;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS context_store;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  city TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  annual_spend_gbp REAL NOT NULL,
  avg_unit_price_gbp REAL NOT NULL,
  premium_share REAL NOT NULL,
  consent_fit INTEGER NOT NULL,
  consent_marketing INTEGER NOT NULL,
  seed_persona TEXT
);

CREATE TABLE loyalty_accounts (
  customer_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  points_balance INTEGER NOT NULL,
  lifetime_points INTEGER NOT NULL,
  engagement_score REAL NOT NULL,
  points_to_next_tier INTEGER NOT NULL
);

CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT NOT NULL,
  price_gbp REAL NOT NULL,
  price_tier TEXT NOT NULL,
  colour TEXT NOT NULL,
  material TEXT NOT NULL,
  style_tags TEXT NOT NULL,
  cut TEXT NOT NULL,
  rating REAL NOT NULL,
  return_rate REAL NOT NULL
);

CREATE TABLE inventory (
  sku TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER NOT NULL,
  PRIMARY KEY (sku, size)
);

CREATE TABLE size_charts (
  brand TEXT NOT NULL, category TEXT NOT NULL, size TEXT NOT NULL,
  bust_cm REAL, waist_cm REAL, hip_cm REAL, grading_tolerance_cm REAL NOT NULL,
  PRIMARY KEY (brand, category, size)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, placed_at TEXT NOT NULL,
  channel TEXT NOT NULL, total_gbp REAL NOT NULL
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  sku TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER NOT NULL, price_gbp REAL NOT NULL
);

CREATE TABLE returns (
  id TEXT PRIMARY KEY, order_item_id TEXT NOT NULL, order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL, sku TEXT NOT NULL, size TEXT NOT NULL,
  returned_at TEXT NOT NULL, reason_code TEXT NOT NULL, reason_detail TEXT
);

CREATE TABLE fit_profiles (
  customer_id TEXT NOT NULL, category TEXT NOT NULL,
  preferred_size TEXT NOT NULL, fit_preference TEXT NOT NULL,
  bust_cm REAL, waist_cm REAL, hip_cm REAL,
  observations INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, category)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL
);

CREATE TABLE feature_usage (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, feature TEXT NOT NULL,
  session_id TEXT NOT NULL, used_at TEXT NOT NULL, value_signal TEXT
);

CREATE TABLE subscriptions (
  customer_id TEXT PRIMARY KEY, tier TEXT NOT NULL, price_gbp_month REAL NOT NULL,
  started_at TEXT, last_offer_at TEXT, offers_declined INTEGER NOT NULL DEFAULT 0
);

-- Long-term (cross-session) agent memory, written back through the Customer 360 service.
CREATE TABLE context_store (
  customer_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, key)
);

CREATE INDEX idx_items_customer ON order_items(customer_id);
CREATE INDEX idx_returns_customer ON returns(customer_id);
CREATE INDEX idx_events_customer ON events(customer_id);
CREATE INDEX idx_products_cat ON products(category);
