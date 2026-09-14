/**
 * Agent Access Layer - Worker #2 (cut-down MCP).
 *
 * Note this Worker's bindings: a KV namespace for the registry, and a service binding
 * to `services`. No D1. It cannot read the database either - it can only call the
 * service API, exactly like the contracts say.
 *
 * The registry lives in KV rather than on disk, so installing a tool at runtime is a
 * real write to a real store, not a file copy on someone's laptop.
 */
import { Hono } from 'hono';
import { BUNDLED } from './bundled.js';
import type { ToolContract } from './types.js';

type Env = {
  REGISTRY: KVNamespace;
  SERVICES: Fetcher;
  AUDIT?: AnalyticsEngineDataset;
};

const KEY = 'registry:v1';
const app = new Hono<{ Bindings: Env }>();

async function loadRegistry(env: Env): Promise<Map<string, ToolContract>> {
  let list = await env.REGISTRY.get<ToolContract[]>(KEY, 'json');
  if (!list) {
    list = BUNDLED;
    await env.REGISTRY.put(KEY, JSON.stringify(list));
  }
  return new Map(list.map(c => [c.name, c]));
}

/** Minimal contract validator - deliberately hand-rolled so the enforcement is readable. */
function validate(contract: ToolContract, args: Record<string, unknown>) {
  const errors: string[] = [];
  const coerced: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(contract.input_schema)) {
    let v = args[field];
    if (v === undefined || v === null || v === '') {
      if (spec.required) { errors.push(`missing required field '${field}'`); continue; }
      if (spec.default !== undefined) v = spec.default; else continue;
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) errors.push(`field '${field}' must be ${spec.type}`);
      else v = spec.type === 'integer' ? Math.trunc(n) : n;
    } else if (spec.type === 'string' && typeof v !== 'string') v = String(v);
    else if (spec.type === 'boolean') v = v === true || v === 'true';
    coerced[field] = v;
  }
  const unknown = Object.keys(args).filter(k => !(k in contract.input_schema));
  if (unknown.length) errors.push(`unknown field(s): ${unknown.join(', ')}`);
  return { errors, coerced };
}

function audit(env: Env, blobs: string[], doubles: number[]) {
  // Analytics Engine gives us an append-only, queryable audit trail with no storage to run.
  env.AUDIT?.writeDataPoint({ blobs, doubles, indexes: [blobs[0] ?? 'invoke'] });
}

app.get('/tools', async c => {
  const reg = await loadRegistry(c.env);
  const agent = c.req.query('agent') ?? null;
  const tools = [...reg.values()].filter(t => !agent || t.allowed_agents.includes(agent));
  return c.json({ count: tools.length, tools });
});

app.get('/tools/:name', async c => {
  const reg = await loadRegistry(c.env);
  const t = reg.get(c.req.param('name'));
  return t ? c.json(t) : c.json({ error: 'tool_not_found' }, 404);
});

/** Install a contract at runtime. No agent code changes, no redeploy. */
app.post('/registry/install', async c => {
  const contract = await c.req.json<ToolContract>();
  if (!contract?.name || !contract?.transport) return c.json({ error: 'invalid_contract' }, 400);
  const reg = await loadRegistry(c.env);
  const before = reg.size;
  reg.set(contract.name, contract);
  await c.env.REGISTRY.put(KEY, JSON.stringify([...reg.values()]));
  audit(c.env, ['registry.install', contract.name, contract.version], [before, reg.size]);
  return c.json({ installed: contract.name, before, after: reg.size, tools: [...reg.keys()].sort() });
});

app.post('/registry/reload', async c => {
  const reg = await loadRegistry(c.env);
  return c.json({ reloaded: true, count: reg.size, tools: [...reg.keys()].sort() });
});

app.post('/registry/reset', async c => {
  await c.env.REGISTRY.put(KEY, JSON.stringify(BUNDLED));
  return c.json({ reset: true, count: BUNDLED.length });
});

/** The single entry point every agent uses. */
app.post('/invoke', async c => {
  const started = Date.now();
  const { agent, tool, args = {} } = await c.req.json<any>();
  const reg = await loadRegistry(c.env);
  const contract = reg.get(tool);

  if (!contract) {
    audit(c.env, ['invoke.rejected', tool ?? '-', agent ?? '-', 'unknown_tool'], [0]);
    return c.json({ ok: false, error: 'unknown_tool', tool }, 404);
  }
  if (!contract.allowed_agents.includes(agent)) {
    audit(c.env, ['invoke.denied', tool, agent, 'permission_denied'], [0]);
    return c.json({
      ok: false, error: 'permission_denied', tool, agent,
      detail: `contract ${tool}@${contract.version} permits [${contract.allowed_agents.join(', ')}]`,
    }, 403);
  }

  const { errors, coerced } = validate(contract, args);
  if (errors.length) {
    audit(c.env, ['invoke.invalid', tool, agent, errors.join('; ')], [0]);
    return c.json({ ok: false, error: 'contract_violation', tool, errors }, 400);
  }

  let path = contract.transport.path;
  const remaining = { ...coerced };
  for (const key of Object.keys(coerced)) {
    const token = `{${key}}`;
    if (path.includes(token)) { path = path.replace(token, encodeURIComponent(String(coerced[key]))); delete remaining[key]; }
  }
  let url = `https://services.internal${path}`;
  const init: RequestInit = { method: contract.transport.method };
  if (contract.transport.method === 'GET') {
    const qs = new URLSearchParams(Object.entries(remaining).map(([k, v]) => [k, String(v)]));
    if ([...qs].length) url += `?${qs}`;
  } else {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(remaining);
  }

  try {
    // Service binding: a direct Worker-to-Worker call. No public internet hop, no
    // credentials to manage, and the services Worker can stay internal-only.
    const r = await c.env.SERVICES.fetch(new Request(url, init));
    const data = await r.json();
    const ms = Date.now() - started;
    audit(c.env, ['invoke', tool, agent, contract.version], [r.status, ms]);
    return c.json({ ok: r.ok, tool, version: contract.version, latency_ms: ms, data });
  } catch (e) {
    audit(c.env, ['invoke.error', tool, agent, String(e)], [502, Date.now() - started]);
    return c.json({ ok: false, error: 'service_unreachable', tool, detail: String(e) }, 502);
  }
});

app.get('/health', async c => {
  const reg = await loadRegistry(c.env);
  return c.json({ ok: true, service: 'tool-gateway', tools: reg.size, store: 'workers-kv' });
});

export default app;
