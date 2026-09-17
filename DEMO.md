# Demo script — 8 minutes

Before you start: `npm run db:local && npm run dev`, open http://localhost:8100,
send one throwaway message to cold-start the Workers, and have a second terminal ready
for the curl beats.

Rehearse with `LLM_PROVIDER=mock` in `packages/llm/wrangler.jsonc`. It is deterministic, so the run you practise is the
run the panel sees.

---

**0 · Baseline (30s)** — terminal
```bash
curl -s localhost:8101/analytics/return-rate | jq
```
"34.0% across 1,120 order items, 58% of it size and fit coded. That is the number we
are going to move, and it is in the data, not on a slide."

**1 · Affluent customer (60s)** — console, persona Priya, ask *show me an occasion dress*.
Point at the right-hand pane: intent classified, Profiling Agent dispatched because the
session had no segment, seven tool calls, two model calls, both policies passed.

**2 · The same query, a different customer (60s)** — switch to Aditi, same words.
Different product set, different reasoning, same candidate pool. Say the fairness line
out loud: the ranking differs, the access does not.

**3 · Fit with history (45s)** — back to Priya, *what size should I get?*
Size M at 99% confidence, with the real height/weight match and the seven kept
purchases shown — her body metrics and this brand's grading are both real data now,
not invented cm offsets.

**4 · Fit without history (45s)** — Aditi, same question. The consent gate blocks, the
agent abstains. "A low-confidence guess causes the return we exist to remove, so we make
no claim."

**5 · Upsell at demonstrated value (60s)** — Meera, *tell me about the styling advisory
plan*. Third session, frequency cap passes, offer made. Reply *accept*.

**6 · The handoff (45s)** — Meera, *how many points did I earn?*
2× multiplier. The Loyalty Agent read an entitlement the Upsell Agent wrote. One shared
context, two agents, two flows.

**7 · The guardrail blocking (45s)** — terminal
```bash
curl -s localhost:8100/session/x/message -H 'content-type: application/json' \
  -d '{"customerId":"C001","text":"show me an occasion dress","unsafeRanking":true}' \
  | jq '.trace[] | select(.stage=="policy")'
```
Single-tier top 10, guardrail blocks, neutral ranking served, audit event raised.

**8 · Permissions and hot-loaded tools (60s)** — terminal
```bash
curl -s localhost:8102/invoke -H 'content-type: application/json' \
  -d '{"agent":"discovery","tool":"loyalty.accrue","args":{"customer_id":"C001","base_points":999}}'
curl -X POST localhost:8102/registry/install -H 'content-type: application/json' -d '{
  "name":"catalogue.trending.get","version":"1.0.0",
  "purpose":"Trending SKUs in a category, derived from order volume.",
  "allowed_agents":["discovery"],
  "input_schema":{"category":{"type":"string","required":true},"days":{"type":"integer","required":false,"default":30}},
  "output_schema":{"category":"string","trending":"array"},
  "transport":{"service":"services","method":"GET","path":"/catalogue/trending/{category}"}}'
```
Denied by contract; registry goes from 19 tools to 20 with no agent code touched. (The
contract being installed lives at `packages/tools/registry/available/catalogue.trending.get.json`
if you want to show the file rather than type the JSON inline. Reset with
`curl -X POST localhost:8102/registry/reset` afterwards.)

**9 · Model interoperability (30s)** — `curl localhost:8103/routing`, then change
`LLM_PROVIDER` in `packages/llm/wrangler.jsonc` and repeat beat 1. Same orchestrator,
same trace shape, different model, every call logged in AI Gateway. If you have the
dashboard open, show the AI Gateway request log — it is the single most convincing
thirty seconds available to you on Objective 2.

**10 · Outcome (45s)**
```bash
curl -s localhost:8100/outcome | jq
```
34.0% → 20.4%, decomposed. Then say the uncomfortable thing first: personalisation does
not reach the brief's 10–15% band on its own, and here is what else it takes.

---

**Bonus · Semantic search (optional, not timed)** — terminal

Requires a live Cloudflare account (Workers AI + Vectorize have no local simulator),
the metadata index created once via `wrangler vectorize create-metadata-index neutail-catalogue
--property-name=category --type=string` (otherwise any category-filtered query silently
returns zero matches), and `npm run catalogue:reindex` already run once. Also run
`curl -X POST localhost:8102/registry/reset` first to pick up the `searchMode` field on
the `catalogue.search` tool contract (only needed if you haven't already run `npm run
smoke`, which resets the registry as a side effect). Same fuzzy query, both ways:
```bash
curl -s localhost:8101/catalogue/search --get --data-urlencode 'q=warm layer for chilly evenings' \
  | jq '{mode, candidates, top: .results[0:5] | map({title, category, relevance})}'
curl -s localhost:8101/catalogue/search --get --data-urlencode 'q=warm layer for chilly evenings' \
  --data-urlencode 'searchMode=semantic' \
  | jq '{mode, candidates, top: .results[0:3] | map({title, category, relevance, description})}'
```
Say this out loud, not "lexical finds nothing" (verified during Task 3 — it doesn't):
lexical returns candidates, but every one is tied at the *same* low `relevance` score
(a coincidental substring hit — "layer" inside "layering", one of the style tags) and
they're scattered across unrelated categories with no actual ranking signal. Semantic
returns a small, coherently-ranked set of real jackets/coats/knitwear, each with a
distinct, meaningfully higher `relevance` score and a `description` that explains why.
The point isn't "zero vs. some" — it's "noise vs. signal": lexical's hit is luck, not
understanding. Same beat through the app: add `"semanticSearch": true` to a
`/session/:id/message` body and diff the trace's `S2.7` step against the same call
without it.

---

### Questions to have an answer ready for
- *Can an agent reach the database?* Open the four `wrangler.jsonc` files — three have no
  D1 binding at all. The platform will not hand the agents Worker a database handle.
- *What does it remember?* `GET /session/:id` reads the Durable Object directly, then the
  README memory section.
- *What did you not build?* `DEVIATIONS.md`, all eight items.
- *Is the 20.4% yours or Neu.Tail's?* The 34% is theirs. Every capture rate is ours, and
  each one is a proposal against a baseline to confirm in the pilot.
