# React console on useAgentChat, backed by AIChatAgent

Date: 2026-09-18

Status: approved, pending implementation

## Why

The demo console (`packages/app/public/index.html`) is a static HTML page with
hand-written DOM updates, talking to `SessionDO` over plain request/response HTTP. It
already keeps full turn history and working memory in Durable Object storage
(`packages/app/src/session-do.ts`) - that part isn't broken. What it's missing is the
UI ergonomics of a real chat app: a message-list React frontend, live sync over
WebSocket instead of wait-for-full-JSON, and reconnect/replay on page reload.

`useAgentChat` (from Cloudflare's `agents` npm package) gives exactly that, but it's
built to pair with `AIChatAgent`, whose `onChatMessage` hook is designed to drive a
single model call with tool-calling - not dispatch across five separate hand-written
agent modules with bespoke control flow (regex-matched `redeem N`, pending-offer
acceptance, per-intent policy checks). Replacing the orchestrator with that loop would
mean turning `discovery`/`fit`/`upsell`/`loyalty`/`profiling` into "tools the model
calls," a real product redesign that risks the Kernel/Trace isolation boundary
`CLAUDE.md` documents as load-bearing. This spec instead uses `AIChatAgent` as a thin
transport/persistence wrapper: `onChatMessage` calls the existing orchestrator function
unchanged and streams back its already-fully-known reply, chunk by chunk, as a
server-side typewriter effect. No LLM gateway changes, no orchestrator redesign.

Scope: the customer-facing chat console only. `admin.html` and `shop.html` are not
chat surfaces and stay untouched static assets.

## A. New workspace: `packages/console`

Vite + React 19 + TypeScript. Root `package.json`'s `workspaces` is already the glob
`"packages/*"`, so no change is needed there - the new folder is picked up
automatically. Replaces `packages/app/public/index.html` as the customer-facing
console.

- Dev: `npm run dev` gains a fifth `concurrently` process, `dev:console` (`vite dev`).
  `packages/console/vite.config.ts` proxies `/agents/*` and `/session/*` (HTTP and WS
  upgrades) to `localhost:8100`.
- Build: `vite build` outputs into `packages/app/public/`, served by the existing
  `assets` binding in `packages/app/wrangler.jsonc` exactly as it serves the static
  HTML today. No new deploy step.

## B. `SessionDO` rebased on `AIChatAgent`

`packages/app/src/session-do.ts`: the class extends `AIChatAgent<GatewayBindings>`
instead of the raw Durable Object base. Every existing field and method - `Working`
state, the M3-tagged `Trace`, the five agent module calls, the policy checks - is
unchanged. Today's `/message` handler body is extracted verbatim into a plain
`handleTurn(customerId, text, flags)` method so it's the exact same code path, just
callable from a new entry point.

New `onChatMessage(onFinish)`:

1. Read `customerId`, `unsafeRanking`, `semanticSearch` off the incoming message's
   extra fields (`useChat`/`useAgentChat` support per-message `data`).
2. Call `handleTurn(...)`, returning today's `{ reply, intent, payload, trace, memory }`
   shape.
3. Stream `reply` back in small chunks with a short delay between them via
   `createDataStreamResponse` (or equivalent) - this is the typewriter effect. It is
   streaming only in the sense of pacing an already-fully-known string; no real
   token-level model streaming is introduced anywhere in this spec.
4. Attach `{ intent, payload, trace, memory }` as the assistant message's
   `annotations`, so the client's trace/policy panel has everything it needs without a
   second request.

Session identity is unchanged: `useAgent({ agent: 'session', name: sessionId })` on the
client supplies the same one-DO-instance-per-session-id property that exists today.
`sessionId` is still client-generated (`'web-' + customerId + '-' + Date.now()`). The
"different customerId on the same session id wipes state" rule
(`session-do.ts:64`) is untouched, just reads `customerId` from the message payload
instead of the request body.

`packages/app/src/index.ts` (Hono) adds `routeAgentRequest(request, env)` ahead of the
existing routes, to intercept the `/agents/:agent/:name` paths `useAgent` generates.
Everything else - including `/session/:id/state` and `/session/:id/reset`, which stay
plain HTTP - falls through to Hono unchanged.

## C. Memory model - explicitly unchanged

Within-session state still lives in the DO's own storage via `handleTurn`. Cross-session
state still goes through `context.read`/`context.write` via the tool gateway.
`AIChatAgent`'s own built-in message persistence (its SQLite-backed `this.messages`)
becomes a second, parallel store of just the chat transcript, used for reconnect/replay.
It does not replace `Working` state and is never read by the orchestrator.

## D. Client (`packages/console/src`)

- `App.tsx` mirrors today's two-panel layout: "What the customer sees" (chat thread) on
  the left, "What the system did" (trace, tagged with `m3_ref`) on the right - same
  visual contract as `index.html`, as React components instead of hand-written DOM
  updates.
- `useAgentChat({ agent })` drives the message list and the typewriter reveal - it
  already renders streamed chunks incrementally, so no separate animation code is
  needed.
- The customer switcher (C001-C004 buttons) is preserved. Switching customer re-issues
  `useAgent({ name: sessionId })` with a freshly generated `sessionId`, matching today's
  pattern.
- Each assistant message's `annotations` (intent, payload, trace, memory) feed the
  right-hand panel, re-rendered per message.
- On mount, the client calls `GET /session/:id/state` once (plain HTTP, bypassing the
  agent WS) to show the memory summary bar ("session turns N - long-term keys M")
  before the first message is sent. This endpoint is untouched.

## E. Error handling

- The existing LLM-provider degrade path (`packages/llm`'s `/complete` falling back to
  `mockComplete` with `degraded: true` on a live-provider throw) is unchanged and still
  flows into `trace`/`annotations` exactly as it does today.
- New failure mode: a WebSocket drop mid-turn. `useAgentChat` auto-reconnects and
  replays persisted messages from `AIChatAgent`'s own store. `handleTurn` already
  mutates `Working` state and calls `this.state.storage.put('session', session)`
  synchronously before returning a value, so a turn either fully completes and persists
  before its streamed response starts, or didn't happen - no new atomicity code needed,
  just confirmed by the verification step below.

## F. Explicitly unchanged

The Kernel/Trace/policy architecture; all five agent modules; `m3_ref` tagging; the
tool gateway and LLM gateway contracts; the two-tier memory model; `unsafeRanking` /
`semanticSearch` demo switches; `admin.html` and `shop.html`.

## G. Known risk

`AIChatAgent` is being used slightly off its documented path: its persistence/transport
layer is kept, its own AI-loop (`streamText`/tool-calling) is not used at all. This is
not a pattern Cloudflare's docs demonstrate, so the first implementation pass should
spike just the `onChatMessage` → manual chunked response → client `annotations`
round-trip in isolation, before porting the rest of `handleTurn` on top of it. If the
annotations plumbing doesn't round-trip cleanly, the fallback is a hand-rolled
WebSocket client (skip `useAgentChat`, keep the React frontend) rather than fighting
the framework further.

## H. Verification

`npm run typecheck` first. Then `npm run dev` (five processes) and, through the actual
console in a browser: confirm the two-panel UI updates correctly, confirm the
typewriter reveal, confirm a page reload preserves history (the concrete, testable
version of "maintains history and memory of the chat conversation"), and replay the
loyalty balance/shortfall scenario fixed in `session-do.ts` to confirm it still routes
and answers correctly over the new transport. Add a `scripts/smoke.ts` beat that opens
a WS connection the same way `useAgent` does and asserts on the reassembled reply and
annotations for a couple of turns.
