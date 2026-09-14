/**
 * The agent kernel, on Workers.
 *
 * An agent receives this and nothing else. It cannot name a URL, a database, a model
 * or a provider - only a tool and a prompt. The two Fetchers below are service
 * bindings, so the gateways are reachable Worker-to-Worker without being on the
 * public internet at all.
 */
export type GatewayBindings = { TOOLS: Fetcher; LLM: Fetcher };

export type TraceStep = {
  seq: number;
  stage: 'intent' | 'route' | 'tool' | 'llm' | 'policy' | 'memory' | 'agent' | 'outcome';
  actor: string;
  label: string;
  detail?: unknown;
  ms?: number;
  /** Step in the Mission #3 sequence diagram this implements, e.g. "S2.6". */
  m3_ref?: string;
};

export class Trace {
  steps: TraceStep[] = [];
  private n = 0;
  add(s: Omit<TraceStep, 'seq'>) { this.steps.push({ seq: ++this.n, ...s }); return s; }
}

export type PolicyVerdict = { policy: string; decision: 'pass' | 'block'; detail: string };

export class Kernel {
  constructor(public agent: string, public trace: Trace, private env: GatewayBindings) {}

  async invoke<T = any>(tool: string, args: Record<string, unknown> = {}, m3_ref?: string): Promise<T> {
    const t0 = Date.now();
    const r = await this.env.TOOLS.fetch(new Request('https://tools.internal/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: this.agent, tool, args }),
    }));
    const body = await r.json<any>();
    this.trace.add({
      stage: 'tool', actor: this.agent, label: `${tool}@${body.version ?? '?'}`,
      detail: { args, ok: body.ok, error: body.error ?? null },
      ms: Date.now() - t0, m3_ref,
    });
    if (!body.ok) throw new Error(`tool ${tool} failed: ${body.error ?? 'unknown'}${body.detail ? ` (${body.detail})` : ''}`);
    return body.data as T;
  }

  async llm(prompt_id: string, variables: Record<string, unknown>, m3_ref?: string): Promise<string> {
    const r = await this.env.LLM.fetch(new Request('https://llm.internal/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: this.agent, prompt_id, variables }),
    }));
    const body = await r.json<any>();
    if (!body.ok) throw new Error(`llm ${prompt_id} failed`);
    this.trace.add({
      stage: 'llm', actor: this.agent, label: `${prompt_id}@${body.meta.prompt_version}`,
      detail: {
        model: body.meta.model, provider: body.meta.provider, class: body.meta.model_class,
        via_ai_gateway: body.meta.via_ai_gateway,
        tokens_in: body.meta.input_tokens, tokens_out: body.meta.output_tokens,
        degraded: body.meta.degraded,
      },
      ms: body.meta.latency_ms, m3_ref,
    });
    return body.text as string;
  }

  record(v: PolicyVerdict, m3_ref?: string) {
    this.trace.add({ stage: 'policy', actor: 'policy-engine', label: `${v.policy}: ${v.decision}`, detail: v.detail, m3_ref });
    return v;
  }

  note(stage: TraceStep['stage'], label: string, detail?: unknown, m3_ref?: string) {
    this.trace.add({ stage, actor: this.agent, label, detail, m3_ref });
  }
}
