/**
 * Token accounting and the model call log, as a single Durable Object.
 *
 * One globally-consistent counter for the whole deployment. This is the "request and
 * response logging" the brief asks the gateway to own, with strong consistency rather
 * than eventually-consistent counters.
 */
export class UsageCounter {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/record') {
      const rec = await req.json<any>();
      const summary = (await this.state.storage.get<any>('summary')) ??
        { calls: 0, input_tokens: 0, output_tokens: 0, by_agent: {}, by_model: {} };
      summary.calls++;
      summary.input_tokens += rec.input_tokens ?? 0;
      summary.output_tokens += rec.output_tokens ?? 0;
      const a = summary.by_agent[rec.agent] ?? { calls: 0, in: 0, out: 0 };
      summary.by_agent[rec.agent] = { calls: a.calls + 1, in: a.in + rec.input_tokens, out: a.out + rec.output_tokens };
      const m = summary.by_model[rec.model] ?? { calls: 0, tokens: 0 };
      summary.by_model[rec.model] = { calls: m.calls + 1, tokens: m.tokens + rec.input_tokens + rec.output_tokens };
      await this.state.storage.put('summary', summary);

      // Keep the last 100 calls for the demo; anything longer lives in AI Gateway's own logs.
      const calls = (await this.state.storage.get<any[]>('calls')) ?? [];
      calls.push({ ts: new Date().toISOString(), ...rec });
      await this.state.storage.put('calls', calls.slice(-100));
      return Response.json({ recorded: true });
    }

    if (url.pathname === '/summary') {
      return Response.json((await this.state.storage.get('summary')) ??
        { calls: 0, input_tokens: 0, output_tokens: 0, by_agent: {}, by_model: {} });
    }

    if (url.pathname === '/calls') {
      const calls = (await this.state.storage.get<any[]>('calls')) ?? [];
      return Response.json({ entries: calls.length, calls });
    }

    if (url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return Response.json({ reset: true });
    }

    return new Response('not found', { status: 404 });
  }
}
