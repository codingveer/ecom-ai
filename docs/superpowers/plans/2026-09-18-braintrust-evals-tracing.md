# Braintrust Evals + Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Braintrust offline evals (scoring the 5 versioned prompts in
`packages/llm/src/prompts.ts` against real OpenAI output) and online tracing (every
`/complete` call logged to Braintrust), without changing the LLM gateway's existing
behavior for any caller.

**Architecture:** Extract the provider-calling code `packages/llm/src/index.ts` already
has into a new `packages/llm/src/providers.ts` with plain-value signatures, so a
Node-side eval harness can call the *exact* rendering/HTTP code the Worker uses in
production instead of reimplementing it. Offline evals live in a new top-level `evals/`
directory (Node scripts, not a Wrangler package). Online tracing wraps the existing
`/complete` handler's provider-call block in Braintrust's `traced()`, flushed via the
same `waitUntil` pattern already used for the `UsageCounter` write right below it.

**Tech Stack:** `braintrust@3.34.0`, `autoevals@0.3.0`, TypeScript, Cloudflare Workers.

## Global Constraints

- `mock` provider's behavior and output are unchanged by this plan - the eval suite
  runs against real OpenAI (`OPENAI_API_KEY`), since scoring the mock's fixed canned
  text would be meaningless. Online tracing wraps every provider including `mock`, so
  it does get traced (as a `provider: "mock"` entry), but the mock's actual behavior is
  untouched.
- No CI wiring (no CI exists in this repo).
- No Braintrust-hosted dataset management via their UI/API - datasets are inline arrays
  in the eval files.
- `.braintrust.json` and `.env.braintrust` already exist in this repo (added by the
  Braintrust setup wizard, both gitignored - confirmed present). `BRAINTRUST_API_KEY`
  is already set in `.env.braintrust`. `OPENAI_API_KEY` is NOT yet set anywhere - it
  needs to be added to `.env.braintrust` before Tasks 2-3's eval runs can be verified
  end-to-end (ask the human partner for it at that point if it isn't already there).
- None of the four existing Worker packages (`packages/app`, `tools`, `llm`,
  `services`) have their own `package.json` - all Worker dependencies go in the ROOT
  `package.json`, same as `hono` today. `packages/console` (added in a prior plan) is
  the only package with its own `package.json`; this plan does not touch it.
- `packages/llm`'s Cloudflare Worker environment needs `"compatibility_flags":
  ["nodejs_compat"]` added to `packages/llm/wrangler.jsonc` for the `braintrust`
  package to work (confirmed via its Cloudflare Workers smoke-test scenario, which
  requires this flag for its Node-compat entrypoint). `braintrust`'s package.json
  additionally declares a dedicated `"workerd"` conditional export
  (`./dist/workerd.mjs`), which Wrangler's bundler picks automatically - this may
  reduce or eliminate what actually needs `nodejs_compat` for, but the flag is safe to
  add regardless (packages/app already uses it) and Task 4 should verify empirically
  whether `wrangler dev` still needs it after adding the dependency, rather than
  guessing.

---

### Task 1: Extract `packages/llm/src/providers.ts` (shared refactor, no behavior change)

**Files:**
- Create: `packages/llm/src/providers.ts`
- Modify: `packages/llm/src/index.ts`

**Interfaces:**
- Produces: `render(tpl: string, vars: Record<string, unknown>): string`,
  `ROUTING: Record<string, Record<string, string>>`,
  `callAnthropic(apiKey: string, gatewayBase: string | null, model: string, system: string, user: string): Promise<{text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean}>`,
  `callOpenAI(apiKey: string, gatewayBase: string | null, model: string, system: string, user: string): Promise<{text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean}>`,
  `callWorkersAI(ai: Ai, gatewayName: string | null, model: string, system: string, user: string): Promise<{text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean}>`.
  Task 2's eval harness and Task 4's tracing both consume these exact names/signatures.

This is a pure refactor - `index.ts`'s observable behavior (every route, every
response shape) must be byte-for-byte identical before and after. Verified by running
`npm run smoke` before touching anything and comparing output structurally after.

- [ ] **Step 1: Create `packages/llm/src/providers.ts`**

```ts
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

export async function callOpenAI(apiKey: string, gatewayBase: string | null, model: string, system: string, user: string): Promise<ProviderResult> {
  const url = gatewayBase ? `${gatewayBase}/openai/chat/completions` : 'https://api.openai.com/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
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
```

- [ ] **Step 2: Update `packages/llm/src/index.ts` to use `providers.ts`**

Replace the inline `render`, `ROUTING`, `callAnthropic`, `callOpenAI`, `callWorkersAI`
definitions with an import, and update every call site to pass plain values instead of
`env`:

```ts
import { Hono } from 'hono';
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

  let out: { text: string; input_tokens: number; output_tokens: number; via_gateway?: boolean };
  let degraded = false;
  try {
    if (provider === 'workers-ai' && !c.env.AI) throw new Error('AI binding not enabled');
    if (provider === 'anthropic') out = await callAnthropic(c.env.ANTHROPIC_API_KEY ?? '', base, model, prompt.system, user);
    else if (provider === 'openai') out = await callOpenAI(c.env.OPENAI_API_KEY ?? '', base, model, prompt.system, user);
    else if (provider === 'workers-ai') out = await callWorkersAI(c.env.AI!, c.env.AI_GATEWAY_NAME ?? null, model, prompt.system, user);
    else out = mockComplete(prompt_id, variables, prompt.system, user);
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
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Regenerate local D1, run the full stack, run smoke**

```bash
npm run db:local
npm run dev
```

In a second terminal, once all five processes report ready:

```bash
npm run smoke
```

Expected: identical output to the pre-this-task baseline (same beats, same replies,
same trace shapes) - this is a pure refactor, `mockComplete`'s output and every route's
response shape are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/providers.ts packages/llm/src/index.ts
git commit -m "Extract packages/llm/src/providers.ts, no behavior change"
```

---

### Task 2: Eval harness scaffold + `intent.classify` eval (proof of concept)

**Files:**
- Create: `evals/lib/harness.ts`
- Create: `evals/lib/judge.ts`
- Create: `evals/intent-classify.eval.ts`
- Create: `tsconfig.evals.json`
- Modify: root `package.json` (devDependencies, `eval` script, `typecheck` script)

**Interfaces:**
- Consumes: `render`, `ROUTING`, `callOpenAI` from Task 1's `packages/llm/src/providers.ts`; `PROMPTS` from `packages/llm/src/prompts.ts`.
- Produces: `runPrompt(promptId: string, variables: Record<string, unknown>): Promise<string>` in `evals/lib/harness.ts`, consumed by every eval file (this task's and Task 3's).

- [ ] **Step 1: Add `braintrust`/`autoevals` to root `package.json`, add the `eval` script**

```json
"scripts": {
  ...
  "eval": "braintrust eval evals"
},
"devDependencies": {
  "@cloudflare/workers-types": "^5.20260911.1",
  "@types/node": "^26.5.1",
  "autoevals": "^0.3.0",
  "braintrust": "^3.34.0",
  "concurrently": "^9.1.0",
  "tsx": "^4.19.2",
  "typescript": "^5.6.3",
  "wrangler": "^4.131.1"
}
```

- [ ] **Step 2: Create `tsconfig.evals.json`**

Mirrors `tsconfig.scripts.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["evals/**/*"]
}
```

- [ ] **Step 3: Wire `tsconfig.evals.json` into the root `typecheck` script**

```json
"typecheck": "tsc --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.evals.json && npm run typecheck --workspace @neutail/console"
```

- [ ] **Step 4: Create `evals/lib/harness.ts`**

```ts
import { PROMPTS, type Prompt } from '../../packages/llm/src/prompts.js';
import { render, ROUTING, callOpenAI } from '../../packages/llm/src/providers.js';

const prompts = new Map(PROMPTS.map(p => [p.id, p]));

/**
 * Calls the exact rendering and HTTP-calling code packages/llm's Worker uses in
 * production, against real OpenAI - so a prompt-quality regression shows up here
 * before it reaches the demo.
 */
export async function runPrompt(promptId: string, variables: Record<string, unknown>): Promise<string> {
  const prompt = prompts.get(promptId) as Prompt | undefined;
  if (!prompt) throw new Error(`unknown prompt: ${promptId}`);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to run evals (mock output cannot be meaningfully scored)');
  const model = ROUTING.openai[prompt.model_class];
  const user = render(prompt.template, variables);
  const out = await callOpenAI(apiKey, null, model, prompt.system, user);
  return out.text;
}
```

- [ ] **Step 5: Create `evals/lib/judge.ts`**

A shared, optional LLM-judge scorer for general coherence, used by all five eval
files. Uses `autoevals`'s `LLMClassifierFromTemplate`, which is the general-purpose
custom-judge-prompt primitive in `autoevals` (there is no generic "Coherence" scorer
built in):

```ts
import { LLMClassifierFromTemplate } from 'autoevals';

/**
 * Optional, shared across all five eval files: a coherence check independent of any
 * prompt-specific correctness scorer. Easy to drop from an eval file's `scores` array
 * if the extra OpenAI spend per run isn't wanted.
 */
export const coherenceJudge = LLMClassifierFromTemplate({
  name: 'coherence',
  promptTemplate:
    'You are grading whether a retail assistant\'s reply is coherent, on-topic, and ' +
    'appropriately toned. Reply text:\n\n{{output}}\n\nIs this reply coherent and ' +
    'appropriate?',
  choiceScores: { yes: 1, no: 0 },
});
```

- [ ] **Step 6: Create `evals/intent-classify.eval.ts`**

```ts
import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = { utterance: string; history: string; expectedIntent: string };

const cases: Case[] = [
  { utterance: 'show me an occasion dress', history: 'none', expectedIntent: 'discovery.rank' },
  { utterance: 'what size should I get?', history: 'none', expectedIntent: 'fit.check' },
  { utterance: 'tell me about the styling advisory plan', history: 'none', expectedIntent: 'upsell.moment' },
  { utterance: 'how many points did I earn?', history: 'none', expectedIntent: 'loyalty.event' },
  { utterance: 'who am I shopping as today?', history: 'none', expectedIntent: 'profile.refresh' },
  { utterance: 'what about the coat', history: 'fit.check: "will this dress fit true to size"', expectedIntent: 'fit.check' },
];

function parsesAsJson({ output }: { output: string }) {
  try {
    JSON.parse(output.replace(/```json|```/g, '').trim());
    return { name: 'valid_json', score: 1 };
  } catch {
    return { name: 'valid_json', score: 0 };
  }
}

function intentMatches({ output, expected }: { output: string; expected: { expectedIntent: string } }) {
  try {
    const parsed = JSON.parse(output.replace(/```json|```/g, '').trim());
    return { name: 'intent_correct', score: parsed.intent === expected.expectedIntent ? 1 : 0 };
  } catch {
    return { name: 'intent_correct', score: 0 };
  }
}

Eval('neutail-intent-classify', {
  data: () => cases.map(c => ({
    input: { utterance: c.utterance, history: c.history },
    expected: { expectedIntent: c.expectedIntent },
  })),
  task: async (input: { utterance: string; history: string }) =>
    runPrompt('intent.classify', { utterance: input.utterance, history: input.history }),
  scores: [parsesAsJson, intentMatches, coherenceJudge],
});
```

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: passes. If the relative import paths (`../../packages/llm/src/...`) don't
resolve under `tsconfig.evals.json`'s `moduleResolution: "bundler"`, adjust the
`include`/path or add an explicit `paths` mapping - don't guess, read the actual error.

- [ ] **Step 8: Run the eval for real**

`OPENAI_API_KEY` is already present in a root `.env` file (confirmed gitignored - see
the `.gitignore` fix that landed before this plan started; verify with `git status`
that `.env` does not appear before doing anything else if you have any doubt).
`braintrust eval` auto-loads `.env`/`.env.local`-style files, so no extra setup should
be needed - if the key isn't picked up, check `evals/lib/harness.ts`'s
`process.env.OPENAI_API_KEY` read is actually reachable (e.g. `tsx`/the `braintrust`
CLI's runtime genuinely loads `.env` before executing the eval file) rather than
assuming the key is missing.

```bash
npm run eval -- evals/intent-classify.eval.ts
```

If the CLI's file-vs-directory argument behaves differently than expected (i.e. it
insists on the whole `evals` directory and there's no way to scope to one file), run
`npx braintrust eval --help` to find the real flag - don't guess the invocation, and
note in your report whichever form actually worked.

Expected: a real experiment run against OpenAI, printing per-case scores for
`valid_json`, `intent_correct`, and `coherence`. Confirm at least the majority of the 6
cases score `intent_correct: 1` (a real model should get simple lexical-cue cases like
these right most of the time; if scores are surprisingly low, read the actual model
output before assuming the harness is broken - the prompt/model might genuinely be
underperforming, which is exactly what this eval exists to catch).

- [ ] **Step 9: Confirm the experiment actually landed on Braintrust's hosted platform, not just locally**

The eval suite's whole purpose is a shared, online record of prompt quality over time
- an experiment that only printed local scores and never uploaded is not this feature.
`Eval()` uploads by default (nothing in this plan sets `noSendLogs`), and on
completion prints a results URL to stdout (something like `https://www.braintrust.dev/
app/<org>/p/<project>/experiments/<name>`). Capture that URL from Step 8's actual
output and report it.

Then independently confirm via the Braintrust REST API (authenticated with
`BRAINTRUST_API_KEY` from `.env.braintrust`, the same key already configured) rather
than trusting the printed URL alone - e.g. `GET https://api.braintrust.dev/v1/project`
to find the project id matching `BRAINTRUST_PROJECT`/`.braintrust.json`'s project, then
`GET https://api.braintrust.dev/v1/experiment?project_id=<id>` and confirm an
experiment named `neutail-intent-classify` exists with a recent `created` timestamp
and a nonzero row/case count. If the exact endpoint/response shape differs from this
description, check `https://www.braintrust.dev/docs` or the SDK's own REST client
rather than guessing - the point is proving the data really arrived, not matching this
description exactly.

- [ ] **Step 10: Commit**

```bash
git add evals tsconfig.evals.json package.json package-lock.json
git commit -m "Scaffold Braintrust eval harness, add intent.classify eval"
```

Do NOT commit `.env.braintrust` (already gitignored - verify with `git status` that it
does not appear).

---

### Task 3: Remaining four eval files

**Files:**
- Create: `evals/discovery-rationale.eval.ts`
- Create: `evals/fit-explanation.eval.ts`
- Create: `evals/upsell-copy.eval.ts`
- Create: `evals/loyalty-nudge.eval.ts`

**Interfaces:**
- Consumes: `runPrompt` from `evals/lib/harness.ts`, `coherenceJudge` from `evals/lib/judge.ts` (both from Task 2, unchanged).

Each file follows the exact pattern Task 2 established (`Eval(name, {data, task,
scores})`, a custom scorer checking that prompt's specific constraint, plus the shared
`coherenceJudge`). Datasets are drawn from the demo personas already used elsewhere in
this repo (`packages/app/public` used to hand-write these as `C001 Priya`/`C002
Aditi`/`C003 Meera` - same customers, same flavor of evidence).

- [ ] **Step 1: Create `evals/discovery-rationale.eval.ts`**

Custom scorer checks the rationale never mentions a SKU/title outside the ones passed
in `top` (mirrors the prompt's own system-message constraint: "Never invent products").

```ts
import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = {
  segment: string; affluence: number; tier: string; aup: number; premium_share: number;
  fit_size: string; query: string; guardrail_blocked: boolean;
  top: Array<{ title: string; sku: string }>;
};

const cases: Case[] = [
  {
    segment: 'affluent', affluence: 0.82, tier: 'gold', aup: 145.5, premium_share: 0.61,
    fit_size: 'M', query: 'occasion dress', guardrail_blocked: false,
    top: [{ title: 'Silk Wrap Midi Dress', sku: 'SKU-00123' }, { title: 'Tailored Blazer Dress', sku: 'SKU-00456' }],
  },
  {
    segment: 'value_seeking', affluence: 0.23, tier: 'bronze', aup: 34.9, premium_share: 0.05,
    fit_size: 'S', query: 'work trousers', guardrail_blocked: false,
    top: [{ title: 'Cotton Blend Chinos', sku: 'SKU-00789' }],
  },
  {
    segment: 'affluent', affluence: 0.82, tier: 'gold', aup: 145.5, premium_share: 0.61,
    fit_size: 'M', query: 'occasion dress', guardrail_blocked: true,
    top: [{ title: 'Cotton Blend Chinos', sku: 'SKU-00789' }],
  },
];

function noInventedProducts({ output, input }: { output: string; input: Case }) {
  const known = new Set(input.top.flatMap(p => [p.title, p.sku]));
  const mentionsUnknownSku = /SKU-\d{5}/g.test(output) && (output.match(/SKU-\d{5}/g) ?? []).some(sku => !known.has(sku));
  return { name: 'no_invented_products', score: mentionsUnknownSku ? 0 : 1 };
}

function respectsGuardrail({ output, input }: { output: string; input: Case }) {
  if (!input.guardrail_blocked) return { name: 'guardrail_language', score: 1 };
  const mentionsNeutral = /neutral|guardrail|blocked/i.test(output);
  return { name: 'guardrail_language', score: mentionsNeutral ? 1 : 0 };
}

Eval('neutail-discovery-rationale', {
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('discovery.rationale', {
    segment: input.segment, affluence: input.affluence, tier: input.tier, aup: input.aup,
    premium_share: input.premium_share, fit_size: input.fit_size, query: input.query,
    guardrail_blocked: input.guardrail_blocked, top: JSON.stringify(input.top),
  }),
  scores: [noInventedProducts, respectsGuardrail, coherenceJudge],
});
```

- [ ] **Step 2: Create `evals/fit-explanation.eval.ts`**

Custom scorer checks that when `confidence < threshold`, the text contains no size
recommendation language (mirrors "if confidence is below threshold, say plainly that
no recommendation is being made").

```ts
import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = {
  history: string; brand: string; cut: string; category: string; offset: number;
  size: string; confidence: number; threshold: number;
};

const cases: Case[] = [
  { history: '3 orders, true to size', brand: 'Acme', cut: 'regular', category: 'dresses', offset: 0.2, size: 'M', confidence: 88, threshold: 70 },
  { history: 'no fit history', brand: 'Acme', cut: 'runs_small', category: 'knitwear', offset: 1.9, size: 'L', confidence: 42, threshold: 70 },
  { history: '1 order, unclear fit', brand: 'Bexley', cut: 'runs_small', category: 'trousers', offset: 1.4, size: 'S', confidence: 55, threshold: 70 },
];

function respectsThreshold({ output, input }: { output: string; input: Case }) {
  if (input.confidence >= input.threshold) return { name: 'threshold_respected', score: 1 };
  const mentionsSize = new RegExp(`\\b${input.size}\\b`).test(output) || /recommend(ed)? size/i.test(output);
  return { name: 'threshold_respected', score: mentionsSize ? 0 : 1 };
}

Eval('neutail-fit-explanation', {
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('fit.explanation', {
    history: input.history, brand: input.brand, cut: input.cut, category: input.category,
    offset: input.offset, size: input.size, confidence: input.confidence, threshold: input.threshold,
  }),
  scores: [respectsThreshold, coherenceJudge],
});
```

- [ ] **Step 3: Create `evals/upsell-copy.eval.ts`**

Custom scorer checks no exclamation marks and at most two sentences (both the prompt's
explicit constraints).

```ts
import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = { feature: string; sessions: number; signals: string; tier: string; price: number; benefits: string };

const cases: Case[] = [
  { feature: 'Styling Advisory', sessions: 3, signals: 'used 3x in 14 days', tier: 'Plus', price: 9.99, benefits: '2x loyalty accrual, priority styling' },
  { feature: 'Styling Advisory', sessions: 5, signals: 'used weekly for a month', tier: 'Premium', price: 19.99, benefits: 'unlimited styling sessions, early access' },
];

function noExclamationMarks({ output }: { output: string }) {
  return { name: 'no_exclamation_marks', score: output.includes('!') ? 0 : 1 };
}

function atMostTwoSentences({ output }: { output: string }) {
  const sentences = output.split(/(?<=[.?])\s+/).filter(Boolean);
  return { name: 'at_most_two_sentences', score: sentences.length <= 2 ? 1 : 0 };
}

Eval('neutail-upsell-copy', {
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('upsell.copy', {
    feature: input.feature, sessions: input.sessions, signals: input.signals,
    tier: input.tier, price: input.price, benefits: input.benefits,
  }),
  scores: [noExclamationMarks, atMostTwoSentences, coherenceJudge],
});
```

- [ ] **Step 4: Create `evals/loyalty-nudge.eval.ts`**

Same two constraints as `upsell.copy` (no exclamation marks, at most two sentences).

```ts
import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = { awarded: number; multiplier: number; entitlement: string; balance: number; tier: string; to_next: number };

const cases: Case[] = [
  { awarded: 65, multiplier: 1, entitlement: 'free', balance: 269, tier: 'Bronze', to_next: 1231 },
  { awarded: 130, multiplier: 2, entitlement: 'plus', balance: 2370, tier: 'Gold', to_next: 2130 },
];

function noExclamationMarks({ output }: { output: string }) {
  return { name: 'no_exclamation_marks', score: output.includes('!') ? 0 : 1 };
}

function atMostTwoSentences({ output }: { output: string }) {
  const sentences = output.split(/(?<=[.?])\s+/).filter(Boolean);
  return { name: 'at_most_two_sentences', score: sentences.length <= 2 ? 1 : 0 };
}

Eval('neutail-loyalty-nudge', {
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('loyalty.nudge', {
    awarded: input.awarded, multiplier: input.multiplier, entitlement: input.entitlement,
    balance: input.balance, tier: input.tier, to_next: input.to_next,
  }),
  scores: [noExclamationMarks, atMostTwoSentences, coherenceJudge],
});
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Run all five evals for real**

```bash
npm run eval
```

Expected: real experiment runs against OpenAI for all five prompts. Read the actual
per-case scores - confirm each prompt's specific constraint scorer (not just the
coherence judge) passes on the large majority of cases; a genuinely low score on a
specific-constraint scorer (not the judge) means the prompt itself needs attention, not
the harness.

As in Task 2's Step 9, confirm via the Braintrust REST API (not just the printed
output) that all five experiments (`neutail-discovery-rationale`,
`neutail-fit-explanation`, `neutail-upsell-copy`, `neutail-loyalty-nudge`, plus
`neutail-intent-classify` from Task 2) exist on the hosted platform with recent
timestamps and nonzero case counts.

- [ ] **Step 7: Commit**

```bash
git add evals
git commit -m "Add eval files for the remaining four prompts"
```

---

### Task 4: Online tracing (`packages/llm/src/index.ts`, `wrangler.jsonc`)

**Files:**
- Modify: root `package.json` (add `braintrust` to `dependencies`, not just
  `devDependencies` - it's now a Worker runtime dependency too, same as `hono`)
- Modify: `packages/llm/src/index.ts`
- Modify: `packages/llm/wrangler.jsonc`

**Interfaces:**
- Consumes: nothing from Tasks 2-3 (this task only depends on Task 1's `providers.ts`
  refactor already being in place, for a clean diff against the current `/complete`
  handler).

- [ ] **Step 1: Add `braintrust` to root `package.json`'s `dependencies`**

It's already in `devDependencies` from Task 2 (for the eval harness, a Node script).
Workers bundle from `dependencies`, so it also needs to be there for the deployed
`packages/llm` Worker to include it:

```json
"dependencies": {
  "hono": "^4.13.7",
  "agents": "^0.23.0",
  "@cloudflare/ai-chat": "^0.12.0",
  "ai": "^7.0.106",
  "hono-agents": "^3.0.12",
  "braintrust": "^3.34.0"
}
```

(Leave the `devDependencies` entry from Task 2 as-is - a package needed by both the
Node eval scripts and a Worker bundle commonly appears in both `package.json` fields in
this kind of monorepo; there is no conflict.)

- [ ] **Step 2: Add `nodejs_compat` to `packages/llm/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "neutail-llm",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],

  // No d1_databases, no service binding to services. The gateway sees prompts and
  // model providers, never customer data.
  // Workers AI has no local simulator - the binding is proxied to Cloudflare and needs
  // an authenticated session. Uncomment to use LLM_PROVIDER=workers-ai; leave it off for
  // offline local dev. mock / anthropic / openai all work either way.
  // "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "name": "USAGE", "class_name": "UsageCounter" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["UsageCounter"] }
  ],
  "vars": {
    "LLM_PROVIDER": "mock",
    "AI_GATEWAY_NAME": "neutail"
    // AI_GATEWAY_ACCOUNT_ID: set as a var or secret
    // ANTHROPIC_API_KEY / OPENAI_API_KEY: wrangler secret put
    // BRAINTRUST_API_KEY: wrangler secret put (deployed); .dev.vars (local dev)
  },
  "workers_dev": false
}
```

Add `BRAINTRUST_PROJECT` as a var (pick a project name consistent with whatever
`.braintrust.json` already names, or `"neutail"` if unset - check
`.braintrust.json`'s contents first, don't guess):

```jsonc
"vars": {
  "LLM_PROVIDER": "mock",
  "AI_GATEWAY_NAME": "neutail",
  "BRAINTRUST_PROJECT": "neutail"
  // ...
}
```

- [ ] **Step 3: Wrap the `/complete` handler's provider-call block in `traced()`**

Add the import and wrap the existing try/catch in `packages/llm/src/index.ts`:

```ts
import { initLogger } from 'braintrust';
```

```ts
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
```

Add `BRAINTRUST_API_KEY?: string; BRAINTRUST_PROJECT?: string;` to the `Env` type at
the top of the file.

Note: the exact shape of `logger.traced`'s callback and `span.log()` is taken from the
real installed `braintrust@3.34.0` type declarations (`Span.traced<R>(callback: (span:
Span) => R, args?: StartSpanArgs & SetCurrentArg): R`, where `StartSpanArgs.event` and
`span.log()` both accept `{input, output, metadata, expected, scores, tags, error,
...}` - `ExperimentLogPartialArgs`). If the installed version's exact types differ
(e.g. `span.log`'s field names), read `node_modules/braintrust/dist/index.d.ts`
directly and adjust - don't guess.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

If the `braintrust` package's types conflict with `@cloudflare/workers-types` (global
name collisions, similar to what happened when `@cloudflare/ai-chat` was added in a
prior plan), read the actual conflicting symbol names from the error and resolve by
checking `braintrust`'s own `.d.ts` rather than guessing a fix.

- [ ] **Step 5: Verify tracing works with NO OpenAI key needed - the `mock` provider path**

```bash
npm run db:local
npm run dev
```

In a second terminal:

```bash
npm run smoke
```

Expected: passes with no regressions (identical to the Task 1 baseline) - this proves
`logger.traced()` wrapping the provider-call block didn't change `/complete`'s
observable behavior for the `mock` provider (the path every existing consumer uses).

- [ ] **Step 6: Confirm traces actually reach Braintrust**

Since `BRAINTRUST_API_KEY` is already configured in `.env.braintrust`, `wrangler dev`
needs it as a local-dev var too - copy it into `.dev.vars` (gitignored, check
`packages/llm/.dev.vars` or a repo-root `.dev.vars` depending on where `wrangler dev`
looks for `packages/llm`'s config; read `packages/llm/wrangler.jsonc`'s existing
comments for the established convention, since `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
already document the same local-dev pattern).

After a few `npm run smoke` beats have run (each one calls `/complete` multiple
times), use the Braintrust API (`GET https://api.braintrust.dev/v1/project` /
`/v1/project_logs/{project_id}/fetch`, authenticated with `BRAINTRUST_API_KEY` from
`.env.braintrust`) to confirm log entries actually landed - don't just confirm nothing
threw. If the exact REST endpoint shape differs from this description, check
`https://www.braintrust.dev/docs` or the SDK's own REST client rather than guessing;
this is meant to be a real "did the data arrive" check, not a formality.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/llm/src/index.ts packages/llm/wrangler.jsonc
git commit -m "Add online tracing: every /complete call logged to Braintrust"
```

---

### Task 5: Documentation and final regression pass

**Files:**
- Modify: `CLAUDE.md`
- Modify: root `README.md` (if it documents `packages/llm`'s command surface)
- No new source files.

- [ ] **Step 1: Update `CLAUDE.md`**

Add a short section (or extend the existing `packages/llm` description) documenting:
`npm run eval` runs the offline eval suite (needs `OPENAI_API_KEY` in
`.env.braintrust`), every `/complete` call is traced to Braintrust when
`BRAINTRUST_API_KEY` is configured (degrades to no tracing, not an error, when it
isn't - same pattern as every other "gracefully degrade when unconfigured" feature in
this codebase), and where the prompt registry's `packages/llm/src/providers.ts` now
lives relative to the generated `prompts.ts`. Read the current file before editing -
don't guess section boundaries or exact current wording.

- [ ] **Step 2: Update root `README.md` if it lists `packages/llm` commands**

Only if it currently documents a command list that `npm run eval` would belong next
to. Read the current file first; skip this step if there's nothing to update.

- [ ] **Step 3: Full regression pass**

```bash
npm run typecheck
npm run db:local
npm run dev
npm run smoke
npm run eval
```

Expected: everything green. `npm run smoke` output structurally identical to the
pre-this-plan baseline (no behavior change to any existing route). `npm run eval`
produces real scored results for all five prompts.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document Braintrust evals and tracing"
```
