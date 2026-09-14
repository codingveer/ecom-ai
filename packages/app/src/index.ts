/**
 * Demo application - Worker #4.
 *
 * Bindings: two service bindings and a Durable Object namespace. No D1. This Worker
 * physically cannot query the database.
 */
import { Hono } from 'hono';
import { Kernel, Trace, type GatewayBindings } from './kernel.js';

type Env = GatewayBindings & { SESSION: DurableObjectNamespace; ASSETS: Fetcher };
const app = new Hono<{ Bindings: Env }>();

const session = (env: Env, id: string) => env.SESSION.get(env.SESSION.idFromName(id));

app.post('/session/:id/message', async c => {
  const body = await c.req.json<any>();
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

app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default app;
export { SessionDO } from './session-do.js';
