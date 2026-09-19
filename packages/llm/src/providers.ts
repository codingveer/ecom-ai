/**
 * Provider-calling code, extracted from index.ts so the offline eval harness (a plain
 * Node script, not a Worker) can call the exact rendering and HTTP-calling logic the
 * Worker uses in production, instead of reimplementing it.
 */
export type ProviderResult = { text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean };

export const render = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? 'unknown' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });

const est = (s: string) => Math.ceil(s.length / 4);

/** Model routing table. Agents ask for a class; the gateway picks the model. */
export const ROUTING: Record<string, Record<string, string>> = {
  mock:         { reasoning: 'mock-reasoning-v1',              low_latency: 'mock-fast-v1' },
  'workers-ai': { reasoning: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                  low_latency: '@cf/meta/llama-3.1-8b-instruct' },
  anthropic:    { reasoning: 'claude-sonnet-4-6',              low_latency: 'claude-haiku-4-5-20251001' },
  openai:       { reasoning: 'gpt-4o',                         low_latency: 'gpt-4o-mini' },
};

export async function callAnthropic(apiKey: string, gatewayBase: string | null, model: string, system: string, user: string): Promise<ProviderResult> {
  const url = gatewayBase ? `${gatewayBase}/anthropic/v1/messages` : 'https://api.anthropic.com/v1/messages';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
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
    via_gateway: !!gatewayBase,
  };
}

/**
 * `temperature` is optional and left unset by the Worker (so the provider default still
 * applies to every production call, unchanged). The offline eval harness pins it to 0 for
 * its LLM-judge scorer, where a grader that returns a different verdict on the same input
 * across runs would make the eval's score meaningless.
 */
export async function callOpenAI(apiKey: string, gatewayBase: string | null, model: string, system: string, user: string, temperature?: number): Promise<ProviderResult> {
  const url = gatewayBase ? `${gatewayBase}/openai/chat/completions` : 'https://api.openai.com/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(temperature === undefined ? {} : { temperature }),
    }),
  });
  const d = await r.json<any>();
  if (!r.ok) throw new Error(d?.error?.message ?? `openai ${r.status}`);
  return {
    text: d.choices?.[0]?.message?.content ?? '',
    input_tokens: d.usage?.prompt_tokens ?? est(system + user),
    output_tokens: d.usage?.completion_tokens ?? 0,
    via_gateway: !!gatewayBase,
  };
}

export async function callWorkersAI(ai: Ai, gatewayName: string | null, model: string, system: string, user: string): Promise<ProviderResult> {
  const d = await ai.run(model as any, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 700,
  }, gatewayName ? { gateway: { id: gatewayName } } : undefined) as any;
  const text = d.response ?? d.result?.response ?? '';
  return {
    text,
    input_tokens: d.usage?.prompt_tokens ?? est(system + user),
    output_tokens: d.usage?.completion_tokens ?? est(text),
    via_gateway: !!gatewayName,
  };
}
