# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Neu.Tail — a personalisation assistant prototype built as four Cloudflare Workers
(`packages/app`, `packages/tools`, `packages/llm`, `packages/services`) plus a shared
`scripts/` codegen step. It implements a Mission #3 blueprint: five specialist agents
(profiling, discovery, fit, upsell, loyalty) behind one orchestrator, talking to a tool
gateway and an LLM gateway only through service bindings — never to each other's
storage directly. `README.md` explains the product framing and objectives in depth;
`DEVIATIONS.md` documents every place the build diverges from the M3 design and why.
Read both before making architectural changes.

## Commands

```bash
npm install
npm run gen            # regenerate seed.sql, tool bundle, prompt bundle from scripts/
npm run db:local        # apply schema.sql then seed.sql to local D1 (rerun before every demo/test run — it resets state)
npm run dev              # all four Workers concurrently (services:8101, tools:8102, llm:8103, app:8100), service bindings wired
npm run typecheck       # tsc --noEmit for packages/, plus tsconfig.scripts.json for scripts/
npm run smoke            # scripts/smoke.ts — replays the whole demo end-to-end via HTTP, no browser needed
```

Individual workers can be run alone with `npm run dev:services` / `dev:tools` / `dev:llm` / `dev:app` (same ports as above), useful when iterating on one Worker.

There is no separate lint or unit test command — `npm run typecheck` and `npm run smoke` are the correctness gates. To exercise a single flow, curl the relevant endpoint directly (see `DEMO.md` for the full set of demo curls) rather than trying to isolate a "single test" — `smoke.ts` is one linear script, not a test suite with individually selectable cases.

Deploying (only needed for real Cloudflare accounts, not local dev):
```bash
wrangler d1 create NEUTAIL                 # paste the id into packages/services/wrangler.jsonc
wrangler kv namespace create REGISTRY      # paste the id into packages/tools/wrangler.jsonc
npm run db:remote
npm run deploy                              # services, tools, llm, app, in that dependency order
```

## Architecture

**Four Workers, isolated by capability, not by convention.** Look at the four
`wrangler.jsonc` files side by side before changing bindings:
- `neutail-services` (`packages/services`) — the **only** Worker with a `d1_databases`
  binding. `workers_dev: false`; reachable only via service bindings.
- `neutail-tools` (`packages/tools`) — KV (`REGISTRY`), a service binding to
  `services`, and an Analytics Engine dataset (`AUDIT`). No D1.
- `neutail-llm` (`packages/llm`) — a Durable Object (`USAGE`) for token accounting, an
  optional `AI` binding (commented out — Workers AI has no local simulator). No D1, no
  binding to `services`.
- `neutail-app` (`packages/app`) — a Durable Object (`SESSION`), service bindings to
  `tools` and `llm`, and the static asset binding for the demo console. No D1.

The absence of `d1_databases` in three of the four configs is the actual enforcement
mechanism for "agents must never touch the database directly" — it's a platform
capability boundary, not a code convention. Don't add a D1 binding to `app`, `tools`, or
`llm` to take a shortcut; route new data access through a tool contract instead.

**Request flow:** `packages/app/src/index.ts` (Hono) → `SessionDO` (one Durable Object
instance per session id, `packages/app/src/session-do.ts`) → intent classification via
`Kernel.llm()` → one of five agent modules under `packages/app/src/agents/` → each agent
calls out via `Kernel.invoke()` (tool gateway) and `Kernel.llm()` (LLM gateway) only.
Agents never see a URL, DB handle, model name, or provider — `Kernel`
(`packages/app/src/kernel.ts`) is the entire interface they're given, and every call
through it is appended to a `Trace` that's returned to the client alongside the reply.

**Memory has two tiers, deliberately not one:**
- *Within a session* — `SessionDO`'s own Durable Object storage: turn history, resolved
  segment, last category/SKU, pending offer. A different `customerId` arriving on the
  same session id wipes and restarts the DO's state (context must never leak between
  customers even if a session id is reused).
- *Across sessions* — D1, reached via the `context.read` / `context.write` tool
  contracts (`packages/services/src/index.ts` `context_store` table): segment,
  propensity scores, last discovery query, confirmed fit recs, entitlements.

**Tool gateway (`packages/tools/src/index.ts`) is a cut-down MCP,** not a router. Every
call to `POST /invoke` is checked against a `ToolContract` (`packages/tools/src/types.ts`)
pulled from KV: does this contract exist, is the calling agent in `allowed_agents`, do
the args satisfy `input_schema`. Only then does it translate to an HTTP call against
`services` over the service binding. The registry seeds itself from `BUNDLED`
(`packages/tools/src/bundled.ts`, generated from `packages/tools/registry/tools/*.json`)
on first read, then lives entirely in KV — `POST /registry/install` writes a new
contract at runtime with no redeploy and no agent-code change; `POST /registry/reset`
restores the bundled set.

**LLM gateway (`packages/llm/src/index.ts`) owns two things only:** a versioned prompt
registry (`packages/llm/src/prompts.ts`, sourced from `packages/llm/prompts/*.json`) and
a routing table that maps a model *class* (`reasoning` | `low_latency`) to an actual
model per provider — agents ask for a prompt id, never a model. Everything else the
brief asks a gateway to own (logging, caching, rate limiting, per-request analytics) is
AI Gateway, configured via `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_NAME`, not code here.
`LLM_PROVIDER` (`packages/llm/wrangler.jsonc`) selects `mock` | `workers-ai` |
`anthropic` | `openai`; if a live provider call throws, `/complete` catches it and falls
back to `mockComplete` (`packages/llm/src/mock.ts`) with `degraded: true` in the
response metadata rather than erroring — every M3 sequence has a degrade path, and this
mirrors that. `mock` is fully deterministic (no network) and is what demos should be
rehearsed on. Token accounting lives in a second Durable Object, `UsageCounter`
(`packages/llm/src/usage-do.ts`), for one consistent counter across the whole
deployment rather than per-instance numbers.

**Policy is separated from agent logic on purpose.** `packages/app/src/policy.ts` holds
four pure predicate functions (`fairnessBand`, `fitConsent`, `piiMinimisation`,
`upsellFrequencyCap`), each returning a `PolicyVerdict` (`pass`/`block` + reason). Agents
call these and record the verdict via `Kernel.record()`, which always appends to the
trace whether it passes or blocks — an agent cannot suppress or overrule a verdict. The
discovery agent (`packages/app/src/agents/discovery.ts`) applies its own diversity floor
*before* the fairness guardrail even runs (the guardrail is the backstop, not the
mechanism); passing `unsafeRanking: true` on a `/session/:id/message` request disables
that floor so the guardrail visibly blocks and falls back to a neutral ranking — this is
a deliberate demo switch, not a bug.

**Data generation is one-directional and scripted, not hand-maintained.**
`scripts/gen-seed.ts` produces `packages/services/seed.sql` (customers, products,
orders, returns — return reasons assigned by exact quota, not sampled, to hit a fixed
34% baseline return rate the demo quotes back). `scripts/gen-registry.ts` builds
`packages/tools/src/bundled.ts` from the JSON contracts in
`packages/tools/registry/tools/`. `scripts/gen-prompts.ts` builds
`packages/llm/src/prompts.ts` from `packages/llm/prompts/*.json`. If you need to change
seed data, a tool contract, or a prompt, edit the source (SQL generator logic or the
JSON files) and rerun `npm run gen` / `npm run db:local` rather than hand-editing the
generated `seed.sql` or `bundled.ts` — they get overwritten.

**Every trace step is tagged with the M3 sequence step it implements** (e.g. `S2.6`,
`S4.12`) via the `m3_ref` field on `TraceStep`. When adding or changing orchestration
logic, keep this tagging intact — it's how the demo maps the running system back to the
design blueprint, and `DEMO.md` / `DEVIATIONS.md` reference these step ids directly.

## Known deviations from the M3 design

Eight are logged in `DEVIATIONS.md` (lexical search instead of a vector DB, synchronous
dispatch instead of a Kafka event bus, TypeScript predicates instead of Rego, a
scorecard instead of a learned fit-confidence model, both monetisation agents built
instead of one, live-computed profiling instead of pre-seeded, plus the Cloudflare
platform substitutions: Durable Objects for sessions, AI Gateway for logging/caching,
Analytics Engine for the audit trail, KV for the tool registry). Check there before
assuming a gap is unintentional.
