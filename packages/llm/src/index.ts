/**
 * LLM Gateway - Worker #3.
 *
 * The Mission #4 brief asks for a single gateway owning model routing and
 * interoperability, prompt management and versioning, token accounting, and request
 * and response logging.
 *
 * On Cloudflare, three of those four are platform features rather than code we wrote:
 * AI Gateway sits in front of every provider and gives unified logging, caching,
 * rate limiting and per-request analytics. What stays in this Worker is the part that
 * is genuinely ours - the versioned prompt registry and the routing policy that maps a
 * model *class* to a model, so an agent never names one.
 *
 * Providers: mock | workers-ai | anthropic | openai.
 * `mock` is deterministic and runs with no network at all - rehearse on it.
 */
import { Hono } from 'hono';
import { PROMPTS, type Prompt } from './prompts.js';
import { mockComplete } from './mock.js';

type Env = {
  AI?: Ai;
  USAGE: DurableObjectNamespace;
  LLM_PROVIDER?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

/** Model routing table. Agents ask for a class; the gateway picks the model. */
const ROUTING: Record<string, Record<string, string>> = {
  mock:         { reasoning: 'mock-reasoning-v1',              low_latency: 'mock-fast-v1' },
  'workers-ai': { reasoning: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                  low_latency: '@cf/meta/llama-3.1-8b-instruct' },
  anthropic:    { reasoning: 'claude-sonnet-4-6',              low_latency: 'claude-haiku-4-5-20251001' },
  openai:       { reasoning: 'gpt-4o',                         low_latency: 'gpt-4o-mini' },
};

const prompts = new Map(PROMPTS.map(p => [p.id, p]));
const est = (s: string) => Math.ceil(s.length / 4);
const render = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? 'unknown' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });

/** AI Gateway universal endpoint: one URL in front of every provider. */
const gatewayBase = (env: Env) =>
  env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_NAME
    ? `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}`
    : null;

async function callAnthropic(env: Env, model: string, system: string, user: string) {
  const base = gatewayBase(env);
  const url = base ? `${base}/anthropic/v1/messages` : 'https://api.anthropic.com/v1/messages';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
  });
  const d = await r.json<any>();
  if (!r.ok) throw new Error(d?.error?.message ?? `anthropic ${r.status}`);
  return {
    text: (d.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
    input_tokens: d.usage?.input_tokens ?? est(system + user),
    output_tokens: d.usage?.output_tokens ?? 0,
    via_gateway: !!base,
  };
}

async function callOpenAI(env: Env, model: string, system: string, user: string) {
  const base = gatewayBase(env);
  const url = base ? `${base}/openai/chat/completions` : 'https://api.openai.com/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const d = await r.json<any>();
  if (!r.ok) throw new Error(d?.error?.message ?? `openai ${r.status}`);
  return {
    text: d.choices?.[0]?.message?.content ?? '',
    input_tokens: d.usage?.prompt_tokens ?? est(system + user),
    output_tokens: d.usage?.completion_tokens ?? 0,
    via_gateway: !!base,
  };
}

async function callWorkersAI(env: Env, model: string, system: string, user: string) {
  // Workers AI runs on Cloudflare's own GPUs; `gateway` routes it through AI Gateway
  // for the same logging and caching as the third-party providers.
  const d = await env.AI!.run(model as any, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 700,
  }, env.AI_GATEWAY_NAME ? { gateway: { id: env.AI_GATEWAY_NAME } } : undefined) as any;
  const text = d.response ?? d.result?.response ?? '';
  return {
    text,
    input_tokens: d.usage?.prompt_tokens ?? est(system + user),
    output_tokens: d.usage?.completion_tokens ?? est(text),
    via_gateway: !!env.AI_GATEWAY_NAME,
  };
}

const app = new Hono<{ Bindings: Env }>();
const usageStub = (env: Env) => env.USAGE.get(env.USAGE.idFromName('global'));

app.get('/prompts', c => c.json({
  count: prompts.size,
  prompts: [...prompts.values()].map(({ id, version, owner, model_class, changelog }) =>
    ({ id, version, owner, model_class, changelog })),
}));

app.get('/routing', c => c.json({
  active_provider: c.env.LLM_PROVIDER ?? 'mock',
  ai_gateway: gatewayBase(c.env) ? 'configured' : 'not configured',
  routing: ROUTING[c.env.LLM_PROVIDER ?? 'mock'],
  all: ROUTING,
}));

app.post('/complete', async c => {
  const started = Date.now();
  const { agent, prompt_id, variables = {}, provider_override } = await c.req.json<any>();
  const prompt = prompts.get(prompt_id) as Prompt | undefined;
  if (!prompt) return c.json({ ok: false, error: 'unknown_prompt', prompt_id }, 404);

  const provider = provider_override ?? c.env.LLM_PROVIDER ?? 'mock';
  const model = ROUTING[provider]?.[prompt.model_class] ?? ROUTING.mock[prompt.model_class];
  const user = render(prompt.template, variables);

  let out: { text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean };
  let degraded = false;
  try {
    if (provider === 'workers-ai' && !c.env.AI) throw new Error('AI binding not enabled');
    if (provider === 'anthropic') out = await callAnthropic(c.env, model, prompt.system, user);
    else if (provider === 'openai') out = await callOpenAI(c.env, model, prompt.system, user);
    else if (provider === 'workers-ai') out = await callWorkersAI(c.env, model, prompt.system, user);
    else out = mockComplete(prompt_id, variables, prompt.system, user);
  } catch {
    // Degrade rather than fail - every M3 sequence has a degrade path, not an error path.
    degraded = true;
    out = mockComplete(prompt_id, variables, prompt.system, user);
  }

  const meta = {
    prompt_id, prompt_version: prompt.version,
    provider: degraded ? `${provider}->mock` : provider, model, model_class: prompt.model_class,
    via_ai_gateway: !!out.via_gateway,
    input_tokens: out.input_tokens, output_tokens: out.output_tokens,
    latency_ms: Date.now() - started, degraded,
  };

  // Token accounting in a Durable Object: one consistent counter for the whole deployment.
  c.executionCtx.waitUntil(usageStub(c.env).fetch('https://usage/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, ...meta, request: user, response: out.text }),
  }));

  return c.json({ ok: true, text: out.text, meta });
});

app.get('/usage', async c => c.json(await (await usageStub(c.env).fetch('https://usage/summary')).json()));
app.get('/calls', async c => c.json(await (await usageStub(c.env).fetch('https://usage/calls')).json()));
app.post('/usage/reset', async c => c.json(await (await usageStub(c.env).fetch('https://usage/reset', { method: 'POST' })).json()));

app.get('/health', c => c.json({
  ok: true, service: 'llm-gateway',
  provider: c.env.LLM_PROVIDER ?? 'mock',
  ai_gateway: gatewayBase(c.env) ? 'configured' : 'not configured',
  workers_ai_binding: !!c.env.AI,
  prompts: prompts.size,
}));

export default app;
export { UsageCounter } from './usage-do.js';
