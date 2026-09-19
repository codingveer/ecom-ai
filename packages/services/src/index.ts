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
      WHERE i.customer_id = ? AND p.price_tier = 'premium'`).bind(id),
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
      shops_for: cu.shops_for,
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

// ---------------------------------------------------------- Customer admin (read-only)
app.get('/admin/customers', async c => {
  const q = (c.req.query('q') ?? '').trim();
  const city = c.req.query('city') || null;
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize') ?? 50)));

  const conditions: string[] = [];
  const binds: string[] = [];
  if (q) { conditions.push('(id LIKE ? OR name LIKE ? OR email LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (city) { conditions.push('city = ?'); binds.push(city); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) n FROM customers ${where}`).bind(...binds),
    c.env.DB.prepare(`
      SELECT c.id, c.name, c.email, c.city, c.joined_at, l.tier, l.points_balance,
             c.annual_spend_gbp
      FROM customers c LEFT JOIN loyalty_accounts l ON l.customer_id = c.id
      ${where} ORDER BY c.id LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, (page - 1) * pageSize),
  ]);

  return c.json({ page, pageSize, total: Number((count.results?.[0] as any).n), results: rows.results });
});

app.get('/admin/customers/:id/full', async c => {
  const id = c.req.param('id');
  const [cust, loyalty, sub, tx, premium, rets, fitRets, fitProfiles, context, orders, returns, events] = await c.env.DB.batch([
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
      WHERE i.customer_id = ? AND p.price_tier = 'premium'`).bind(id),
    c.env.DB.prepare(`SELECT COUNT(*) n FROM returns WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`SELECT COUNT(*) n FROM returns WHERE customer_id = ? AND reason_code='size_fit'`).bind(id),
    c.env.DB.prepare(`SELECT category, preferred_size, fit_preference, observations, updated_at FROM fit_profiles WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`SELECT key, value, updated_at FROM context_store WHERE customer_id = ? ORDER BY updated_at DESC`).bind(id),
    c.env.DB.prepare(`SELECT id, placed_at, channel, total_gbp FROM orders WHERE customer_id = ? ORDER BY placed_at DESC LIMIT 20`).bind(id),
    c.env.DB.prepare(`SELECT id, sku, size, returned_at, reason_code, reason_detail FROM returns WHERE customer_id = ? ORDER BY returned_at DESC LIMIT 20`).bind(id),
    c.env.DB.prepare(`SELECT id, occurred_at, type, payload FROM events WHERE customer_id = ? ORDER BY occurred_at DESC LIMIT 20`).bind(id),
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
      shops_for: cu.shops_for, height_cm: cu.height_cm, weight_kg: cu.weight_kg, age: cu.age,
      seed_persona: cu.seed_persona,
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
    fit_profiles: fitProfiles.results,
    context_store: context.results,
    recent_orders: orders.results,
    recent_returns: returns.results,
    recent_events: (events.results as any[]).map(e => ({ ...e, payload: JSON.parse(e.payload) })),
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
const STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'is', 'are', 'am', 'was', 'be', 'have', 'has', 'do', 'does', 'it', 'its',
  'this', 'that', 'some', 'need', 'want', 'get', 'me', 'my', 'we', 'our', 'you', 'your',
  'looking', 'find', 'show', 'me', 'please', 'something', 'give', 'any',
]);

const SYNONYMS: Record<string, string[]> = {
  warm: ['wool', 'knitwear', 'sweater', 'coat', 'jacket', 'thermal', 'fleece', 'outerwear'],
  cosy: ['wool', 'knitwear', 'sweater', 'fleece'],
  cozy: ['wool', 'knitwear', 'sweater', 'fleece'],
  cold: ['coat', 'jacket', 'knitwear', 'thermal', 'outerwear'],
  winter: ['coat', 'jacket', 'knitwear', 'thermal', 'outerwear'],
  summer: ['linen', 'cotton', 'floral', 'light'],
  smart: ['formal', 'workwear', 'office'],
  casual: ['everyday', 'relaxed'],
  office: ['workwear', 'formal', 'blazer', 'trouser'],
  clothes: ['top', 'dress', 'trouser', 'skirt', 'jacket', 'knitwear'],
  clothing: ['top', 'dress', 'trouser', 'skirt', 'jacket', 'knitwear'],
};

function expandTerms(raw: string[]): string[] {
  const out = new Set(raw);
  for (const t of raw) {
    const syns = SYNONYMS[t];
    if (syns) syns.forEach(s => out.add(s));
  }
  return [...out];
}

function buildQualifyingTerms(rawTerms: string[]): Set<string> {
  const isWildcardOnly = rawTerms.length > 0 && rawTerms.every(t => t === 'clothes' || t === 'clothing');
  if (isWildcardOnly || rawTerms.length === 0) {
    return new Set(expandTerms(rawTerms));
  }
  const qualifying = new Set<string>();
  for (const t of rawTerms) {
    if (t !== 'clothes' && t !== 'clothing') {
      qualifying.add(t);
      const syns = SYNONYMS[t];
      if (syns) syns.forEach(s => qualifying.add(s));
    }
  }
  return qualifying;
}

// The seeded catalogue (scripts/lib/fashion-catalog.ts) only covers three departments -
// women, men, unisex - and eight adult categories. There is no kids/baby range at all, in
// either the lexical field data or whatever Vectorize indexed from it. A query naming that
// age group can't be answered by tuning match scores or similarity floors - no amount of
// embedding-similarity slack makes an adult top a baby garment - so it's called out here as
// a deterministic short-circuit before either search path runs, rather than letting a vector
// query's "nearest, however distant" neighbours quietly stand in for a real match.
const OUT_OF_CATALOGUE_TERMS = new Set([
  'baby', 'babies', 'infant', 'infants', 'newborn', 'newborns',
  'toddler', 'toddlers', 'kid', 'kids', 'child', 'children',
]);

// Word-boundary containment, not raw substring - a plain `includes` lets a term like
// "men" match inside "women's" (brand text such as "DUKE WOMEN'S ...") and inflates
// scores for the wrong department entirely. A trailing (')s/es is allowed on the hay
// side only, so "short" still matches "Shorts" and "dress" still matches "Dresses" -
// the boundary must hold at the *start* of the word, which is what actually rules out
// "men" landing inside "women's".
function hasWord(hay: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}('s|es|s)?\\b`).test(hay);
}

// Any positive score already means a genuine word-boundary hit somewhere (title,
// category, or style tags) now that `hasWord` replaces raw substring matching - a
// higher floor sounds safer but actually discards real single-word matches (e.g. a
// query term that only lands in the title, worth 2, not the category, worth 3). The
// floor stays at "some real match happened", not an arbitrary point total.
const MIN_RELEVANCE = 1;
// Vectorize always returns its topK nearest neighbours, however distant - a query with
// nothing genuinely close in the index still gets back "matches" that are just the
// least-dissimilar vectors. Require a real similarity floor so an off-catalogue query
// (no vector match, similarity or otherwise) contributes nothing rather than noise.
// Calibrated empirically against this catalogue's embeddings, not a general constant:
// gibberish and off-topic queries ("quantum physics homework help") top out around
// 0.53-0.60 here, while genuine matches - even vague, style-based ones like "a weekend
// brunch outfit that feels effortless" - start around 0.67. 0.64 sits in that gap with
// margin on both sides; a fixed cutoff much higher (e.g. 0.72, tuned only against
// concrete noun queries like "warm winter coat") wrongly excludes the vaguer-but-real ones.
const MIN_SIMILARITY = 0.64;
// Soft ceiling used only to normalise a lexical point-total onto the same 0-1 scale as
// Vectorize's cosine similarity before blending the two in hybridSearch - not a cutoff.
const LEXICAL_SCORE_CEILING = 10;

function scoreLexical(r: any, rawTerms: string[], expanded: string[], qualifyingTerms: Set<string>, isWildcardBrowse: boolean) {
  const hay = `${r.title} ${r.category} ${r.style_tags} ${r.material} ${r.colour}`.toLowerCase();
  const styleTags = String(r.style_tags).toLowerCase();
  let score = 0;
  let literalHit = rawTerms.length === 0 || isWildcardBrowse;
  for (const t of expanded) {
    const hayHit = hasWord(hay, t);
    const catHit = String(r.category).toLowerCase().startsWith(t.replace(/e?s$/, ''));
    const tagHit = hasWord(styleTags, t);
    if (hayHit) score += 2;
    if (catHit) score += 3;
    if (tagHit) score += 2;
    if ((hayHit || catHit || tagHit) && qualifyingTerms.has(t)) literalHit = true;
  }
  return { score, literalHit };
}

async function fetchCandidateRows(env: Env, category: string | null, department: string | undefined) {
  const conditions: string[] = [];
  const binds: string[] = [];
  if (category) { conditions.push('p.category = ?'); binds.push(category); }
  if (department && department !== 'unisex') {
    conditions.push("(p.department = ? OR p.department = 'unisex')");
    binds.push(department);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = env.DB.prepare(`
    SELECT p.*, COALESCE((SELECT SUM(qty) FROM inventory v WHERE v.sku = p.sku),0) stock
    FROM products p ${where}`).bind(...binds);
  const { results } = await stmt.all();
  return results as any[];
}

async function lexicalSearch(env: Env, rawTerms: string[], category: string | null, department: string | undefined, limit: number) {
  const rows = await fetchCandidateRows(env, category, department);
  const expanded = expandTerms(rawTerms);
  const isWildcardBrowse = rawTerms.length > 0 && rawTerms.every(t => t === 'clothes' || t === 'clothing');
  const qualifyingTerms = buildQualifyingTerms(rawTerms);

  return rows.map(r => {
    const { score, literalHit } = scoreLexical(r, rawTerms, expanded, qualifyingTerms, isWildcardBrowse);
    const relevance = literalHit && score >= MIN_RELEVANCE ? score + Number(r.relevance_boost ?? 0) : score;
    return { ...r, relevance, literalHit };
  }).filter(r => r.literalHit && r.relevance >= MIN_RELEVANCE && r.stock > 0)
    .sort((a, b) => b.relevance - a.relevance || b.rating - a.rating)
    .slice(0, limit);
}

async function queryVectorMatches(env: Env, q: string, category: string | null, limit: number) {
  const embedded = await env.AI.run(EMBED_MODEL as any, { text: [q] }) as any;
  const vector = embedded.data[0] as number[];
  // Capped at 99, not 100: D1 caps bound parameters per statement at 100, and any
  // hydration query binds one `?` per id plus one more for an optional department
  // filter - 100 ids would leave no room for that extra bind and throw D1_ERROR
  // "too many SQL variables".
  const topK = Math.min(limit * 5, 99);
  const matches = await env.VECTORS.query(vector, {
    // The boolean form (`returnMetadata: false`) mis-serializes through wrangler's
    // remote-bindings proxy into invalid JSON for the real Vectorize API (VECTOR_QUERY_ERROR
    // code 40026, "expected value" at the returnMetadata key) - the string-enum form doesn't.
    topK, returnMetadata: 'none',
    // department isn't in the Vectorize metadata index (only category is), so it's applied
    // at D1 hydration instead, same as lexicalSearch does.
    filter: category ? { category } : undefined,
  });
  return matches.matches;
}

// Blends lexical keyword scoring with semantic (embedding) similarity into one ranked
// list, instead of picking one retrieval method and using the other only as a fallback.
// A product qualifies if EITHER signal genuinely supports it (a real word match, or a
// strong vector similarity) - the two scores are then combined so a product both signals
// agree on outranks one only one signal likes. This also means a synonym-only lexical
// match (e.g. "warm" -> "outerwear" with no literal hit) can still surface a product if
// the embedding independently thinks it's a strong match, and vice versa.
async function hybridSearch(env: Env, rawTerms: string[], q: string, category: string | null, department: string | undefined, limit: number) {
  const [rows, vectorMatches] = await Promise.all([
    fetchCandidateRows(env, category, department),
    queryVectorMatches(env, q, category, limit),
  ]);
  const semanticBySku = new Map(vectorMatches.map(m => [m.id, m.score]));
  const expanded = expandTerms(rawTerms);
  const isWildcardBrowse = rawTerms.length > 0 && rawTerms.every(t => t === 'clothes' || t === 'clothing');
  const qualifyingTerms = buildQualifyingTerms(rawTerms);

  return rows.map(r => {
    const { score: lexicalScore, literalHit } = scoreLexical(r, rawTerms, expanded, qualifyingTerms, isWildcardBrowse);
    const semanticScore = semanticBySku.get(r.sku) ?? 0;
    const qualifies = literalHit || semanticScore >= MIN_SIMILARITY;
    const lexicalNorm = Math.min(1, lexicalScore / LEXICAL_SCORE_CEILING);
    const semanticNorm = Math.max(0, Math.min(1, semanticScore));
    // Blended is 0..1; multiply by LEXICAL_SCORE_CEILING so relevance is calibrated on the
    // same 0..10+ scale as lexicalSearch, allowing discovery ranking to appropriately weight
    // relevance over customer tier weights and minor star rating differences.
    const blended = lexicalNorm * 0.5 + semanticNorm * 0.5;
    const relevance = r2(blended * LEXICAL_SCORE_CEILING + Number(r.relevance_boost ?? 0));
    return { ...r, relevance, qualifies, lexicalScore, semanticScore: r2(semanticScore) };
  }).filter(r => r.qualifies && r.stock > 0)
    .sort((a, b) => b.relevance - a.relevance || b.rating - a.rating)
    .slice(0, limit);
}

app.get('/catalogue/search', async c => {
  const q = (c.req.query('q') ?? '').toLowerCase().trim();
  const category = c.req.query('category') ?? null;
  // 'unisex' means "no department declared" - same as no filter at all.
  const department = c.req.query('department');
  const limit = Number(c.req.query('limit') ?? 40);
  // "t shirt" / "t-shirt" would otherwise split into ["t", "shirt"], dropping "t" (length ≤ 1)
  // and matching every product with "shirt" in the title. Normalise to a single token first.
  const normalizedQ = q.replace(/\bt[\s-]shirt/g, 't-shirt');
  const rawTerms = normalizedQ.split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t));
  const searchMode = c.req.query('searchMode') === 'semantic' ? 'semantic' : 'lexical';

  if (rawTerms.some(t => OUT_OF_CATALOGUE_TERMS.has(t))) {
    return c.json({
      query: q, candidates: 0, results: [], mode: searchMode === 'semantic' ? 'hybrid' : 'lexical',
      degraded: true, degraded_reason: 'no kids/baby department in this catalogue',
    });
  }

  // "AI mode" in the console toggles this on: hybrid blends lexical keyword scoring with
  // embedding similarity instead of picking one and falling back to the other. It only
  // degrades to lexical-only if the embedding/vector call itself fails - a hybrid result
  // that's simply empty means neither signal found anything, and lexical alone wouldn't
  // find more (hybridSearch already includes every product lexicalSearch would return).
  if (searchMode === 'semantic') {
    try {
      const results = await hybridSearch(c.env, rawTerms, q, category, department, limit);
      return c.json({ query: q, candidates: results.length, results, mode: 'hybrid' });
    } catch (err) {
      const results = await lexicalSearch(c.env, rawTerms, category, department, limit);
      return c.json({
        query: q, candidates: results.length, results, mode: 'lexical', degraded: true,
        degraded_reason: err instanceof Error ? err.message : 'hybrid search unavailable',
      });
    }
  }

  const results = await lexicalSearch(c.env, rawTerms, category, department, limit);
  return c.json({ query: q, candidates: results.length, results, mode: 'lexical' });
});

app.post('/catalogue/reindex', async c => {
  try {
    const offset = Number(c.req.query('offset') ?? 0);
    const limit  = Number(c.req.query('limit')  ?? 100);

    const { results } = await c.env.DB.prepare(
      `SELECT sku, category, description FROM products LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    const rows = results as { sku: string; category: string; description: string }[];

    if (!rows.length) return c.json({ indexed: 0, done: true });

    const toUpsert: VectorizeVector[] = [];
    const EMBED_BATCH = 100;
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const chunk = rows.slice(i, i + EMBED_BATCH);
      const embedded = await c.env.AI.run(EMBED_MODEL as any, { text: chunk.map(r => r.description) }) as any;
      const vectors: number[][] = embedded.data;
      chunk.forEach((r, idx) => toUpsert.push({ id: r.sku, values: vectors[idx], metadata: { category: r.category } }));
    }

    await c.env.VECTORS.upsert(toUpsert);

    return c.json({ indexed: toUpsert.length, offset, limit, done: rows.length < limit });
  } catch (e) {
    return c.json({ error: String(e), stack: e instanceof Error ? e.stack : undefined }, 500);
  }
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

// ---------------------------------------------------------- Catalogue admin (tagging)
app.get('/admin/products', async c => {
  const q = (c.req.query('q') ?? '').trim();
  const category = c.req.query('category') || null;
  const department = c.req.query('department') || null;
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize') ?? 50)));

  const conditions: string[] = [];
  const binds: string[] = [];
  if (q) { conditions.push('(sku LIKE ? OR title LIKE ? OR brand LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { conditions.push('category = ?'); binds.push(category); }
  if (department) { conditions.push('department = ?'); binds.push(department); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) n FROM products ${where}`).bind(...binds),
    c.env.DB.prepare(`SELECT * FROM products ${where} ORDER BY sku LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, (page - 1) * pageSize),
  ]);

  return c.json({ page, pageSize, total: Number((count.results?.[0] as any).n), results: rows.results });
});

app.get('/admin/products/:sku', async c => {
  const row = await c.env.DB.prepare(`SELECT * FROM products WHERE sku = ?`).bind(c.req.param('sku')).first();
  return row ? c.json(row) : c.json({ error: 'sku_not_found' }, 404);
});

/** Same template scripts/gen-seed.ts's describeProduct uses at seed time - duplicated here,
 * not imported, because scripts/ runs under Node for codegen and this Worker runs on the
 * Workers runtime. Keeps a retagged SKU's embedded text consistent with a freshly-seeded one. */
function describeProduct(p: { title: string; category: string; brand: string; colour: string; material: string; cut: string; styles: string[] }): string {
  const cutPhrase = p.cut === 'runs_small' ? 'a snug, true-to-body cut'
    : p.cut === 'runs_large' ? 'a relaxed, roomy cut'
    : 'a true-to-size cut';
  const tagPhrase = p.styles.join(', ');
  const article = /^[aeiou]/i.test(p.colour) ? 'An' : 'A';
  return `${article} ${p.colour} ${p.material} ${p.title.toLowerCase()} by ${p.brand}, ${cutPhrase}, `
    + `from the ${p.category} range, tagged ${tagPhrase}.`;
}

const ADMIN_EDITABLE_FIELDS = [
  'category', 'department', 'brand', 'colour', 'material', 'cut', 'style_tags', 'price_tier', 'relevance_boost',
] as const;

app.post('/admin/products/:sku', async c => {
  const sku = c.req.param('sku');
  const existing = await c.env.DB.prepare(`SELECT * FROM products WHERE sku = ?`).bind(sku).first<any>();
  if (!existing) return c.json({ error: 'sku_not_found' }, 404);

  const body = await c.req.json<any>();
  const next = { ...existing };
  for (const field of ADMIN_EDITABLE_FIELDS) {
    if (body[field] !== undefined) next[field] = field === 'relevance_boost' ? Number(body[field]) : String(body[field]).trim();
  }
  if (!Number.isFinite(next.relevance_boost)) return c.json({ error: 'relevance_boost must be a finite number' }, 400);

  const description = describeProduct({
    title: next.title, category: next.category, brand: next.brand, colour: next.colour,
    material: next.material, cut: next.cut,
    styles: String(next.style_tags).split(',').map((s: string) => s.trim()).filter(Boolean),
  });

  await c.env.DB.prepare(`
    UPDATE products SET category=?, department=?, brand=?, colour=?, material=?, cut=?,
      style_tags=?, price_tier=?, relevance_boost=?, description=? WHERE sku=?`)
    .bind(next.category, next.department, next.brand, next.colour, next.material, next.cut,
      next.style_tags, next.price_tier, next.relevance_boost, description, sku).run();

  let reindexed = false;
  let degraded_reason: string | undefined;
  try {
    const embedded = await c.env.AI.run(EMBED_MODEL as any, { text: [description] }) as any;
    await c.env.VECTORS.upsert([{ id: sku, values: embedded.data[0], metadata: { category: next.category } }]);
    reindexed = true;
  } catch (e) {
    degraded_reason = e instanceof Error ? e.message : 'reindex failed';
  }

  return c.json({ sku, updated: true, reindexed, ...(degraded_reason ? { degraded_reason } : {}) });
});

app.get('/inventory/:sku', async c => {
  const { results } = await c.env.DB.prepare(`SELECT size, qty FROM inventory WHERE sku = ?`).bind(c.req.param('sku')).all();
  return c.json({ sku: c.req.param('sku'), sizes: results });
});

app.get('/size-charts/:category', async c => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM size_charts WHERE category = ?`)
    .bind(c.req.param('category')).all();
  if (!results.length) return c.json({ error: 'chart_not_found' }, 404);
  return c.json({ category: c.req.param('category'), grading: results });
});

// ---------------------------------------------------------- Fit
app.get('/fit/:customerId', async c => {
  const id = c.req.param('customerId');
  const [cust, profiles, fitReturns] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT consent_fit, height_cm, weight_kg, age FROM customers WHERE id = ?`).bind(id),
    c.env.DB.prepare(`SELECT * FROM fit_profiles WHERE customer_id = ?`).bind(id),
    c.env.DB.prepare(`
      SELECT r.sku, r.size, r.reason_detail, p.category, p.brand, p.cut
      FROM returns r JOIN products p ON p.sku = r.sku
      WHERE r.customer_id = ? AND r.reason_code = 'size_fit' ORDER BY r.returned_at DESC LIMIT 20`).bind(id),
  ]);
  const cu = cust.results?.[0] as any;
  if (!cu) return c.json({ error: 'customer_not_found' }, 404);
  return c.json({
    customer_id: id, consent_fit: !!cu.consent_fit,
    measurements: { height_cm: cu.height_cm, weight_kg: cu.weight_kg, age: cu.age },
    profiles: profiles.results, fit_returns: fitReturns.results,
  });
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
