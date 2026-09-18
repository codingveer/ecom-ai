/**
 * Session Agent - one Durable Object instance per session, globally unique.
 *
 * Rebased onto AIChatAgent (Cloudflare's `agents` package) purely as a transport and
 * persistence wrapper: AIChatAgent's own AI-loop (onChatMessage driving streamText with
 * tools) is NOT used, because this app's "chat" is five separate hand-written agent
 * modules with bespoke control flow, not a single model call. `handleTurn` below is
 * the entire orchestrator, completely unchanged from the pre-AIChatAgent version, and
 * is called from both the plain-HTTP `onRequest` path (used by scripts/smoke.ts and any
 * direct curl) and the new chat-protocol `onChatMessage` path (added in a later task).
 *
 * MEMORY MODEL
 *   Within a session  (this DO's own ctx.storage): turn history with detected intents,
 *     resolved segment, last category, last SKU shown, pending offer.
 *   Across sessions   (D1, via the context service): segment and propensity scores,
 *     last discovery query, confirmed fit recommendations, entitlement, engagement.
 *   AIChatAgent's own message persistence (this.messages) is a THIRD, separate store -
 *     just the visible chat transcript, used for reconnect/replay. It is never read by
 *     handleTurn and never substitutes for the two stores above.
 */
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { createUIMessageStream, createUIMessageStreamResponse, type GenerateTextOnFinishCallback, type ToolSet } from 'ai';
import { Kernel, Trace, type GatewayBindings, type TraceStep } from './kernel.js';
import * as profiling from './agents/profiling.js';
import * as discovery from './agents/discovery.js';
import * as fit from './agents/fit.js';
import * as upsell from './agents/upsell.js';
import * as loyalty from './agents/loyalty.js';
import type { Segment } from './agents/profiling.js';

type Turn = { utterance: string; intent: string; at: string };
type Working = {
  segment?: Segment;
  lastCategory?: string | null;
  lastSku?: string | null;
  lastProducts?: string[];
  pendingOffer?: { tier: string; price: number } | null;
};
type State = { customerId: string | null; startedAt: string; turns: Turn[]; working: Working };

type TurnFlags = { unsafeRanking?: boolean; semanticSearch?: boolean };
export type TurnResult =
  | {
      ok: true; reply: string; intent: string; intent_confidence: number; agent: string;
      payload: unknown; trace: TraceStep[]; customerSwitched: boolean;
      memory: { within_session: { turns: Turn[]; working: Working }; across_sessions: unknown };
    }
  | { ok: false; error: string; detail: string; trace: TraceStep[] };

const ACCEPT = /\b(accept|yes please|yes|upgrade me|sign me up|take it|go ahead)\b/i;

export class SessionAgent extends AIChatAgent<GatewayBindings> {
  private async load(): Promise<State> {
    return (await this.ctx.storage.get<State>('session'))
      ?? { customerId: null, startedAt: new Date().toISOString(), turns: [], working: {} };
  }

  async handleTurn(customerId: string, text: string, flags: TurnFlags): Promise<TurnResult> {
    let session = await this.load();

    // A different customer on the same session id starts clean. Context never leaks
    // between people, even if a session id is reused. This also wipes the visible chat
    // transcript AIChatAgent persists, so both entry points (`onRequest`'s plain HTTP
    // and `onChatMessage`'s chat protocol) get the wipe for free from one place, rather
    // than each caller having to remember to do it.
    //
    // `this.sessions.session().clearMessages()`, NOT `await this.saveMessages([])`:
    // saveMessages() acquires AIChatAgent's exclusive per-session turn queue
    // (_runExclusiveChatTurn -> TurnQueue.enqueue in node_modules/agents/dist/chat/
    // index.js), and awaiting it from inside onChatMessage - which is itself already
    // running inside that same queue slot - is a circular wait that wedges the DO
    // forever. It also would not even work: persistMessages([]) merges an empty
    // incoming list onto the existing transcript instead of replacing it (no
    // `_deleteStaleRows`), so no rows are actually deleted or changed.
    // `sessions.session()` returns the exact same handle AIChatAgent keeps as its
    // private `#session` (see its constructor: `this.#session = this.sessions.session()`),
    // and `clearMessages()` does a real `DELETE FROM cf_agents_session_messages ...`
    // then notifies the change feed with `{ type: 'clear' }` - which is exactly what
    // `this.messages = []` reacts to (see #subscribeToSessionChanges). It never
    // touches `_turnQueue`, so it is safe to await synchronously here regardless of
    // which caller (`onRequest` or `onChatMessage`) invoked `handleTurn`.
    const customerSwitched = !!session.customerId && session.customerId !== customerId;
    if (customerSwitched) {
      session = { customerId, startedAt: new Date().toISOString(), turns: [], working: {} };
      await this.sessions.session().clearMessages();
    }
    session.customerId = customerId;

    const trace = new Trace();
    const orch = new Kernel('orchestrator', trace, this.env);
    trace.add({ stage: 'route', actor: 'channel', label: 'trigger captured',
      detail: { session: this.ctx.id.toString().slice(0, 12), customerId, utterance: text }, m3_ref: 'S1.2' });

    try {
    // Sequence 1 runs once per session; everything downstream depends on it.
    if (!session.working.segment) {
      trace.add({ stage: 'route', actor: 'orchestrator', label: 'no segment in session context - dispatching Profiling Agent', m3_ref: 'S1.6' });
      const { segment } = await profiling.classify(new Kernel('profiling', trace, this.env), customerId);
      session.working.segment = segment;
    } else {
      trace.add({ stage: 'memory', actor: 'orchestrator', label: 'segment served from Durable Object storage',
        detail: session.working.segment, m3_ref: 'S2.3' });
    }
    const segment = session.working.segment!;

    let cls: any;
    if (session.working.pendingOffer && ACCEPT.test(text)) {
      cls = { intent: 'upsell.moment', confidence: 0.99, entities: { category: null, sku: null },
        rationale: 'pending offer held in session context; utterance is an acceptance' };
      trace.add({ stage: 'intent', actor: 'orchestrator', label: 'upsell.moment (99%) - resolved from session context',
        detail: cls, m3_ref: 'S4.12' });
    } else {
      const history = session.turns.slice(-4).map(t => `${t.intent}: "${t.utterance}"`).join(' | ') || 'none';
      const raw = await orch.llm('intent.classify', { utterance: text, history }, 'S1.4');
      try {
        cls = JSON.parse(raw.replace(/```json|```/g, '').trim());
        trace.add({ stage: 'intent', actor: 'orchestrator',
          label: `${cls.intent} (${Math.round((cls.confidence ?? 0) * 100)}%)`, detail: cls, m3_ref: 'S1.5' });
      } catch {
        cls = { intent: 'discovery.rank', confidence: 0.4, entities: { category: null, sku: null }, rationale: 'fallback' };
        trace.add({ stage: 'intent', actor: 'orchestrator', label: 'classification unparseable - defaulting to discovery.rank', detail: raw });
      }
    }

    const category = cls.entities?.category ?? session.working.lastCategory ?? null;
    const sku = cls.entities?.sku ?? session.working.lastSku ?? null;
    const accepting = !!session.working.pendingOffer && ACCEPT.test(text);

    let payload: any = {};
    let reply = '';
    let agentName: string = cls.intent;

    switch (cls.intent) {
      case 'profile.refresh': {
        agentName = 'profiling';
        payload = { segment };
        reply = `You are classified as ${segment.affluence.replace('_', ' ')} and ${segment.loyalty_status}, on ${segment.tier} tier. `
          + `That comes from an average unit price of GBP ${segment.evidence.avg_unit_price_gbp}, a premium item share of `
          + `${Math.round(Number(segment.evidence.premium_item_share) * 100)}% and ${segment.evidence.orders} orders over `
          + `${segment.evidence.tenure_days} days.`;
        break;
      }

      case 'discovery.rank': {
        agentName = 'discovery';
        trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Discovery Agent with segment + fit profile',
          detail: { segment: segment.affluence, category }, m3_ref: 'S2.6' });
        const dk = new Kernel('discovery', trace, this.env);
        let fitSize: string | null = null;
        try {
          const f = await dk.invoke<any>('fit.profile.get', { customer_id: customerId }, 'S2.6');
          fitSize = f.consent_fit
            ? ((f.profiles as any[]).find(p => !category || p.category === category)?.preferred_size ?? null)
            : null;
        } catch { /* discovery continues without fit */ }
        const r = await discovery.rank(dk, customerId, text, segment, fitSize, category, !!flags.unsafeRanking, !!flags.semanticSearch);
        payload = r;
        session.working.lastProducts = r.products.map((p: any) => p.sku);
        session.working.lastSku = r.products[0]?.sku ?? session.working.lastSku ?? null;
        session.working.lastCategory = category ?? r.products[0]?.category ?? null;
        reply = r.products.length
          ? `${r.rationale}\n\n` + r.products.map((p: any, i: number) => `${i + 1}. ${p.title} - GBP ${p.price_gbp} (${p.price_tier})`).join('\n')
          : r.rationale;
        break;
      }

      case 'fit.check': {
        agentName = 'fit';
        trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Size & Fit Agent', detail: { sku, category }, m3_ref: 'S3.4' });
        const r = await fit.recommend(new Kernel('fit', trace, this.env), customerId, sku, category);
        payload = r;
        reply = r.explanation;
        if (!r.abstained) {
          reply += `\n\nRecommended size ${r.recommended_size} at ${r.confidence}% confidence`
            + (r.size_in_stock ? '.' : ' - currently out of stock in that size.');
          session.working.lastCategory = r.category;
        }
        break;
      }

      case 'upsell.moment': {
        agentName = 'upsell';
        const uk = new Kernel('upsell', trace, this.env);
        if (accepting) {
          const sub = await upsell.accept(uk, customerId, session.working.pendingOffer!.tier);
          session.working.pendingOffer = null;
          payload = { accepted: true, subscription: sub };
          reply = `You are on ${sub.tier} at GBP ${sub.price_gbp_month} a month. The entitlement is live now, including 2x loyalty accrual.`;
        } else {
          trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Upsell Agent', m3_ref: 'S4.4' });
          const r = await upsell.evaluate(uk, customerId);
          payload = r;
          if (r.offer) {
            session.working.pendingOffer = { tier: r.offer.tier, price: r.offer.price_gbp_month };
            reply = `${r.offer.copy}\n\nReply "accept" to switch to Plus at GBP ${r.offer.price_gbp_month} a month.`;
          } else {
            reply = r.reason === 'suppressed_by_policy' ? `No offer shown. ${r.policy?.detail}`
              : r.reason === 'already_subscribed' ? `You are already on ${r.entitlement}, so there is nothing to upgrade.`
              : `Styling Advisory has been used ${r.usage.sessions} time(s). No offer is made before the third session.`;
          }
        }
        break;
      }

      case 'loyalty.event': {
        agentName = 'loyalty';
        const lk = new Kernel('loyalty', trace, this.env);
        const redeemMatch = text.match(/redeem\s+(-?\d+)/i);
        const statusQuery = /\bhow (many|much)\b/i.test(text) || /\bbalance\b/i.test(text);
        if (redeemMatch) {
          const amount = Number(redeemMatch[1]);
          if (amount <= 0) {
            payload = { redeemed: false, reason: 'invalid_amount' };
            reply = 'Enter a positive number of points to redeem.';
          } else {
            const r = await loyalty.redeem(lk, customerId, amount);
            payload = r;
            reply = r.redeemed
              ? `Redeemed ${amount} points. Balance is now ${r.balance}, and GBP ${r.liability_released_gbp} of point liability has been released.`
              : `That reward needs ${r.shortfall} more points. Your balance is ${r.balance}.`;
          }
        } else if (statusQuery) {
          trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Loyalty Agent - balance query', m3_ref: 'S5.3' });
          const st = await loyalty.status(lk, customerId);
          payload = st;
          reply = /\bmore\b/i.test(text)
            ? `You need ${st.points_to_next_tier} more points to reach the next tier. Current balance is ${st.points_balance} points on ${st.tier}.`
            : `Your balance is ${st.points_balance} points on ${st.tier} tier, with ${st.points_to_next_tier} to the next tier.`;
        } else {
          trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Loyalty Agent', m3_ref: 'S5.3' });
          const r = await loyalty.accrue(lk, customerId, 'purchase', Math.round(Number(segment.evidence.avg_unit_price_gbp) || 40));
          payload = r;
          reply = r.nudge + (r.tier_changed ? ` Tier is now ${r.tier}.` : '');
        }
        break;
      }

      default:
        reply = 'That did not map to any of the five functionalities. Try asking about products, sizing, your plan or your points.';
    }

    session.turns.push({ utterance: text, intent: cls.intent, at: new Date().toISOString() });
    await this.ctx.storage.put('session', session);
    trace.add({ stage: 'memory', actor: 'orchestrator', label: 'session context persisted to Durable Object storage',
      detail: { turns: session.turns.length, working: session.working }, m3_ref: 'S2.14' });

    const longTerm = await orch.invoke<any>('context.read', { customer_id: customerId }).catch(() => ({}));

    return {
      ok: true, reply, intent: cls.intent, intent_confidence: cls.confidence, agent: agentName,
      payload, trace: trace.steps, customerSwitched,
      memory: {
        within_session: { turns: session.turns, working: session.working },
        across_sessions: longTerm,
      },
    };
    } catch (e) {
      return { ok: false, error: 'agent_error', detail: String(e), trace: trace.steps };
    }
  }

  /**
   * WebSocket chat-protocol entry point for `agentsMiddleware()` / `useAgentChat`
   * clients. This is a transport wrapper around `handleTurn` - the same orchestrator
   * `onRequest`'s plain-HTTP `/message` path calls - not a second implementation.
   * The reply is already fully computed before any chunk is written; the delta loop
   * below paces the reveal for the client, it does not reduce time-to-first-token.
   * The full trace and memory snapshot ride along as a single `data-trace` part so
   * the console can render them without a second round trip.
   */
  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const last = this.messages[this.messages.length - 1];
    const text = last?.parts?.filter(p => p.type === 'text').map(p => (p as any).text).join('') ?? '';
    const body = options?.body ?? {};
    const customerId = String(body.customerId ?? '');
    const flags = { unsafeRanking: !!body.unsafeRanking, semanticSearch: !!body.semanticSearch };

    // Mirror the HTTP route's (`/session/:id/message` in index.ts) validation: without
    // this, an empty customerId makes handleTurn treat it as always different from any
    // established session's customerId (spurious customer-switch wipe), then throws
    // inside profiling.classify(k, ''), streaming a raw error string back as the reply.
    if (!customerId || !text) {
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: 'text-start', id: 'reply' });
          writer.write({ type: 'text-delta', id: 'reply', delta: 'customerId and text are required.' });
          writer.write({ type: 'text-end', id: 'reply' });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }

    const result = await this.handleTurn(customerId, text, flags);
    // Customer-switch transcript wipe (this.sessions.session().clearMessages()) now
    // happens inside handleTurn itself, right where customerSwitched is computed - see
    // the comment there. Both onRequest and onChatMessage get it for free from one place.

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (!result.ok) {
          writer.write({ type: 'text-start', id: 'reply' });
          writer.write({ type: 'text-delta', id: 'reply', delta: result.detail });
          writer.write({ type: 'text-end', id: 'reply' });
          return;
        }

        writer.write({ type: 'text-start', id: 'reply' });
        // Server-paced typewriter: the reply is already fully known (handleTurn already
        // ran); this paces its reveal, it does not reduce time-to-first-token.
        const CHUNK = 3;
        for (let i = 0; i < result.reply.length; i += CHUNK) {
          writer.write({ type: 'text-delta', id: 'reply', delta: result.reply.slice(i, i + CHUNK) });
          await new Promise(resolve => setTimeout(resolve, 12));
        }
        writer.write({ type: 'text-end', id: 'reply' });

        writer.write({
          type: 'data-trace',
          id: 'turn-trace',
          data: {
            intent: result.intent, intent_confidence: result.intent_confidence, agent: result.agent,
            payload: result.payload, trace: result.trace, memory: result.memory,
          },
        });
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/state') return Response.json(await this.load());
    if (url.pathname === '/reset') {
      // NOT `this.ctx.storage.deleteAll()`: verified live (it threw `SqlError: no such
      // table: cf_agents_session_messages` on the very next line) that on a SQLite-backed
      // Durable Object, `deleteAll()` resets the WHOLE underlying SQLite database - every
      // table, not just the KV-style keys this class itself writes through
      // `ctx.storage.get/put`. That drops AIChatAgent's own `cf_agents_session_messages`
      // (etc.) tables too, out from under it. Worse than the immediate crash: `Sessions`
      // (`agents/sessions`) memoises "tables already ensured" in an in-memory flag once
      // per live DO instance (`SessionsCore#ensureTables`'s `_tablesEnsured`), not by
      // checking the database, so even a reordered call would leave every later message
      // in that DO's lifetime failing the same way until the instance is evicted.
      // `this.ctx.storage` is used for exactly one key anywhere in this class -
      // `'session'` (see `load()` / the `ctx.storage.put('session', ...)` below) - so
      // deleting that one key is the precise equivalent of "reset the orchestrator's own
      // Working state" without touching any table AIChatAgent owns.
      await this.ctx.storage.delete('session');
      await this.sessions.session().clearMessages();
      return Response.json({ reset: true });
    }
    if (url.pathname !== '/message') return new Response('not found', { status: 404 });

    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json', detail: 'request body must be valid JSON' }, { status: 400 }); }
    const { customerId, text, unsafeRanking, semanticSearch } = body;
    const result = await this.handleTurn(customerId, text, { unsafeRanking, semanticSearch });
    if (!result.ok) return Response.json(result, { status: 500 });
    const { ok, customerSwitched, ...rest } = result;
    return Response.json(rest);
  }
}
