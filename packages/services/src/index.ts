/**
 * Backend Service APIs - Worker #1.
 *
 * This is the ONLY Worker in the deployment with a D1 binding. Look at the other
 * three wrangler.jsonc files: none of them declare a database. On Workers the
 * "agents cannot reach the data" claim is enforced by the platform's capability
 * model, not by developer discipline.
 */
import { Hono } from 'hono';

type Env = { DB: D1Database; AI: Ai; VECTORS: VectorizeIndex };
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const app = new Hono<{ Bindings: Env }>();
const nowIso = () => new Date().toISOString();
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------- Customer 360
app.get('/customers/:id', async c => {
  const row = await c.env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(c.req.param('id')).first();
  return row ? c.json(row) : c.json({ error: 'customer_not_found' }, 404);
});

app.get('/customers/:id/profile', async c => {
  const id = c.req.param('id');
  const [cust, loyalty, sub, tx, premium, rets, fitRets] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id),
    c.env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`SELECT * FROM subscriptions WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`
      SELECT COUNT(DISTINCT o.id) orders, COUNT(i.id) items,
             COALESCE(SUM(i.price_gbp),0) spend, COALESCE(AVG(i.price_gbp),0) aup,
             MIN(o.placed_at) first_order, MAX(o.placed_at) last_order
      FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.customer_id = ?`).bind(id),
    c.env.DB.prepare(`
      SELECT COUNT(*) n FROM order_items i JOIN products p ON p.sku = i.sku
      WHERE i.customer_id = ? AND p.price_tier IN ('premium','core')`).bind(id),
    c.env.DB.prepare(`SELECT COUNT(*) n FROM returns WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`SELECT COUNT(*) n FROM returns WHERE customer_id = ? AND reason_code='size_fit'`).bind(id),
  ]);

  const cu = cust.results?.[0] as any;
  if (!cu) return c.json({ error: 'customer_not_found' }, 404);
  const t = (tx.results?.[0] ?? {}) as any;
  const items = Number(t.items ?? 0);
  const pn = Number((premium.results?.[0] as any)?.n ?? 0);
  const rn = Number((rets.results?.[0] as any)?.n ?? 0);
  const fn = Number((fitRets.results?.[0] as any)?.n ?? 0);

  return c.json({
    identity: {
      id: cu.id, name: cu.name, email: cu.email, city: cu.city, joined_at: cu.joined_at,
      tenure_days: Math.round((Date.now() - new Date(cu.joined_at).getTime()) / 864e5),
    },
    consent: { fit_data: !!cu.consent_fit, marketing: !!cu.consent_marketing },
    loyalty: loyalty.results?.[0] ?? null,
    subscription: sub.results?.[0] ?? null,
    transactions: {
      orders: Number(t.orders ?? 0), items,
      spend_gbp: r2(Number(t.spend ?? 0)), avg_unit_price_gbp: r2(Number(t.aup ?? 0)),
      premium_item_share: items ? r2(pn / items) : 0,
      first_order: t.first_order ?? null, last_order: t.last_order ?? null,
    },
    returns: { total: rn, fit_related: fn, rate: items ? Math.round((rn / items) * 1000) / 1000 : 0 },
    declared: {
      annual_spend_gbp: cu.annual_spend_gbp, avg_unit_price_gbp: cu.avg_unit_price_gbp,
      premium_share: cu.premium_share,
    },
  });
});

app.get('/customers/:id/orders', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT o.id, o.placed_at, o.channel, o.total_gbp,
           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) line_count
    FROM orders o WHERE o.customer_id = ? ORDER BY o.placed_at DESC LIMIT ?`)
    .bind(c.req.param('id'), Number(c.req.query('limit') ?? 20)).all();
  return c.json(results);
});

app.get('/customers/:id/returns', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT r.id, r.sku, r.size, r.returned_at, r.reason_code, r.reason_detail, p.category, p.brand, p.cut
    FROM returns r JOIN products p ON p.sku = r.sku
    WHERE r.customer_id = ? ORDER BY r.returned_at DESC LIMIT 50`).bind(c.req.param('id')).all();
  return c.json(results);
});

app.get('/customers/:id/events', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT id, occurred_at, type, payload FROM events
    WHERE customer_id = ? ORDER BY occurred_at DESC LIMIT ?`)
    .bind(c.req.param('id'), Number(c.req.query('limit') ?? 40)).all();
  return c.json((results as any[]).map(r => ({ ...r, payload: JSON.parse(r.payload) })));
});

app.post('/events', async c => {
  const { customer_id, type, payload } = await c.req.json<any>();
  const id = `EV-RT-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  await c.env.DB.prepare(`INSERT INTO events (id,customer_id,occurred_at,type,payload) VALUES (?,?,?,?,?)`)
    .bind(id, customer_id, nowIso(), type, JSON.stringify(payload ?? {})).run();
  return c.json({ id, recorded: true });
});

// ---------------------------------------------------------- Catalogue
async function lexicalSearch(env: Env, terms: string[], category: string | null, limit: number) {
  const stmt = category
    ? env.DB.prepare(`
        SELECT p.*, COALESCE((SELECT SUM(qty) FROM inventory v WHERE v.sku = p.sku),0) stock
        FROM products p WHERE p.category = ?`).bind(category)
    : env.DB.prepare(`
        SELECT p.*, COALESCE((SELECT SUM(qty) FROM inventory v WHERE v.sku = p.sku),0) stock FROM products p`);
  const { results } = await stmt.all();

  return (results as any[]).map(r => {
    const hay = `${r.title} ${r.category} ${r.style_tags} ${r.material} ${r.colour}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += 2;
      if (String(r.category).toLowerCase().startsWith(t.replace(/e?s$/, ''))) score += 3;
      if (String(r.style_tags).toLowerCase().includes(t)) score += 2;
    }
    return { ...r, relevance: score };
  }).filter(r => (terms.length === 0 ? true : r.relevance > 0) && r.stock > 0)
    .sort((a, b) => b.relevance - a.relevance || b.rating - a.rating)
    .slice(0, limit);
}

async function semanticSearch(env: Env, q: string, category: string | null, limit: number) {
  const embedded = await env.AI.run(EMBED_MODEL as any, { text: [q] }) as any;
  const vector = embedded.data[0] as number[];
  const topK = Math.min(limit * 3, 100);
  const matches = await env.VECTORS.query(vector, {
    // The boolean form (`returnMetadata: false`) mis-serializes through wrangler's
    // remote-bindings proxy into invalid JSON for the real Vectorize API (VECTOR_QUERY_ERROR
    // code 40026, "expected value" at the returnMetadata key) - the string-enum form doesn't.
    topK, returnMetadata: 'none',
    filter: category ? { category } : undefined,
  });
  const ids = matches.matches.map(m => m.id);
  if (!ids.length) return [];

  const stmt = env.DB.prepare(`
    SELECT p.*, COALESCE((SELECT SUM(qty) FROM inventory v WHERE v.sku = p.sku),0) stock
    FROM products p WHERE p.sku IN (${ids.map(() => '?').join(',')})`).bind(...ids);
  const { results } = await stmt.all();

  const scoreBySku = new Map(matches.matches.map(m => [m.id, m.score]));
  return (results as any[])
    .map(r => ({ ...r, relevance: r2((scoreBySku.get(r.sku) ?? 0) * 10) }))
    .filter(r => r.stock > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

app.get('/catalogue/search', async c => {
  const q = (c.req.query('q') ?? '').toLowerCase().trim();
  const category = c.req.query('category') ?? null;
  const limit = Number(c.req.query('limit') ?? 40);
  const terms = q.split(/\s+/).filter(Boolean);
  const searchMode = c.req.query('searchMode') === 'semantic' ? 'semantic' : 'lexical';

  if (searchMode === 'semantic') {
    try {
      const results = await semanticSearch(c.env, q, category, limit);
      if (!results.length) {
        const fallback = await lexicalSearch(c.env, terms, category, limit);
        return c.json({
          query: q, candidates: fallback.length, results: fallback, mode: 'lexical', degraded: true,
          degraded_reason: 'no vector matches',
        });
      }
      return c.json({ query: q, candidates: results.length, results, mode: 'semantic' });
    } catch (err) {
      const results = await lexicalSearch(c.env, terms, category, limit);
      return c.json({
        query: q, candidates: results.length, results, mode: 'lexical', degraded: true,
        degraded_reason: err instanceof Error ? err.message : 'semantic search unavailable',
      });
    }
  }

  const results = await lexicalSearch(c.env, terms, category, limit);
  return c.json({ query: q, candidates: results.length, results, mode: 'lexical' });
});

app.post('/catalogue/reindex', async c => {
  const { results } = await c.env.DB.prepare(`SELECT sku, category, description FROM products`).all();
  const rows = results as { sku: string; category: string; description: string }[];

  const EMBED_BATCH = 20;
  const UPSERT_BATCH = 200;
  const toUpsert: VectorizeVector[] = [];

  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const chunk = rows.slice(i, i + EMBED_BATCH);
    const embedded = await c.env.AI.run(EMBED_MODEL as any, { text: chunk.map(r => r.description) }) as any;
    const vectors: number[][] = embedded.data;
    chunk.forEach((r, idx) => toUpsert.push({ id: r.sku, values: vectors[idx], metadata: { category: r.category } }));
  }

  for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH) {
    await c.env.VECTORS.upsert(toUpsert.slice(i, i + UPSERT_BATCH));
  }

  return c.json({ indexed: toUpsert.length });
});

app.get('/catalogue/trending/:category', async c => {
  const days = Number(c.req.query('days') ?? 30);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { results } = await c.env.DB.prepare(`
    SELECT p.sku, p.title, p.brand, p.price_gbp, p.price_tier, COUNT(i.id) units
    FROM products p JOIN order_items i ON i.sku = p.sku JOIN orders o ON o.id = i.order_id
    WHERE p.category = ? AND o.placed_at >= ?
    GROUP BY p.sku ORDER BY units DESC, p.rating DESC LIMIT 10`).bind(c.req.param('category'), since).all();
  return c.json({ category: c.req.param('category'), window_days: days, trending: results });
});

app.get('/catalogue/:sku', async c => {
  const row = await c.env.DB.prepare(`SELECT * FROM products WHERE sku = ?`).bind(c.req.param('sku')).first();
  return row ? c.json(row) : c.json({ error: 'sku_not_found' }, 404);
});

app.get('/inventory/:sku', async c => {
  const { results } = await c.env.DB.prepare(`SELECT size, qty FROM inventory WHERE sku = ?`).bind(c.req.param('sku')).all();
  return c.json({ sku: c.req.param('sku'), sizes: results });
});

app.get('/size-charts/:brand/:category', async c => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM size_charts WHERE brand = ? AND category = ?`)
    .bind(c.req.param('brand'), c.req.param('category')).all();
  if (!results.length) return c.json({ error: 'chart_not_found' }, 404);
  return c.json({ brand: c.req.param('brand'), category: c.req.param('category'), grading: results });
});

// ---------------------------------------------------------- Fit
app.get('/fit/:customerId', async c => {
  const id = c.req.param('customerId');
  const [cust, profiles, fitReturns] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT consent_fit FROM customers WHERE id = ?`).bind(id),
    c.env.DB.prepare(`SELECT * FROM fit_profiles WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`
      SELECT r.sku, r.size, r.reason_detail, p.category, p.brand, p.cut
      FROM returns r JOIN products p ON p.sku = r.sku
      WHERE r.customer_id = ? AND r.reason_code = 'size_fit' ORDER BY r.returned_at DESC LIMIT 20`).bind(id),
  ]);
  const cu = cust.results?.[0] as any;
  if (!cu) return c.json({ error: 'customer_not_found' }, 404);
  return c.json({ customer_id: id, consent_fit: !!cu.consent_fit, profiles: profiles.results, fit_returns: fitReturns.results });
});

app.post('/fit/:customerId/observation', async c => {
  const id = c.req.param('customerId');
  const { category, preferred_size, fit_preference } = await c.req.json<any>();
  const existing = await c.env.DB.prepare(`SELECT observations FROM fit_profiles WHERE customer_id=? AND category=?`)
    .bind(id, category).first();
  if (existing) {
    await c.env.DB.prepare(`UPDATE fit_profiles SET preferred_size=?, observations=observations+1, updated_at=? WHERE customer_id=? AND category=?`)
      .bind(preferred_size, nowIso(), id, category).run();
  } else {
    await c.env.DB.prepare(`INSERT INTO fit_profiles (customer_id,category,preferred_size,fit_preference,observations,updated_at) VALUES (?,?,?,?,1,?)`)
      .bind(id, category, preferred_size, fit_preference ?? 'regular', nowIso()).run();
  }
  return c.json({ recorded: true });
});

// ---------------------------------------------------------- Loyalty
app.get('/loyalty/:customerId', async c => {
  const row = await c.env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE customer_id = ?`).bind(c.req.param('customerId')).first();
  return row ? c.json(row) : c.json({ error: 'account_not_found' }, 404);
});

app.post('/loyalty/:customerId/accrue', async c => {
  const id = c.req.param('customerId');
  const { base_points, multiplier = 1, reason = 'purchase' } = await c.req.json<any>();
  const a = await c.env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE customer_id = ?`).bind(id).first<any>();
  if (!a) return c.json({ error: 'account_not_found' }, 404);
  const awarded = Math.round(Number(base_points) * Number(multiplier));
  const lifetime = a.lifetime_points + awarded;
  const tier = lifetime > 9000 ? 'Platinum' : lifetime > 4500 ? 'Gold' : lifetime > 1500 ? 'Silver' : 'Bronze';
  const next = tier === 'Platinum' ? lifetime : tier === 'Gold' ? 9000 : tier === 'Silver' ? 4500 : 1500;
  await c.env.DB.prepare(`UPDATE loyalty_accounts SET points_balance=?, lifetime_points=?, tier=?, points_to_next_tier=?, engagement_score=? WHERE customer_id=?`)
    .bind(a.points_balance + awarded, lifetime, tier, Math.max(0, next - lifetime), Math.min(1, a.engagement_score + 0.02), id).run();
  return c.json({
    awarded, multiplier, reason, balance: a.points_balance + awarded, tier,
    tier_changed: tier !== a.tier, points_to_next_tier: Math.max(0, next - lifetime),
    liability_gbp: r2(awarded * 0.01),
  });
});

app.post('/loyalty/:customerId/redeem', async c => {
  const id = c.req.param('customerId');
  const { points } = await c.req.json<any>();
  if (!(Number(points) > 0)) return c.json({ error: 'points must be a positive number' }, 400);
  const a = await c.env.DB.prepare(`SELECT * FROM loyalty_accounts WHERE customer_id = ?`).bind(id).first<any>();
  if (!a) return c.json({ error: 'account_not_found' }, 404);
  if (a.points_balance < points) return c.json({ redeemed: false, shortfall: points - a.points_balance, balance: a.points_balance });
  await c.env.DB.prepare(`UPDATE loyalty_accounts SET points_balance=? WHERE customer_id=?`).bind(a.points_balance - points, id).run();
  return c.json({ redeemed: true, balance: a.points_balance - points, liability_released_gbp: r2(points * 0.01) });
});

// ---------------------------------------------------------- Subscription & usage
app.get('/subscriptions/:customerId', async c => {
  const row = await c.env.DB.prepare(`SELECT * FROM subscriptions WHERE customer_id = ?`).bind(c.req.param('customerId')).first();
  return c.json(row ?? { customer_id: c.req.param('customerId'), tier: 'free', price_gbp_month: 0 });
});

app.post('/subscriptions/:customerId', async c => {
  const id = c.req.param('customerId');
  const { tier } = await c.req.json<any>();
  const price = tier === 'plus' ? 4.99 : tier === 'premium' ? 9.99 : 0;
  await c.env.DB.prepare(`UPDATE subscriptions SET tier=?, price_gbp_month=?, started_at=? WHERE customer_id=?`)
    .bind(tier, price, nowIso(), id).run();
  return c.json({ customer_id: id, tier, price_gbp_month: price, entitlement_active: true });
});

app.get('/usage/:customerId', async c => {
  const id = c.req.param('customerId');
  const feature = c.req.query('feature') ?? null;
  const stmt = feature
    ? c.env.DB.prepare(`SELECT * FROM feature_usage WHERE customer_id = ? AND feature = ? ORDER BY used_at DESC`).bind(id, feature)
    : c.env.DB.prepare(`SELECT * FROM feature_usage WHERE customer_id = ? ORDER BY used_at DESC`).bind(id);
  const [usage, sub] = await c.env.DB.batch([stmt, c.env.DB.prepare(`SELECT * FROM subscriptions WHERE customer_id = ?`).bind(id)]);
  const rows = usage.results as any[];
  const s = sub.results?.[0] as any;
  return c.json({
    customer_id: id, entitlement: s?.tier ?? 'free',
    sessions: new Set(rows.map(r => r.session_id)).size,
    value_signals: rows.filter(r => r.value_signal).map(r => r.value_signal),
    usage: rows, last_offer_at: s?.last_offer_at ?? null, offers_declined: s?.offers_declined ?? 0,
  });
});

app.post('/usage/:customerId/offer-shown', async c => {
  await c.env.DB.prepare(`UPDATE subscriptions SET last_offer_at=? WHERE customer_id=?`)
    .bind(nowIso(), c.req.param('customerId')).run();
  return c.json({ recorded: true });
});

// ---------------------------------------------------------- Long-term context
app.get('/context/:customerId', async c => {
  const { results } = await c.env.DB.prepare(`SELECT key, value, updated_at FROM context_store WHERE customer_id = ?`)
    .bind(c.req.param('customerId')).all();
  return c.json(Object.fromEntries((results as any[]).map(r => [r.key, { value: JSON.parse(r.value), updated_at: r.updated_at }])));
});

app.post('/context/:customerId', async c => {
  const { key, value } = await c.req.json<any>();
  await c.env.DB.prepare(`
    INSERT INTO context_store (customer_id,key,value,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(customer_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(c.req.param('customerId'), key, JSON.stringify(value), nowIso()).run();
  return c.json({ written: true, key });
});

// ---------------------------------------------------------- Analytics
app.get('/analytics/return-rate', async c => {
  const [items, rets, mix] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) n FROM order_items`),
    c.env.DB.prepare(`SELECT COUNT(*) n FROM returns`),
    c.env.DB.prepare(`SELECT reason_code, COUNT(*) n FROM returns GROUP BY reason_code`),
  ]);
  const i = Number((items.results?.[0] as any).n);
  const r = Number((rets.results?.[0] as any).n);
  const m = mix.results as any[];
  return c.json({
    order_items: i, returns: r, return_rate: Math.round((r / i) * 1000) / 10,
    reason_mix: Object.fromEntries(m.map(x => [x.reason_code, Math.round((x.n / r) * 1000) / 10])),
    points_of_34: Object.fromEntries(m.map(x => [x.reason_code, Math.round((x.n / i) * 1000) / 10])),
  });
});

app.get('/analytics/fit-coverage', async c => {
  const [total, withFit, consented] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) n FROM customers`),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT customer_id) n FROM fit_profiles`),
    c.env.DB.prepare(`SELECT COUNT(*) n FROM customers WHERE consent_fit = 1`),
  ]);
  const t = Number((total.results?.[0] as any).n), w = Number((withFit.results?.[0] as any).n);
  return c.json({ customers: t, with_fit_profile: w, consented: Number((consented.results?.[0] as any).n),
    coverage: Math.round((w / t) * 1000) / 10 });
});

app.get('/health', c => c.json({ ok: true, service: 'services', platform: 'cloudflare-workers+d1' }));

export default app;
