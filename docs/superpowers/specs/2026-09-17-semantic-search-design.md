# Opt-in semantic search for catalogue.search — design

## Why

`DEVIATIONS.md` §1 already documents that the M3 design's S12-step-7 vector-DB retrieval
was replaced by scored lexical matching (`title`/`category`/`style_tags`/`material`/
`colour` substring scoring in `packages/services/src/index.ts`), specifically because
"the retrieval call sits behind the `catalogue.search` contract, so swapping in a vector
store changes one service implementation and no agent code." This spec makes good on
that promise: a real embedding-backed retrieval path, selectable per request, so a demo
can run the same fuzzy query (e.g. "warm layer for chilly evenings") through both modes
and show semantic search finding relevant products lexical search misses entirely — with
no keyword overlap required.

Goal: add semantic retrieval as an **opt-in mode** alongside the existing lexical path
(default stays lexical, unchanged), using Cloudflare's own stack (Workers AI +
Vectorize) rather than an external service, since this is a Workers-native project and
the four-Worker binding-isolation model (`CLAUDE.md`) should stay intact. Requires a
real Cloudflare account with Workers AI + Vectorize enabled — confirmed acceptable; this
feature is not required to work under a fully offline `npm run dev`.

## A. New bindings (`packages/services/wrangler.jsonc`)

`services` is already the only Worker with a D1 binding and already owns
`catalogue.search`'s implementation, so both new bindings go there and nowhere else —
`tools`, `llm`, and `app` are untouched, keeping the "one service implementation"
promise literal:

```jsonc
"ai": { "binding": "AI" },
"vectorize": [{ "binding": "VECTORS", "index_name": "neutail-catalogue" }]
```

Embedding model: `@cf/baai/bge-base-en-v1.5` (768-dim). Index created out-of-band via
`wrangler vectorize create neutail-catalogue --dimensions=768 --metric=cosine`
(documented in root `README.md`'s "Deploying" command block, next to the existing
`wrangler d1 create` / `wrangler kv namespace create` lines — same one-time setup
category).

Neither Workers AI nor Vectorize has a local simulator — both binding calls always
proxy to the real Cloudflare API even under plain `npm run dev`/`wrangler dev`, the same
reason `packages/llm/wrangler.jsonc`'s commented-out `AI` binding gives today. No
`--remote` flag needed; a logged-in `wrangler`/API token is sufficient.

## B. Schema & embedding content (`packages/services/schema.sql`, `scripts/gen-seed.ts`)

- Add `products.description TEXT` to `schema.sql`. No migration path needed — dropped
  and recreated fresh by `npm run db:local`/`db:remote` on every run, per existing
  project workflow.
- New `describeProduct(row)` helper in `scripts/gen-seed.ts`, hand-written (not
  LLM-generated, so `npm run gen` stays fully offline and reproducible): a small set of
  natural-language sentence templates per category, filled in from the product's
  existing fields (`colour`, `material`, `title`, `brand`, `cut`, `style_tags`), e.g.
  *"A relaxed-cut navy wool coat from Acme's outerwear range, tagged formal, winter."*
  Richer than flat field concatenation so the embedding model has real phrasing to work
  with. Every emitted product row includes the generated `description`.

## C. Indexing (`packages/services/src/index.ts`, root `package.json`)

New `POST /catalogue/reindex`: reads `sku` + `description` for every product from D1,
batches through `AI.run('@cf/baai/bge-base-en-v1.5', { text: [...] })` in chunks of
~20 (Workers AI batch-size headroom) and `VECTORS.upsert(...)` in chunks of ~200, each
vector keyed by `id: sku` with `metadata: { category }` for optional query-time
filtering. Returns `{ indexed: n }`.

New `npm run catalogue:reindex` script (`scripts/reindex-catalogue.ts`) that POSTs to
the local dev services Worker on `:8101`. Run once, after `npm run db:local` (or
`db:remote`) and with `npm run dev:services` (or full `npm run dev`) already running —
documented as a setup step alongside those commands, not part of the regular dev loop.

## D. Query-time search (`packages/services/src/index.ts`)

`GET /catalogue/search` gains an optional `searchMode` query param (`"lexical"`
default — existing behavior, byte-for-byte unchanged; `"semantic"` opt-in):

1. Embed the query text via the same `AI.run` call used for indexing.
2. `VECTORS.query(embedding, { topK, filter: category ? { category } : undefined })`
   — `topK ≈ min(limit * 3, 100)`, headroom because live stock isn't part of the vector
   index (stock changes with orders; embedding it would go stale) and has to be
   filtered after hydrating from D1 — the same over-fetch-then-filter shape the lexical
   path and `discovery.rank`'s own 60-candidate fetch already use.
3. Hydrate the matched SKUs from D1 (`SELECT p.*, stock ... WHERE p.sku IN (...)`,
   reusing the existing stock subquery), filter `stock > 0`, map each match's cosine
   score to `relevance = round(score * 10 * 100) / 100` — same numeric shape/rough range
   as lexical's integer-ish 0–10ish scores, so `discovery.ts`'s scoring formula
   (`relevance * 1.0 + tierW * 1.4 + ...`) needs zero changes — and sort by `relevance`
   desc.
4. Wrapped in try/catch: if the AI or Vectorize call throws (index not created yet,
   account not provisioned), fall back to the existing lexical scoring path and return
   `degraded: true` — same pattern `packages/llm/src/index.ts`'s `/complete` already
   uses when a live provider call fails and it falls back to `mockComplete`.

Response shape (`query`, `candidates`, `results`) is unchanged; add a top-level `mode`
field (`"lexical" | "semantic"`) so the trace and demo console can show which path
actually served a given call, and — since `description` now exists — `results[].
description` is included for the demo to show *why* a semantic match makes sense.

## E. Contract & agent threading

- `packages/tools/registry/tools/catalogue.search.json` gains `searchMode:
  { "type": "string", "required": false, "default": "lexical" }` in `input_schema`
  (`ToolContract`'s validator has no enum support — any non-`"semantic"` value is
  treated as lexical server-side). Regenerated into `packages/tools/src/bundled.ts` via
  `npm run gen`, same as any other contract change.
- `/session/:id/message` request body gains optional `semanticSearch: boolean`, read in
  `packages/app/src/session-do.ts` right next to the existing `unsafeRanking` read.
- `discovery.rank` (`packages/app/src/agents/discovery.ts`) gains a `semanticSearch =
  false` parameter (same position/style as `unsafeRanking`), forwarded into its
  `catalogue.search` invoke as `searchMode: 'semantic'` when true. Same `m3_ref: 'S2.7'`
  tag — same logical step, swapped backend, not a new step.

## F. Docs

- `DEVIATIONS.md` §1 updated: the vector-store path now exists and is real, opt-in via
  `searchMode`/`semanticSearch`, default stays lexical — the "why" (personalisation
  claim rests on ranking, not retrieval) stays accurate and is kept, just the "not
  built" framing is corrected.
- `DEMO.md` gets one new curl example: the same fuzzy, low-keyword-overlap query run
  once with `semanticSearch` omitted and once with `semanticSearch: true`, to show the
  delta live.
- Root `README.md`'s "Deploying" block gets the `wrangler vectorize create` line.

## G. Explicitly unchanged

Lexical search's default behavior and response shape when `searchMode` is omitted; the
`tools`/`llm`/`app` Workers' bindings; `fairnessBand`/the diversity floor/policy.ts
(semantic mode is a retrieval-layer swap upstream of ranking, same as lexical is today);
`scripts/smoke.ts` (stays on the deterministic mock-LLM path; semantic search is
verified manually via curl, consistent with the project's existing "no isolated unit
tests, curl the endpoint" convention, since real embedding output isn't deterministic
enough for a scripted assertion); the five-agent architecture and `m3_ref` tagging
scheme generally.

## H. Verification

`npm run gen`, `npm run db:local`, `npm run typecheck` first. Then (with a real
Cloudflare account/API token available): create the Vectorize index, run
`npm run dev:services` (or full `npm run dev`), `npm run catalogue:reindex`, and curl
`/catalogue/search?q=...&searchMode=semantic` directly to confirm `mode: "semantic"`,
sensible `relevance` scores, and `description` fields on results. Then curl
`/session/:id/message` with a fuzzy, low-keyword query, once with `semanticSearch: true`
and once without, and confirm the semantic run surfaces products the lexical run scores
at 0/misses. Confirm the degrade path by curling semantic search *before* running
`catalogue:reindex` (empty/uncreated index) and checking `degraded: true` with a
non-empty lexical fallback result. Run `npm run smoke` to confirm the default (lexical,
mock-LLM) demo path is untouched.
