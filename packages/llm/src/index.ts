import { Hono } from 'hono';
import { initLogger } from 'braintrust';
import { PROMPTS, type Prompt } from './prompts.js';
import { mockComplete } from './mock.js';
import { render, ROUTING, callAnthropic, callOpenAI, callWorkersAI } from './providers.js';

type Env = {
  AI?: Ai;
  USAGE: DurableObjectNamespace;
  LLM_PROVIDER?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  BRAINTRUST_API_KEY?: string;
  BRAINTRUST_PROJECT?: string;
};

const prompts = new Map(PROMPTS.map(p => [p.id, p]));

/** AI Gateway universal endpoint: one URL in front of every provider. */
const gatewayBase = (env: Env) =>
  env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_NAME
    ? `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}`
    : null;

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
  const base = gatewayBase(c.env);

  // Workers have no module-level "startup" phase with bindings available, so this has
  // to happen per-request rather than once at cold start. initLogger is idempotent to
  // call repeatedly - this mirrors the existing "degrade gracefully when not
  // configured" pattern already used for gatewayBase(): no key set, zero behavior
  // change, just no tracing.
  const logger = c.env.BRAINTRUST_API_KEY
    ? initLogger({ apiKey: c.env.BRAINTRUST_API_KEY, projectName: c.env.BRAINTRUST_PROJECT })
    : null;

  let out: { text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean };
  let degraded = false;
  const runProviderCall = async () => {
    if (provider === 'workers-ai' && !c.env.AI) throw new Error('AI binding not enabled');
    if (provider === 'anthropic') return await callAnthropic(c.env.ANTHROPIC_API_KEY ?? '', base, model, prompt.system, user);
    else if (provider === 'openai') return await callOpenAI(c.env.OPENAI_API_KEY ?? '', base, model, prompt.system, user);
    else if (provider === 'workers-ai') return await callWorkersAI(c.env.AI!, c.env.AI_GATEWAY_NAME ?? null, model, prompt.system, user);
    else return mockComplete(prompt_id, variables, prompt.system, user);
  };
  try {
    out = logger
      ? await logger.traced(async span => {
          const result = await runProviderCall();
          span.log({
            input: { system: prompt.system, user },
            output: result.text,
            metadata: { agent, prompt_id, prompt_version: prompt.version, model, provider },
          });
          return result;
        }, { name: `llm.complete:${prompt_id}` })
      : await runProviderCall();
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

  if (logger) c.executionCtx.waitUntil(logger.flush());

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
