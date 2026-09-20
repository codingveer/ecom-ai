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

// Per-session turn budget, deliberately keyed by session id, not customerId: switching
// between demo personas (Arjun, Aditi, ...) on the same session is just picking a
// different seed customer to role-play, not a new visitor, so it must not reset the
// budget. Stored under its own storage key so the customer-switch reset in handleTurn
// (which replaces `session`) never touches it. Default of 3 matches scripts/smoke.ts's
// heaviest scenario (demo-c, 3 messages) - raise both together if that scenario grows.
type Credits = { used: number; limit: number; requestedMore: boolean };
const DEFAULT_CREDIT_LIMIT = 3;

type TurnFlags = { unsafeRanking?: boolean; semanticSearch?: boolean; aiKey?: string };
type Env = GatewayBindings & { AI_ACCESS_KEYS: KVNamespace };
export type TurnResult =
  | {
      ok: true; reply: string; intent: string; intent_confidence: number; agent: string;
      payload: unknown; trace: TraceStep[]; customerSwitched: boolean;
      memory: { within_session: { turns: Turn[]; working: Working }; across_sessions: unknown };
      credits: Credits;
    }
  | { ok: false; error: string; detail: string; trace: TraceStep[]; credits: Credits };

const ACCEPT = /\b(accept|yes please|yes|upgrade me|sign me up|take it|go ahead)\b/i;

export class SessionAgent extends AIChatAgent<Env> {
  /**
   * `token` is an opaque admin-issued access key (see /admin/ai-keys in index.ts), never
   * the real OpenAI key - it only gates whether this turn's Kernel calls are allowed to
   * override the LLM gateway's mock default. Fails closed (mock) on any lookup error.
   */
  private async checkLiveAI(token: string): Promise<boolean> {
    try {
      const record = await this.env.AI_ACCESS_KEYS.get<{ active?: boolean }>(`key:${token}`, 'json');
      return !!record?.active;
    } catch { return false; }
  }

  private async load(): Promise<State> {
    return (await this.ctx.storage.get<State>('session'))
      ?? { customerId: null, startedAt: new Date().toISOString(), turns: [], working: {} };
  }

  private async loadCredits(): Promise<Credits> {
    return (await this.ctx.storage.get<Credits>('credits'))
      ?? { used: 0, limit: DEFAULT_CREDIT_LIMIT, requestedMore: false };
  }

  async handleTurn(customerId: string, text: string, flags: TurnFlags): Promise<TurnResult> {
    // The turn budget exists to cap real provider spend, not to throttle the mock demo
    // (which costs nothing) - so it's only checked/consumed when this turn will actually
    // reach a live provider. Resolved here, before the gate, rather than down at Kernel
    // construction time as before.
    const liveAI = flags.aiKey ? await this.checkLiveAI(flags.aiKey) : false;

    // Gate before any LLM/tool call is made - a blocked turn must cost nothing.
    const credits = await this.loadCredits();
    if (liveAI && credits.used >= credits.limit) {
      return {
        ok: false, error: 'credit_limit_reached',
        detail: `This demo session has used all ${credits.limit} allotted turns. Ask an admin to raise the `
          + `limit for this session, or start a new one.`,
        trace: [], credits,
      };
    }
    if (liveAI) {
      credits.used += 1;
      await this.ctx.storage.put('credits', credits);
    }

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
    const mk = (actor: string) => new Kernel(actor, trace, this.env, { liveAI });
    const orch = mk('orchestrator');
    trace.add({ stage: 'route', actor: 'channel', label: 'trigger captured',
      detail: { session: this.ctx.id.toString().slice(0, 12), customerId, utterance: text }, m3_ref: 'S1.2' });

    try {
    // Sequence 1 runs once per session; everything downstream depends on it.
    if (!session.working.segment) {
      trace.add({ stage: 'route', actor: 'orchestrator', label: 'no segment in session context - dispatching Profiling Agent', m3_ref: 'S1.6' });
      const { segment } = await profiling.classify(mk('profiling'), customerId);
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
        const dk = mk('discovery');
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
        const r = await fit.recommend(mk('fit'), customerId, sku, category);
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
        const uk = mk('upsell');
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
        const lk = mk('loyalty');
        const redeemMatch = text.match(/redeem\s+(-?\d+)/i);
        const questQuery = /\b(quest|quests|challenge|challenges|mission|missions)\b/i.test(text);
        const streakQuery = /\b(streak|fit streak|keep streak|badge|badges|eco)\b/i.test(text);
        const statusQuery = /\bhow (many|much)\b/i.test(text) || /\bbalance\b/i.test(text) || /\bpoints\b/i.test(text);

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
        } else if (questQuery) {
          trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Loyalty Agent - style quests query', m3_ref: 'S5.10' });
          const q = await loyalty.getQuests(lk, customerId, segment?.affluence || 'Member', segment?.tier || 'Silver');
          payload = q;
          const questsList = (q.formatted_quests || []).map((quest: any) => {
            const isDone = quest.status === 'completed' || quest.status === 'claimed';
            const icon = isDone ? '✓' : '✦';
            return `• ${icon} **${quest.title}** (${quest.progress}/${quest.target})\n  ${quest.desc}\n  *Reward:* +${quest.reward_points} NeuPoints${quest.badge ? ` · Badge: 🏆 ${quest.badge}` : ''}`;
          }).join('\n\n');
          const badgesList = (q.badges || []).length ? `\n\n🏆 **Badges Unlocked:** ${q.badges.join(' · ')}` : '';
          reply = `✦ **Active AI Style Quests** (${q.tier || 'Member'} Tier)\n\n`
            + (questsList || '• No active quests currently available.')
            + badgesList
            + (q.summary ? `\n\n_${q.summary}_` : '');
        } else if (streakQuery) {
          trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Loyalty Agent - fit streak query', m3_ref: 'S5.12' });
          const s = await loyalty.getStreak(lk, customerId, segment?.affluence || 'Member');
          payload = s;
          const badgesList = (s.badges || []).length ? `\n\n🏆 **Badges Earned:** ${s.badges.join(' · ')}` : '';
          const nextTarget = s.next_milestone
            ? `\n• **Next Milestone:** ${s.next_milestone.target} orders for ${s.next_milestone.multiplier}× multiplier (${s.next_milestone.badge})`
            : '';
          reply = `🔥 **Zero-Return Fit Streak: ${s.fit_streak} Kept Orders** (${s.fit_streak_multiplier}× Accrual Multiplier)\n\n`
            + `• **Reverse Logistics Cost Saved:** ~£${Number(s.estimated_reverse_logistics_saved_gbp).toFixed(2)}\n`
            + `• **Carbon Emissions Avoided:** ${Number(s.estimated_co2_kg_saved).toFixed(1)} kg CO₂`
            + nextTarget
            + badgesList
            + (s.celebration ? `\n\n_${s.celebration}_` : '');
        } else if (statusQuery) {
          trace.add({ stage: 'route', actor: 'orchestrator', label: 'dispatch Loyalty Agent - balance query', m3_ref: 'S5.3' });
          const st = await loyalty.status(lk, customerId);
          payload = st;
          reply = `✨ **NeuPoints Balance: ${st.points_balance} points** (${st.tier} Tier)\n\n`
            + `• **Active Accrual Multiplier:** ${st.multiplier}× combined rate (${st.subscription_multiplier}× plan entitlement, ${st.fit_streak_multiplier}× fit streak)\n`
            + `• **Points to Next Tier:** ${st.points_to_next_tier > 0 ? `${st.points_to_next_tier} points to next milestone` : 'Top tier achieved'}`;
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
      credits,
    };
    } catch (e) {
      return { ok: false, error: 'agent_error', detail: String(e), trace: trace.steps, credits };
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
    const flags = {
      unsafeRanking: !!body.unsafeRanking, semanticSearch: !!body.semanticSearch,
      aiKey: typeof body.aiKey === 'string' ? body.aiKey : undefined,
    };

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
    //
    // AIChatAgent persists an incoming user message to storage BEFORE calling
    // onChatMessage (see @cloudflare/ai-chat's persistMessages(...) ahead of
    // _runExclusiveChatTurn), so `last` above is already a durable row by the time
    // handleTurn's clearMessages() runs. On a customer switch that wipes the just-sent
    // message along with the previous customer's history. Restore it: upsertMessage
    // does a plain SQL append/notify, same as clearMessages, so it's equally safe to
    // await synchronously here (it never touches AIChatAgent's turn queue). `parentId:
    // null` is explicit, not relied-upon auto-detection, since the transcript is empty.
    if (result.ok && result.customerSwitched && last) {
      await this.sessions.session().upsertMessage(last, { parentId: null });
    }

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (!result.ok) {
          writer.write({ type: 'text-start', id: 'reply' });
          writer.write({ type: 'text-delta', id: 'reply', delta: result.detail });
          writer.write({ type: 'text-end', id: 'reply' });
          // Structured, not string-matched: the console detects the credit-limit case (to
          // show a modal rather than just a bubble) off this field, not off `result.detail`'s
          // wording, which is free to change without silently breaking that detection.
          writer.write({
            type: 'data-credits', id: 'turn-credits',
            data: { ...result.credits, blocked: result.error === 'credit_limit_reached' },
          });
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
        writer.write({
          type: 'data-credits', id: 'turn-credits',
          data: { ...result.credits, blocked: false },
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
    if (url.pathname === '/credits') return Response.json(await this.loadCredits());

    if (url.pathname === '/credits/request') {
      if (req.method !== 'POST') return new Response('not found', { status: 404 });
      const credits = await this.loadCredits();
      credits.requestedMore = true;
      await this.ctx.storage.put('credits', credits);
      return Response.json(credits);
    }

    if (url.pathname === '/credits/grant') {
      if (req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = await req.json<any>().catch(() => ({}));
      const limit = Number(body.limit);
      if (!Number.isFinite(limit) || limit < 0) return Response.json({ error: 'invalid_limit' }, { status: 400 });
      const credits = await this.loadCredits();
      credits.limit = limit;
      credits.requestedMore = false;
      await this.ctx.storage.put('credits', credits);
      return Response.json(credits);
    }

    if (url.pathname !== '/message') return new Response('not found', { status: 404 });

    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json', detail: 'request body must be valid JSON' }, { status: 400 }); }
    const { customerId, text, unsafeRanking, semanticSearch, aiKey } = body;
    const result = await this.handleTurn(customerId, text, { unsafeRanking, semanticSearch, aiKey });
    if (!result.ok) return Response.json(result, { status: 500 });
    const { ok, customerSwitched, ...rest } = result;
    return Response.json(rest);
  }
}
