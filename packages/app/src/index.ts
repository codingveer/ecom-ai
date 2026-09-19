/**
 * Demo application - Worker #4.
 *
 * Bindings: two service bindings and a Durable Object namespace. No D1. This Worker
 * physically cannot query the database.
 */
import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';
import { Kernel, Trace, type GatewayBindings } from './kernel.js';

type Env = GatewayBindings & {
  SessionAgent: DurableObjectNamespace; ASSETS: Fetcher; ADMIN_TOKEN?: string;
  AI_ACCESS_KEYS: KVNamespace;
};
const app = new Hono<{ Bindings: Env }>();

app.use('*', agentsMiddleware());

const session = (env: Env, id: string) => env.SessionAgent.get(env.SessionAgent.idFromName(id));

app.post('/session/:id/message', async c => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json', detail: 'request body must be valid JSON' }, 400); }
  if (!body?.customerId || !body?.text) return c.json({ error: 'customerId and text are required' }, 400);
  const r = await session(c.env, c.req.param('id')).fetch('https://session/message', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return new Response(r.body, r);
});

app.get('/session/:id', async c =>
  new Response((await session(c.env, c.req.param('id')).fetch('https://session/state')).body,
    { headers: { 'content-type': 'application/json' } }));

app.post('/session/:id/reset', async c =>
  new Response((await session(c.env, c.req.param('id')).fetch('https://session/reset', { method: 'POST' })).body,
    { headers: { 'content-type': 'application/json' } }));

app.get('/session/:id/credits', async c =>
  new Response((await session(c.env, c.req.param('id')).fetch('https://session/credits')).body,
    { headers: { 'content-type': 'application/json' } }));

// User-facing: "I've hit the limit, please give me more" - just raises a flag an admin
// sees via GET /session/:id/credits (requestedMore). No auth needed, it can't grant
// anything by itself.
app.post('/session/:id/credits/request', async c =>
  new Response((await session(c.env, c.req.param('id')).fetch('https://session/credits/request', { method: 'POST' })).body,
    { headers: { 'content-type': 'application/json' } }));

// Admin-only: actually raises the limit. Gated on a shared secret (wrangler secret put
// ADMIN_TOKEN) since this Worker is what's shared publicly for the demo and an open
// grant endpoint would defeat the whole point of capping token spend.
app.post('/admin/sessions/:id/credits', async c => {
  if (!c.env.ADMIN_TOKEN || c.req.header('x-admin-token') !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const r = await session(c.env, c.req.param('id')).fetch('https://session/credits/grant', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return new Response(r.body, r);
});

/**
 * Admin-managed access keys that gate real AI (vs. the mock default) per session.
 * These are opaque tokens minted here, NOT the real OPENAI_API_KEY - that stays a
 * server-side secret on neutail-llm and is never sent to a browser. A console holding
 * an active token passes it along on every turn (see App.tsx); SessionAgent.handleTurn
 * checks it against this same KV store before letting a turn's Kernel calls override
 * the LLM gateway's mock default (see checkLiveAI in session-do.ts).
 */
const adminAuthed = (c: { req: { header(name: string): string | undefined }; env: Env }) =>
  !!c.env.ADMIN_TOKEN && c.req.header('x-admin-token') === c.env.ADMIN_TOKEN;

app.post('/admin/ai-keys', async c => {
  if (!adminAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const token = crypto.randomUUID();
  const record = { active: true, createdAt: new Date().toISOString() };
  await c.env.AI_ACCESS_KEYS.put(`key:${token}`, JSON.stringify(record));
  return c.json({ token, ...record });
});

app.get('/admin/ai-keys', async c => {
  if (!adminAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const list = await c.env.AI_ACCESS_KEYS.list({ prefix: 'key:' });
  const keys = await Promise.all(list.keys.map(async k => {
    const record = await c.env.AI_ACCESS_KEYS.get<any>(k.name, 'json');
    return { token: k.name.slice('key:'.length), ...record };
  }));
  return c.json({ keys });
});

app.post('/admin/ai-keys/:token/activate', async c => {
  if (!adminAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const kvKey = `key:${c.req.param('token')}`;
  const record = await c.env.AI_ACCESS_KEYS.get<any>(kvKey, 'json');
  if (!record) return c.json({ error: 'not_found' }, 404);
  record.active = true;
  await c.env.AI_ACCESS_KEYS.put(kvKey, JSON.stringify(record));
  return c.json({ token: c.req.param('token'), ...record });
});

app.post('/admin/ai-keys/:token/deactivate', async c => {
  if (!adminAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  const kvKey = `key:${c.req.param('token')}`;
  const record = await c.env.AI_ACCESS_KEYS.get<any>(kvKey, 'json');
  if (!record) return c.json({ error: 'not_found' }, 404);
  record.active = false;
  await c.env.AI_ACCESS_KEYS.put(kvKey, JSON.stringify(record));
  return c.json({ token: c.req.param('token'), ...record });
});

/**
 * Modelled business outcome, computed from the live corpus rather than asserted.
 * Mirrors the M3 slide 19 decomposition, including the levers the assistant cannot pull.
 */
app.get('/outcome', async c => {
  const k = new Kernel('orchestrator', new Trace(), c.env);
  const a = await k.invoke<any>('analytics.returnrate.get', {});
  const pts = a.points_of_34 as Record<string, number>;
  const levers = [
    { reason: 'size_fit', points: pts.size_fit ?? 0, reachable: 0.65, captured: 0.75, by: 'Size & Fit Agent' },
    { reason: 'changed_mind', points: pts.changed_mind ?? 0, reachable: 1.0, captured: 0.40, by: 'Discovery relevance + AR try-on' },
    { reason: 'quality_defect', points: pts.quality_defect ?? 0, reachable: 1.0, captured: 0.25, by: 'Supplier feedback loop (M2)' },
    { reason: 'other', points: pts.other ?? 0, reachable: 0, captured: 0, by: 'no claim made' },
  ].map(l => ({ ...l, removed: Math.round(l.points * l.reachable * l.captured * 10) / 10 }));
  const removed = Math.round(levers.reduce((s, l) => s + l.removed, 0) * 10) / 10;
  return c.json({
    baseline_return_rate: a.return_rate,
    reason_decomposition: levers,
    points_removed: removed,
    projected_return_rate: Math.round((a.return_rate - removed) * 10) / 10,
    brief_target_band: '10-15%',
    honest_note: 'Personalisation alone does not reach the brief band. Closing the gap needs assortment and supplier quality remediation, plus a returns-policy change - a commercial decision, not an architectural one.',
  });
});

app.get('/health', async c => {
  const probe = async (f: Fetcher, host: string) => {
    try { return (await (await f.fetch(`https://${host}/health`)).json<any>()).ok === true; } catch { return false; }
  };
  return c.json({
    ok: true, service: 'app', platform: 'cloudflare-workers',
    dependencies: {
      tool_gateway: await probe(c.env.TOOLS, 'tools.internal'),
      llm_gateway: await probe(c.env.LLM, 'llm.internal'),
    },
  });
});

app.get('/admin/products', async c => {
  const k = new Kernel('admin', new Trace(), c.env);
  const args: Record<string, unknown> = {};
  for (const key of ['q', 'category', 'department', 'page', 'pageSize']) {
    const v = c.req.query(key);
    if (v) args[key] = v;
  }
  try {
    return c.json(await k.invoke('catalogue.admin.list', args));
  } catch (e) { return c.json({ error: String(e) }, 502); }
});

app.get('/admin/products/:sku', async c => {
  const k = new Kernel('admin', new Trace(), c.env);
  try {
    return c.json(await k.invoke('catalogue.admin.get', { sku: c.req.param('sku') }));
  } catch (e) { return c.json({ error: String(e) }, 404); }
});

app.post('/admin/products/:sku', async c => {
  const k = new Kernel('admin', new Trace(), c.env);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  try {
    return c.json(await k.invoke('catalogue.admin.update', { ...body, sku: c.req.param('sku') }));
  } catch (e) { return c.json({ error: String(e) }, 502); }
});

app.post('/admin/reindex', async c => {
  try {
    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
    const r = await c.env.TOOLS.fetch(`https://tools.internal/proxy/catalogue/reindex${qs}`, { method: 'POST' });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
  } catch (e) { return c.json({ error: String(e) }, 502); }
});

app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default app;
export { SessionAgent } from './session-do.js';
