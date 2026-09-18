# React console on useAgentChat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written `packages/app/public/index.html` demo console with a
Vite + React 19 console driven by `useAgentChat`, backed by a `SessionAgent` Durable
Object that extends `AIChatAgent` purely as a transport/persistence wrapper around the
existing, unmodified five-agent orchestrator.

**Architecture:** `SessionDO` is renamed to `SessionAgent` and rebased onto
`AIChatAgent<GatewayBindings>`. All existing orchestration logic (`Kernel`, `Trace`,
the five agent modules, policy checks) moves into a plain `handleTurn()` method,
unchanged in substance, callable from both the existing HTTP `onRequest` path (so
`scripts/smoke.ts` and the loyalty-fix verification keep working exactly as they do
today) and a new `onChatMessage()` path that streams the same already-computed reply
back as a server-paced typewriter effect and attaches trace/payload/memory as a
`data-trace` UI message part. A new `packages/console` Vite+React workspace is the only
new package; it builds into `packages/app/public`, which the app Worker already serves.

**Tech Stack:** Vite 8, React 19, TypeScript, `agents` 0.23 (Cloudflare Agents SDK),
`@cloudflare/ai-chat` 0.12, `ai` 7 (Vercel AI SDK core), `@ai-sdk/react` 4,
`hono-agents` 3 (Hono middleware for agent routing).

## Global Constraints

- No new test framework. Verification is `npm run typecheck`, the existing
  `npm run smoke`, and manual browser verification through the real console — matching
  this repo's existing convention (see `CLAUDE.md`: "no separate lint or unit test
  command").
- `packages/app`, `packages/tools`, `packages/llm`, `packages/services` have no
  individual `package.json` — their dependencies live in the ROOT `package.json` and
  Wrangler bundles from the root `node_modules`. `packages/console` is the first package
  in this repo to get its OWN `package.json` (it needs its own Vite/React toolchain and
  its own `tsconfig.json` with DOM + JSX support, which must NOT apply to the
  Workers-side TypeScript).
- Every existing `m3_ref` trace tag, the Kernel/Trace/policy isolation boundary, the
  two-tier memory model, and `admin.html`/`shop.html` are untouched by this plan.
- Package versions (confirmed via `npm view <pkg> version` against the live registry on
  2026-09-18): `agents@0.23.0`, `@cloudflare/ai-chat@0.12.0`, `ai@7.0.106`,
  `@ai-sdk/react@4.0.109`, `hono-agents@3.0.12`, `react@19.3.0`, `react-dom@19.3.0`,
  `vite@8.3.0`, `@vitejs/plugin-react@6.1.1`, `@types/react@19.3.0`,
  `@types/react-dom@19.3.0`.

---

### Task 1: Scaffold `packages/console` (Vite + React), wired into `dev` and `typecheck`

**Files:**
- Create: `packages/console/package.json`
- Create: `packages/console/tsconfig.json`
- Create: `packages/console/vite.config.ts`
- Create: `packages/console/index.html`
- Create: `packages/console/src/main.tsx`
- Create: `packages/console/src/App.tsx`
- Create: `packages/console/src/index.css`
- Modify: `/tsconfig.json` (add `exclude`)
- Modify: `/package.json` (scripts, root `dev` process list)

**Interfaces:**
- Produces: a placeholder `App` component and a build that writes `index.html` +
  hashed asset files into `packages/app/public/`, alongside the untouched
  `admin.html`/`shop.html`.

- [ ] **Step 1: Create `packages/console/package.json`**

```json
{
  "name": "@neutail/console",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "agents": "^0.23.0",
    "@cloudflare/ai-chat": "^0.12.0",
    "ai": "^7.0.106",
    "@ai-sdk/react": "^4.0.109"
  },
  "devDependencies": {
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "typescript": "^5.6.3",
    "vite": "^8.3.0"
  }
}
```

- [ ] **Step 2: Create `packages/console/tsconfig.json`**

This is deliberately separate from the root `tsconfig.json` — it needs `DOM` lib and
JSX, which the Workers-side config must not have.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Exclude `packages/console` from the root `tsconfig.json`**

Modify `/tsconfig.json` — add an `exclude` key so the root Workers-focused `tsc --noEmit`
run (no DOM lib, no `jsx` option) never tries to compile `packages/console`'s `.tsx`
files:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["packages/**/*"],
  "exclude": ["packages/console/**/*"]
}
```

- [ ] **Step 4: Create `packages/console/vite.config.ts`**

`emptyOutDir: false` is deliberate: `admin.html` and `shop.html` live in the same
`packages/app/public/` directory and are not Vite's to manage — Vite only ever
overwrites its own output files (`index.html`, `assets/*`) there.

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/agents': { target: 'http://localhost:8100', ws: true },
      '/session': 'http://localhost:8100',
    },
  },
  build: {
    outDir: '../app/public',
    emptyOutDir: false,
  },
});
```

- [ ] **Step 5: Create `packages/console/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Neu.Tail Digital Personalisation Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `packages/console/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Create a placeholder `packages/console/src/App.tsx` and empty `packages/console/src/index.css`**

Placeholder only — Task 4 replaces this with the real console.

```tsx
export default function App() {
  return <p>console scaffold - replaced in Task 4</p>;
}
```

`packages/console/src/index.css` — empty file for now.

- [ ] **Step 8: Add npm scripts to root `/package.json`**

Add `dev:console`, add `console` to the `dev` concurrently process list, and add the
console's typecheck to the root `typecheck` chain:

```json
"dev:console": "npm run dev --workspace @neutail/console",
"dev": "concurrently -n services,tools,llm,app,console -c blue,magenta,yellow,green,cyan \"npm:dev:services\" \"npm:dev:tools\" \"npm:dev:llm\" \"npm:dev:app\" \"npm:dev:console\"",
"typecheck": "tsc --noEmit && tsc -p tsconfig.scripts.json && npm run typecheck --workspace @neutail/console",
```

- [ ] **Step 9: Install dependencies**

```bash
npm install
```

Expected: `packages/console` appears as a workspace; `node_modules/.package-lock.json`
picks up `react`, `agents`, `@cloudflare/ai-chat`, `ai`, `vite`, etc.

- [ ] **Step 10: Verify typecheck passes with the new package present**

```bash
npm run typecheck
```

Expected: all four `tsc` invocations succeed (the root Workers config never sees
`packages/console`; the console's own config only sees its own `src/`).

- [ ] **Step 11: Verify the dev server serves the placeholder**

```bash
npm run dev
```

Then open the Vite dev URL it prints (default `http://localhost:5173`) in a browser —
expect to see "console scaffold - replaced in Task 4". Stop the dev processes
afterward (`Ctrl-C`).

- [ ] **Step 12: Commit**

```bash
git add packages/console package.json tsconfig.json package-lock.json
git commit -m "Scaffold packages/console (Vite + React), wired into dev and typecheck"
```

---

### Task 2: Rebase `SessionDO` onto `AIChatAgent` as `SessionAgent`, preserving existing HTTP behavior exactly

**Files:**
- Modify: `packages/app/src/session-do.ts` (rename class, extract `handleTurn`, rename
  `this.state.storage` → `this.ctx.storage`)
- Modify: `packages/app/src/index.ts` (rename `SESSION` binding references to
  `SessionAgent`)
- Modify: `packages/app/wrangler.jsonc` (rename binding, add `nodejs_compat`)
- Modify: root `package.json` (add `agents`, `@cloudflare/ai-chat`, `ai`, `hono-agents`
  to `dependencies`)

**Interfaces:**
- Produces: `SessionAgent` class with a `private async handleTurn(customerId: string,
  text: string, flags: { unsafeRanking?: boolean; semanticSearch?: boolean }):
  Promise<TurnResult>` method, where
  `type TurnResult = { ok: true; reply: string; intent: string; intent_confidence:
  number; agent: string; payload: unknown; trace: TraceStep[]; memory: { within_session:
  unknown; across_sessions: unknown }; customerSwitched: boolean } | { ok: false; error:
  string; detail: string; trace: TraceStep[] }`. Task 3 consumes this exact signature
  from `onChatMessage`.
- Consumes: nothing new from other tasks (this task only touches existing code).

This task deliberately does NOT add `onChatMessage` yet — it only proves `AIChatAgent`
can be the base class without breaking anything already working, verified by the
UNCHANGED `scripts/smoke.ts` passing.

- [ ] **Step 1: Add dependencies to root `package.json`**

```json
"dependencies": {
  "hono": "^4.13.7",
  "agents": "^0.23.0",
  "@cloudflare/ai-chat": "^0.12.0",
  "ai": "^7.0.106",
  "hono-agents": "^3.0.12"
}
```

Run `npm install`.

- [ ] **Step 2: Add `nodejs_compat` and rename the binding in `packages/app/wrangler.jsonc`**

The `agents` package requires `nodejs_compat` to function (documented requirement, not
optional). Replace the `durable_objects`/`migrations` blocks:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "neutail-app",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],

  // No d1_databases. The Worker running the five agents has no path to the database
  // at all - the platform will not give it one. This is the strongest form of the
  // "agents must never read the database directly" requirement.
  "durable_objects": {
    "bindings": [{ "name": "SessionAgent", "class_name": "SessionAgent" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionAgent"] }
  ],
  "services": [
    { "binding": "TOOLS", "service": "neutail-tools" },
    { "binding": "LLM", "service": "neutail-llm" }
  ],
  "assets": { "directory": "public", "binding": "ASSETS" }
}
```

- [ ] **Step 3: Rewrite `packages/app/src/session-do.ts`**

Full replacement. Every line of orchestration logic below is copied verbatim from the
current file — only the class shape, storage accessor (`this.state.storage` →
`this.ctx.storage`, `this.state.id` → `this.ctx.id`), and the `/message` handler's
extraction into `handleTurn` change.

```ts
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
import { AIChatAgent } from '@cloudflare/ai-chat';
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
    // between people, even if a session id is reused.
    const customerSwitched = !!session.customerId && session.customerId !== customerId;
    if (customerSwitched) {
      session = { customerId, startedAt: new Date().toISOString(), turns: [], working: {} };
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

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/state') return Response.json(await this.load());
    if (url.pathname === '/reset') { await this.ctx.storage.deleteAll(); return Response.json({ reset: true }); }
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
```

- [ ] **Step 4: Confirm `TraceStep` is exported from `packages/app/src/kernel.ts`**

`session-do.ts` now imports `type TraceStep` from `./kernel.js`. Open
`packages/app/src/kernel.ts:11` and confirm `export type TraceStep = { ... }` already
has `export` (it does, per the current file) — no change needed here, this step is a
verification-only check.

- [ ] **Step 5: Update `packages/app/src/index.ts`**

Rename every `SESSION` reference to `SessionAgent` and the export at the bottom:

```ts
type Env = GatewayBindings & { SessionAgent: DurableObjectNamespace; ASSETS: Fetcher };
const app = new Hono<{ Bindings: Env }>();

const session = (env: Env, id: string) => env.SessionAgent.get(env.SessionAgent.idFromName(id));
```

And at the bottom of the file:

```ts
export default app;
export { SessionAgent } from './session-do.js';
```

Every other line in `index.ts` (the `/session/:id/message`, `/session/:id`,
`/session/:id/reset` routes, `/outcome`, `/health`, `/admin/*`) stays byte-for-byte
identical — they only ever reference the `session(...)` helper, not the binding name
directly.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: passes. If `@cloudflare/ai-chat` or `agents` type declarations conflict with
`@cloudflare/workers-types`, the error will name the exact conflicting symbol - resolve
by checking the package's own `.d.ts` before changing anything else.

- [ ] **Step 7: Regenerate local D1 and run the full smoke suite**

```bash
npm run db:local
npm run dev
```

In a second terminal, once all five processes report ready:

```bash
npm run smoke
```

Expected: **identical output to before this task** (same beats, same replies, same
trace shapes) - `handleTurn`'s logic is unchanged, only its home (`SessionAgent` vs
`SessionDO`) and storage accessor (`this.ctx.storage` vs `this.state.storage`) changed.
This is the proof that rebasing onto `AIChatAgent` did not silently alter behavior.

- [ ] **Step 8: Manually verify the loyalty balance/shortfall fix still works over the renamed class**

```bash
SID="verify-rebase-$RANDOM"
curl -s -X POST http://localhost:8100/session/$SID/message -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"C002\",\"text\":\"how many points do I have\"}" | grep -o '"reply":"[^"]*"'
curl -s -X POST http://localhost:8100/session/$SID/message -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"C002\",\"text\":\"how many more do I need\"}" | grep -o '"reply":"[^"]*"'
```

Expected: a real balance on the first reply, and "You need N more points..." on the
second — same as the loyalty fix verified earlier in this project, now proven to
survive the `AIChatAgent` rebase.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/session-do.ts packages/app/src/index.ts packages/app/wrangler.jsonc package.json package-lock.json
git commit -m "Rebase SessionDO onto AIChatAgent as SessionAgent, preserving existing HTTP behavior"
```

---

### Task 3: Add `onChatMessage` - stream the existing orchestrator's reply, attach trace as a data part

**Files:**
- Modify: `packages/app/src/session-do.ts` (add `onChatMessage`)
- Modify: `packages/app/src/index.ts` (mount `agentsMiddleware()`)

**Interfaces:**
- Consumes: `this.handleTurn(customerId, text, flags): Promise<TurnResult>` from Task 2,
  unchanged.
- Produces: a working WebSocket chat endpoint at `/agents/session-agent/:name` that
  Task 4's `useAgentChat` client connects to. Assistant messages carry a `data-trace`
  part with shape `{ intent: string; intent_confidence: number; agent: string; payload:
  unknown; trace: TraceStep[]; memory: unknown }`. Task 4 reads this exact shape.

- [ ] **Step 1: Mount `agentsMiddleware()` in `packages/app/src/index.ts`**

Add as the FIRST middleware, before any route:

```ts
import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';
import { Kernel, Trace, type GatewayBindings } from './kernel.js';

type Env = GatewayBindings & { SessionAgent: DurableObjectNamespace; ASSETS: Fetcher };
const app = new Hono<{ Bindings: Env }>();

app.use('*', agentsMiddleware());

const session = (env: Env, id: string) => env.SessionAgent.get(env.SessionAgent.idFromName(id));
```

Nothing else in the file changes - none of the existing routes use the `/agents/*`
path prefix, so there is no collision.

- [ ] **Step 2: Add `onChatMessage` to `packages/app/src/session-do.ts`**

Add the following import at the top of the file:

```ts
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
```

Add the method to the `SessionAgent` class, after `handleTurn`:

```ts
  async onChatMessage(
    _onFinish: unknown,
    options?: { body?: Record<string, unknown> },
  ): Promise<Response> {
    const last = this.messages[this.messages.length - 1];
    const text = last?.parts?.filter(p => p.type === 'text').map(p => (p as any).text).join('') ?? '';
    const body = options?.body ?? {};
    const customerId = String(body.customerId ?? '');
    const flags = { unsafeRanking: !!body.unsafeRanking, semanticSearch: !!body.semanticSearch };

    const result = await this.handleTurn(customerId, text, flags);

    if (result.ok && result.customerSwitched) {
      // A different customer arrived on this session id - the visible transcript must
      // wipe too, not just the working memory handleTurn already reset.
      await this.saveMessages([]);
    }

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
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes. If `this.messages[...].parts` or `(this as any).options?.body` don't
match the installed `@cloudflare/ai-chat@0.12.0` types exactly, the error names the
mismatch - check `node_modules/@cloudflare/ai-chat/dist/*.d.ts` for the real
`onChatMessage(onFinish, options)` signature and the `UIMessage` shape before adjusting;
this is exactly the "spike the round-trip" risk called out in the design spec.

- [ ] **Step 4: Verify the WebSocket endpoint responds, using a throwaway Node script**

This checks the plumbing BEFORE Task 4's real client exists, using the framework's own
documented low-level client rather than hand-rolled protocol bytes:

Create `/tmp/verify-agent-ws.mjs` (not committed - scratch verification only):

```js
import { AgentClient } from 'agents/client';

const client = new AgentClient({ agent: 'SessionAgent', name: 'verify-' + Date.now(), host: 'localhost:8100' });
await client.ready;
console.log('connected:', client.readyState === client.OPEN);
client.close();
```

```bash
node /tmp/verify-agent-ws.mjs
```

Expected: `connected: true`. This proves `agentsMiddleware()` + the renamed
`SessionAgent` binding correctly accept a WebSocket upgrade at
`/agents/session-agent/:name` - the full chat-turn round-trip (text streaming +
`data-trace`) is verified through the real React console in Task 4, since there is no
documented framework-agnostic equivalent of `useAgentChat` to script against, and
hand-rolling the `CF_AGENT_USE_CHAT_REQUEST` wire protocol here would be exactly the
kind of undocumented, fragile usage this plan is trying to avoid.

- [ ] **Step 5: Run the existing smoke suite again to confirm no regression**

```bash
npm run smoke
```

Expected: identical to Task 2's run - `onChatMessage` is a new, additive code path;
`onRequest`'s `/message` handling is untouched.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/session-do.ts packages/app/src/index.ts
git commit -m "Add onChatMessage: stream the existing orchestrator's reply, attach trace as a data part"
```

---

### Task 4: Build the real React console

**Files:**
- Modify: `packages/console/src/App.tsx` (replace placeholder)
- Modify: `packages/console/src/index.css` (port visual design from the old
  `packages/app/public/index.html`)
- Create: `packages/console/src/ChatMessage.ts` (shared type)

**Interfaces:**
- Consumes: `data-trace` part shape from Task 3 - `{ intent, intent_confidence, agent,
  payload, trace: TraceStep[], memory }`. `TraceStep` fields used: `seq`, `stage`,
  `actor`, `label`, `detail`, `ms`, `m3_ref` (same fields the old `index.html`'s
  `renderTrace` read).
- Produces: the customer-facing console at the console's own dev URL (proxying to the
  app Worker) and, after a build, at `http://localhost:8100/`.

- [ ] **Step 1: Create `packages/console/src/ChatMessage.ts`**

```ts
import type { UIMessage } from 'ai';
import type { TraceStep } from '../../app/src/kernel';

export type TurnTrace = {
  intent: string;
  intent_confidence: number;
  agent: string;
  payload: unknown;
  trace: TraceStep[];
  memory: { within_session: { turns: unknown[]; working: unknown }; across_sessions: Record<string, unknown> };
};

export type ChatMessage = UIMessage<unknown, { trace: TurnTrace }>;
```

`../../app/src/kernel` is a type-only cross-package import (no runtime dependency) —
this repo already has no workspace boundary enforcement between `packages/*` for
TypeScript types (the root `tsconfig.json` includes all of `packages/**/*`), so this
matches the existing convention rather than introducing a new one.

- [ ] **Step 2: Replace `packages/console/src/index.css`**

Port the existing visual design verbatim from `packages/app/public/index.html`'s
`<style>` block (selectors are already class-name based and framework-agnostic):

```css
:root{
  --ink:#101A3D; --paper:#fff; --rule:#DBDFEC; --mute:#5E6684;
  --front:#F4F6FB; --violet:#5B4B9E; --teal:#0E7C7B; --coral:#D9451F; --amber:#8A6A12;
}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
     color:var(--ink);background:var(--paper);height:100vh;display:flex;flex-direction:column}
header{border-bottom:1px solid var(--rule);padding:14px 22px;display:flex;gap:22px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--mute);font-size:13px}
.personas{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.persona{border:1px solid var(--rule);background:#fff;border-radius:999px;padding:6px 13px;cursor:pointer;
         font-size:13px;color:var(--ink);transition:background .12s,border-color .12s}
.persona:hover{background:var(--front)}
.persona[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.persona:focus-visible{outline:2px solid var(--violet);outline-offset:2px}

main{flex:1;display:grid;grid-template-columns:minmax(340px,44fr) 0 minmax(380px,56fr);min-height:0}
.front{background:var(--front);display:flex;flex-direction:column;min-height:0}
.visibility{position:relative;background:transparent}
.visibility::before{content:"";position:absolute;inset:0 auto 0 -1px;border-left:2px dashed var(--rule)}
.visibility span{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-90deg);
  transform-origin:center;white-space:nowrap;font-size:10.5px;letter-spacing:.16em;color:var(--mute);
  background:var(--paper);padding:5px 9px}

.panehead{padding:11px 20px;border-bottom:1px solid var(--rule);font-size:12.5px;color:var(--mute)}
.stream{flex:1;overflow:auto;padding:18px 20px;min-height:0}

.msg{margin-bottom:16px;max-width:56ch}
.msg.you{margin-left:auto;text-align:right}
.msg .who{font-size:11.5px;color:var(--mute);margin-bottom:4px}
.bubble{display:inline-block;text-align:left;padding:11px 14px;border-radius:12px;white-space:pre-wrap}
.you .bubble{background:var(--ink);color:#fff;border-bottom-right-radius:4px}
.bot .bubble{background:#fff;border:1px solid var(--rule);border-bottom-left-radius:4px;
             font-family:Georgia,"Iowan Old Style",serif;font-size:15.5px;line-height:1.6}

.composer{border-top:1px solid var(--rule);padding:12px;display:flex;gap:9px;background:#fff}
input[type=text]{flex:1;border:1px solid var(--rule);border-radius:9px;padding:10px 13px;font:inherit;color:inherit}
input[type=text]:focus-visible{outline:2px solid var(--violet);outline-offset:1px}
button.send{border:0;background:var(--ink);color:#fff;border-radius:9px;padding:10px 17px;font:inherit;cursor:pointer}
button.send:disabled{opacity:.45;cursor:default}
.chips{display:flex;gap:7px;flex-wrap:wrap;padding:0 12px 11px;background:#fff}
.chip{border:1px solid var(--rule);background:#fff;border-radius:7px;padding:5px 10px;font-size:12.5px;cursor:pointer;color:var(--mute)}
.chip:hover{color:var(--ink);border-color:var(--mute)}

.step{display:grid;grid-template-columns:34px 96px 1fr;gap:11px;padding:8px 0;border-bottom:1px solid #EEF0F6;font-size:13px}
.n{color:#A6ADC4;font-variant-numeric:tabular-nums;font-size:12px;padding-top:2px}
.badge{font-size:10.5px;letter-spacing:.07em;padding:3px 0;color:var(--mute);padding-top:3px}
.badge.tool{color:var(--teal)} .badge.llm{color:var(--violet)}
.badge.policy{color:var(--amber)} .badge.intent{color:var(--ink)} .badge.memory{color:var(--mute)}
.label{font-weight:550}
.detail{color:var(--mute);font-size:12px;margin-top:2px;word-break:break-word}
.ref{display:inline-block;margin-left:7px;font-size:10.5px;color:var(--violet);border:1px solid #DDD8EE;
     border-radius:4px;padding:1px 5px;vertical-align:1px}
.ms{float:right;color:#A6ADC4;font-size:11.5px;font-variant-numeric:tabular-nums}
.blocked .label{color:var(--coral)}
.meter{border-top:1px solid var(--rule);padding:9px 20px;font-size:12px;color:var(--mute);
       display:flex;gap:20px;flex-wrap:wrap;background:#fff}
.meter b{font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.empty{color:var(--mute);font-size:13.5px;max-width:44ch}
@media (max-width:900px){main{grid-template-columns:1fr}.visibility{display:none}}
```

(The old file's `.trace-thumb`/`skuImages` client-side thumbnail harvesting is dropped
deliberately — it was a cosmetic add-on unrelated to this spec's scope, not a
regression: nothing in the spec asked for it, and re-adding it can be a follow-up.)

- [ ] **Step 3: Replace `packages/console/src/App.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import type { ChatMessage, TurnTrace } from './ChatMessage';

const PERSONAS = [
  { id: 'C001', name: 'Priya', note: 'affluent, loyal, rich fit history' },
  { id: 'C002', name: 'Aditi', note: 'value-seeking, new, no fit consent' },
  { id: 'C003', name: 'Meera', note: 'free tier, third styling session' },
  { id: 'C004', name: 'Arjun', note: 'menswear department, mid affluence' },
];
const SUGGESTIONS = [
  'show me an occasion dress',
  'what size should I get?',
  'tell me about the styling advisory plan',
  'how many points did I earn?',
];

function newSessionId(customerId: string) {
  return 'web-' + customerId + '-' + Date.now();
}

function traceOf(message: ChatMessage): TurnTrace | undefined {
  const part = message.parts.find(p => p.type === 'data-trace');
  return part && 'data' in part ? (part.data as TurnTrace) : undefined;
}

export default function App() {
  const [customerId, setCustomerId] = useState('C001');
  const [sessionId, setSessionId] = useState(() => newSessionId('C001'));
  const [input, setInput] = useState('');
  const [memorySummary, setMemorySummary] = useState('');

  const agent = useAgent({ agent: 'SessionAgent', name: sessionId });
  const { messages, sendMessage, status } = useAgentChat<unknown, ChatMessage>({
    agent,
    body: () => ({ customerId }),
  });

  useEffect(() => {
    fetch(`/session/${sessionId}`)
      .then(r => r.json())
      .then((d: any) => {
        setMemorySummary(
          `session turns ${d.turns?.length ?? 0} · long-term keys ${Object.keys(d.working ?? {}).length}`,
        );
      })
      .catch(() => setMemorySummary(''));
  }, [sessionId]);

  function switchCustomer(id: string) {
    setCustomerId(id);
    setSessionId(newSessionId(id));
  }

  function send(text: string) {
    if (!text.trim()) return;
    sendMessage({ text });
    setInput('');
  }

  const totals = useMemo(() => {
    const t = { tools: 0, llm: 0, tokens: 0, policy: 0 };
    for (const m of messages) {
      const tr = traceOf(m);
      if (!tr) continue;
      for (const s of tr.trace) {
        if (s.stage === 'tool') t.tools++;
        if (s.stage === 'policy') t.policy++;
        if (s.stage === 'llm') {
          t.llm++;
          const d = s.detail as any;
          t.tokens += (d?.tokens_in ?? 0) + (d?.tokens_out ?? 0);
        }
      }
    }
    return t;
  }, [messages]);

  const lastTrace = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const tr = traceOf(messages[i]);
      if (tr) return tr;
    }
    return undefined;
  }, [messages]);

  return (
    <>
      <header>
        <div>
          <h1>Neu.Tail Digital Personalisation Assistant</h1>
          <div className="sub">Mission #4 prototype · five agents, one orchestrator, one shared context</div>
        </div>
        <div className="personas">
          {PERSONAS.map(p => (
            <button
              key={p.id}
              className="persona"
              aria-pressed={p.id === customerId}
              title={p.note}
              onClick={() => switchCustomer(p.id)}
            >
              {p.name} · {p.id}
            </button>
          ))}
        </div>
        <a href="/shop.html" style={{ fontSize: 12.5, color: 'var(--violet)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
          View storefront mockup →
        </a>
      </header>

      <main>
        <section className="front">
          <div className="panehead">What the customer sees</div>
          <div className="stream">
            {messages.length === 0 && (
              <p className="empty">
                Pick a customer, then ask for a product, a size, your plan or your points. The same question to a
                different customer takes a different path.
              </p>
            )}
            {messages.map(m => {
              const text = m.parts.filter(p => p.type === 'text').map(p => (p as any).text).join('');
              const tr = traceOf(m);
              return (
                <div key={m.id} className={'msg ' + (m.role === 'user' ? 'you' : 'bot')}>
                  <div className="who">{m.role === 'user' ? `You · ${customerId}` : `Assistant · ${tr?.agent ?? ''} agent`}</div>
                  <div className="bubble">{text}</div>
                </div>
              );
            })}
          </div>
          <div className="chips">
            {SUGGESTIONS.map(s => (
              <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
            ))}
          </div>
          <div className="composer">
            <input
              type="text"
              placeholder="Ask the assistant"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send(input); }}
            />
            <button className="send" disabled={status !== 'ready'} onClick={() => send(input)}>Send</button>
          </div>
        </section>

        <div className="visibility"><span>LINE OF VISIBILITY</span></div>

        <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="panehead">What the system did · every step mapped to the M3 sequence diagrams</div>
          <div className="stream">
            {!lastTrace && (
              <p className="empty">
                The trace appears here: intent detection, agent routing, every tool contract invoked, every policy
                evaluation, and the tokens each model call cost.
              </p>
            )}
            {lastTrace?.trace.map(s => {
              const blocked = typeof s.label === 'string' && s.label.includes(': block');
              const detailText = s.detail == null ? '' : typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail);
              return (
                <div key={s.seq} className={'step' + (blocked ? ' blocked' : '')}>
                  <div className="n">{s.seq}</div>
                  <div className={'badge ' + s.stage}>{s.stage}</div>
                  <div>
                    <span className="label">{s.label}</span>
                    {s.m3_ref && <span className="ref">{s.m3_ref}</span>}
                    {s.ms != null && <span className="ms">{s.ms} ms</span>}
                    {detailText && (
                      <div className="detail">{detailText.length > 300 ? detailText.slice(0, 300) + '…' : detailText}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="meter">
            <span>tools <b>{totals.tools}</b></span>
            <span>model calls <b>{totals.llm}</b></span>
            <span>tokens <b>{totals.tokens}</b></span>
            <span>policy checks <b>{totals.policy}</b></span>
            <span>{memorySummary}</span>
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: passes. If `useAgentChat`'s message-part typing doesn't match
`traceOf`'s narrowing, the error names the mismatch — adjust `ChatMessage.ts`'s generic
parameters to match the installed `@cloudflare/ai-chat@0.12.0` types exactly rather than
casting it away.

- [ ] **Step 5: Manual browser verification**

```bash
npm run db:local
npm run dev
```

Open the console's dev URL in a browser (through the Browser pane if available) and:
1. Click a customer chip, confirm it's marked `aria-pressed`.
2. Send "how many points do I have" — confirm the reply reveals with a visible
   typewriter effect and the right pane populates with a real trace ending in
   `loyalty.event`.
3. Send "how many more do I need" — confirm it answers with a real shortfall number,
   not a new fabricated purchase (this is the loyalty fix from earlier in this project,
   now proven over the WebSocket transport).
4. Reload the page — confirm the message history persists (this is the concrete test of
   "maintains history and memory of the chat conversation").
5. Switch to a different customer chip — confirm the chat pane clears and a fresh
   session starts.
6. Navigate to `/shop.html` and `/admin/products` directly — confirm both still load
   (proves `emptyOutDir: false` didn't destroy them).

- [ ] **Step 6: Commit**

```bash
git add packages/console
git commit -m "Build the real React console on useAgentChat"
```

---

### Task 5: Production build wiring and final regression pass

**Files:**
- Modify: root `package.json` (add a `build:console` step ahead of `deploy`)
- No test files — this task is verification-only plus one script addition.

- [ ] **Step 1: Add a `build:console` script and wire it into `deploy`**

```json
"build:console": "npm run build --workspace @neutail/console",
"deploy": "npm run build:console && wrangler deploy --config packages/services/wrangler.jsonc && wrangler deploy --config packages/tools/wrangler.jsonc && wrangler deploy --config packages/llm/wrangler.jsonc && wrangler deploy --config packages/app/wrangler.jsonc",
```

- [ ] **Step 2: Run the production build and confirm `packages/app/public` is correct**

```bash
npm run build:console
ls packages/app/public
```

Expected: `index.html` (Vite-built, replacing the old hand-written one),
`assets/` (hashed JS/CSS), plus the untouched `admin.html` and `shop.html`.

- [ ] **Step 3: Full regression pass**

```bash
npm run typecheck
npm run db:local
npm run dev
npm run smoke
```

Expected: `typecheck` passes across all four `tsc` invocations; `smoke` produces
output identical to the pre-this-plan baseline (same beats, same replies) since
`onRequest`/`handleTurn` is unchanged; manually re-run the Task 4 Step 5 browser
checklist once more against the BUILT assets (`http://localhost:8100/`, not the Vite
dev port) to confirm the production build path works end-to-end, not just the dev
proxy.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "Wire console build into deploy; final regression pass"
```
