# Neu.Tail — Digital Personalisation Assistant (Cloudflare Workers)

Mission #4 working prototype for the Mission #3 blueprint (Team 4, Cartwheel Galaxy).
Five specialist agents, one orchestrator, one shared context layer, on Workers + D1 +
Durable Objects + KV + AI Gateway.

## Run it locally

```bash
npm install
npm run gen        # regenerates seed.sql, the tool bundle and the prompt bundle
npm run db:local   # applies schema.sql then seed.sql to local D1
npm run dev        # four Workers with service bindings wired between them
```

Then open http://localhost:8100 and **send one throwaway message before you demo**.
The first request after `wrangler dev` boots can time out while the Workers cold-start;
everything after it is fast. `npm run smoke` replays the whole demo on the command line.

Re-run `npm run db:local` before each rehearsal — the demo mutates subscription and
loyalty state, so a fresh load puts every persona back to its starting position.

A second, simpler front end lives at http://localhost:8100/shop.html — a storefront
mockup of the same live backend (search, product detail with size-check, account with
subscription and loyalty points), for anyone who wants to feel the personalisation as a
shopper would rather than read the trace panel.

A tagging admin lives at http://localhost:8100/admin.html — search the catalogue,
retag a SKU's category/tags/attributes or set a manual relevance boost, and the change
re-embeds into the semantic search index immediately (falls back to a "stale until
reindexed" notice if the embed/upsert step fails). If `/admin/products` returns
`unknown_tool`, the local KV tool registry predates this feature — run
`curl -X POST localhost:8102/registry/reset` (or `npm run smoke`, which does this as a
side effect) to pick up the new contracts.

## Deploying

```bash
wrangler d1 create NEUTAIL          # paste the id into packages/services/wrangler.jsonc
wrangler kv namespace create REGISTRY   # paste the id into packages/tools/wrangler.jsonc
wrangler vectorize create neutail-catalogue --dimensions=768 --metric=cosine  # for opt-in semantic search
wrangler vectorize create-metadata-index neutail-catalogue --property-name=category --type=string
npm run db:remote
npm run deploy                      # services, tools, llm, app in dependency order
```

The admin page (`/admin.html`) and its `/admin/products*` routes have no
authentication — fine for local development, but do not deploy this branch to a
publicly reachable environment without adding access control in front of them first.
Beyond letting anyone retag the catalogue, every save also triggers a Workers AI embed
and a Vectorize upsert, so an exposed admin page is a cost exposure, not just a
data-integrity one.

Semantic search's index is populated by `npm run catalogue:reindex`, which POSTs to a
locally running `services` Worker. For local data that's `npm run dev:services`; against
the deployed database, run `wrangler dev --remote --config packages/services/wrangler.jsonc --port 8101`
instead (`--port 8101` matches the port `reindex-catalogue.ts` defaults to; so the reindex
reads/writes the deployed D1 and Vectorize resources, not local ones), then
`npm run catalogue:reindex`.

**Re-run `npm run catalogue:reindex` after every `npm run gen` / reseed.** `gen-seed.ts`
reassigns SKU numbers from freshly-sampled catalogue rows each run, so the Vectorize
index (keyed by SKU, from whatever the *previous* seed generation looked like) silently
drifts out of sync with D1's current product data - the same SKU now points at a
different product. Symptom: `searchMode=semantic` returns `mode: "semantic"` with no
error, but results include categories that don't match the `category` filter you passed.
Also note Vectorize's metadata index (`category`) takes roughly a minute to fully
propagate after a reindex - a query run immediately after can return partially-stale
results without any error or degrade signal, so don't judge a reindex by the first query
after it.

Only `neutail-app` is publicly routable. The other three have `workers_dev: false` and
are reachable solely through service bindings.

## Four Workers, and why the split matters here

| Worker | Bindings | Notes |
|---|---|---|
| `neutail-services` | **D1** | The only Worker with a database binding anywhere in the deployment |
| `neutail-tools` | KV, service→services, Analytics Engine | Registry, contracts, permissions, audit |
| `neutail-llm` | Durable Object, optional Workers AI | Prompt registry, routing policy, token accounting |
| `neutail-app` | Durable Object, service→tools, service→llm, assets | Orchestrator, five agents, demo console |

Read the four `wrangler.jsonc` files side by side. **Three of them have no
`d1_databases` entry.** The Worker that runs the agents cannot reach the database
because the platform will not give it a handle — not because we were careful. That is
a stronger answer to "agents must never read the database directly" than any code
review, and it takes ten seconds to show a panel.

## What the platform does instead of our code

- **Durable Objects for sessions.** One DO instance per session id, with its own
  durable storage. Turns for a session are serialised by the runtime, so two concurrent
  messages from the same customer cannot interleave, and context survives deploys and
  eviction. In the Node build this was a `Map` in one process. Orchestration runs
  *inside* the DO, so session context and the agents reading it live together.
- **A second DO for token accounting**, giving one strongly consistent counter for the
  whole deployment rather than per-instance numbers.
- **AI Gateway** in front of every provider: unified request/response logging, caching,
  rate limiting and per-request analytics. Three of the four things the brief asks the
  gateway to own become platform features. What stays in our code is the part that is
  actually ours — the versioned prompt registry and the routing policy that maps a
  model *class* to a model, so an agent never names one.
- **KV for the tool registry**, so installing a contract at runtime is a real write to a
  real store rather than copying a file on a laptop.
- **Analytics Engine** for the tool audit trail: append-only and queryable with no
  storage to operate.
- **Service bindings** for Worker-to-Worker calls: no public internet hop, no
  credentials between services, and the internal Workers stay unroutable.

## Objective 1 — data foundation

`npm run gen` prints its own acceptance numbers:

```
customers            41
products             1200
order items          1120
returns              381
RETURN RATE          34.0%   (baseline target 34%)
  size_fit         58.0%
  changed_mind     22.0%
  quality_defect   12.1%
  other             7.9%
```

Returns are assigned by exact quota rather than sampled, because the demo quotes these
numbers back. The split matches the decomposition on slide 19 of the M3 deck.

Three named personas carry the demo:

| | Customer | Why they exist |
|---|---|---|
| `C001` | Priya Raman | Affluent, Gold, 24 orders, seven kept dress purchases, fit consent on file |
| `C002` | Aditi Sharma | Value-seeking, two orders, no fit history, no fit consent |
| `C003` | Meera Iyer | Free tier at her third Styling Advisory session — the upsell trigger |

## Objective 2 — access layer and gateway

```bash
curl 'localhost:8102/tools?agent=discovery'    # what this agent may call
curl -s localhost:8102/invoke -H 'content-type: application/json' \
  -d '{"agent":"discovery","tool":"loyalty.accrue","args":{"customer_id":"C001","base_points":999}}'
# {"ok":false,"error":"permission_denied","detail":"contract loyalty.accrue@1.0.0 permits [loyalty]"}
```

Installing a tool at runtime, no redeploy and no agent change:

```bash
curl -X POST localhost:8102/registry/install -H 'content-type: application/json' -d '{
  "name":"catalogue.trending.get","version":"1.0.0",
  "purpose":"Trending SKUs in a category, derived from order volume.",
  "allowed_agents":["discovery"],
  "input_schema":{"category":{"type":"string","required":true},"days":{"type":"integer","required":false,"default":30}},
  "output_schema":{"category":"string","trending":"array"},
  "transport":{"service":"services","method":"GET","path":"/catalogue/trending/{category}"}}'
# registry 22 -> 23, and the tool is callable on the next invoke
curl -X POST localhost:8102/registry/reset   # back to the bundled 22
```

LLM gateway surfaces: `GET /routing`, `GET /prompts`, `GET /usage`, `GET /calls`.
Provider is one var in `packages/llm/wrangler.jsonc`: `mock`, `workers-ai`, `anthropic`
or `openai`. `mock` is deterministic and needs no network — rehearse on it, then switch
on stage. If a live provider fails mid-call the gateway degrades to mock and flags
`degraded: true` rather than erroring, matching the degrade paths on every M3 sequence.

Workers AI has no local simulator, so its binding is commented out in the config for
offline dev. Uncomment it to use `LLM_PROVIDER=workers-ai`.

## Objective 3 — the five functionalities

Every response carries a trace, and every step is tagged with the M3 sequence step it
implements (`S2.6`, `S3.11`), so the mapping back to the blueprint lives in the product
rather than in a slide.

1. **Profiling & segmentation** — affluence scored from average unit price, premium
   share and annual spend; loyalty status from order count and tenure.
2. **Discovery & recommendation** — same query, different product set, with the
   reasoning and per-SKU score components surfaced.
3. **Size & fit** — consent gate, real height/weight grading band per category, confidence score, abstain below 70%.
4. **Service upsell** — fires at the third free session; the frequency-cap policy can
   veto the agent.
5. **Loyalty accrual** — reads the entitlement the Upsell Agent wrote and applies 2×.

### Memory

**Within a session** — Durable Object storage: turn history with detected intents,
resolved segment, last category, last SKU shown, pending offer. Survives deploys.

**Across sessions** — D1 via the context service: segment and propensity scores, last
discovery query, confirmed fit recommendations, entitlement, engagement score.

A different customer on the same session id resets the DO. Context never leaks between
people, even if a session id is reused.

### Business outcome

`GET /outcome` computes the projection from the live corpus rather than asserting it:

```
baseline 34.0%
  size_fit        19.7 pts × 65% reachable × 75% captured  →  −9.6
  changed_mind     7.5 pts × 100%          × 40%           →  −3.0
  quality_defect   4.1 pts × 100%          × 25%           →  −1.0
  other            2.7 pts   no claim made                 →   0.0
projected 20.4%
```

Personalisation alone does not reach the brief's 10–15% band. Closing the rest needs
assortment and supplier quality remediation plus a returns-policy change — a commercial
decision, not an architectural one. Saying so is the defensible position.

## Demo script

See `DEMO.md`. Deviations from the M3 design are in `DEVIATIONS.md`.
