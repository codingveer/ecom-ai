import type { UIMessage } from 'ai';

/**
 * Mirrors `packages/app/src/kernel.ts`'s `TraceStep` shape field-for-field - deliberately
 * duplicated here rather than imported. A type-only `import type { TraceStep } from
 * '../../app/src/kernel'` still pulls the *whole* `kernel.ts` file into the console's
 * TypeScript program (TypeScript type-checks every file reachable by import, not just the
 * specific export used), and that file also exports `GatewayBindings`, which references
 * the ambient `Fetcher` type from `@cloudflare/workers-types`. The console's tsconfig is
 * deliberately DOM-flavoured (`lib: [..., "DOM", "DOM.Iterable"]`, no Workers types - see
 * Task 1) because `@cloudflare/workers-types` declares globals (`Response`, `Request`,
 * `WebSocket`, `fetch`, ...) that collide with DOM's declarations of the same names; only
 * `skipLibCheck` silently suppressing the resulting conflicts would let it "work", but
 * that leaves the console's type environment able to typecheck Workers-only APIs
 * (`caches`, `HTMLRewriter`, `DurableObjectNamespace`, `WebSocketPair`, etc.) as if they
 * existed in a browser. `TraceStep` itself is a plain data shape with no Workers-runtime
 * dependency, so duplicating just it here - the only piece the console actually reads -
 * avoids pulling in `GatewayBindings`/`Fetcher` at all, with far less surface area than
 * adding `@cloudflare/workers-types` to the console's own program. Keep this in sync with
 * `packages/app/src/kernel.ts`'s `TraceStep` if that shape changes.
 */
export type TraceStep = {
  seq: number;
  stage: 'intent' | 'route' | 'tool' | 'llm' | 'policy' | 'memory' | 'agent' | 'outcome';
  actor: string;
  label: string;
  detail?: unknown;
  ms?: number;
  m3_ref?: string;
};

export type TurnTrace = {
  intent: string;
  intent_confidence: number;
  agent: string;
  payload: unknown;
  trace: TraceStep[];
  memory: { within_session: { turns: unknown[]; working: unknown }; across_sessions: Record<string, unknown> };
};

export type ChatMessage = UIMessage<unknown, { trace: TurnTrace }>;
