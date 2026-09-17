# SKU tagging admin app — design

## Why

`scripts/gen-seed.ts` assigns `category` algorithmically from the scraped taxonomy and
`style_tags` as two words picked at random from a fixed 8-word list (`STYLES` in
`gen-seed.ts`). Both feed `describeProduct()`, whose output is what semantic search
actually embeds. Random tags produce a random-looking embedding corpus — "I want to go
to party" surfacing thermal leggings and plain sweatshirts isn't a ranking bug
(`discovery.ts`'s scoring, diversity floor, and fairness guardrail are all working as
designed), it's that the underlying tag data was never curated. There is currently no
way to fix a SKU's tags without hand-editing `seed.sql` and losing the change on the
next `npm run db:local`. This spec adds a small internal admin app so a person can
correct a SKU's category/tags/attributes and have both lexical and semantic search
reflect it immediately - and, while in there, add a manual relevance nudge per SKU,
independent of tags.

Scope for v1 (confirmed): category, free-form tags, structured attributes
(brand/material/colour/cut/price_tier/department), and a per-SKU relevance boost are all
editable; one SKU at a time (no bulk edit - catalogue is ~1,200 products, a filtered
table is enough); no auth (internal prototype tool, matches the rest of the demo).

## A. Placement: tool contract + `app`, not raw routes on `services`

`packages/services` is `workers_dev: false` - reachable only via service binding, by
design (`CLAUDE.md`: "the absence of `d1_databases` in three of the four configs is the
actual enforcement mechanism"). Routes added directly there would answer under local
`wrangler dev` but go dark on a real deploy, since nothing would route a browser to it.
So this follows the same shape the five agents already use:

- Three new tool contracts in `packages/tools/registry/tools/`, gated by
  `allowed_agents`, exactly like every other contract.
- `packages/services` implements the actual D1 reads/writes and re-embedding - it
  already owns the catalogue and the embedding model.
- `packages/app` gets the admin page and a few thin routes that construct a `Kernel`
  with agent identity `"admin"` and call `k.invoke(...)`, the same pattern
  `/outcome` already uses (`packages/app/src/index.ts:34-51`). No new Worker, no new
  binding, no SessionDO involvement - this isn't a conversational flow.

`"admin"` needs no special-casing anywhere: the gateway's `/invoke` authorizes by
`contract.allowed_agents.includes(agent)` against whatever string is passed
(`packages/tools/src/index.ts:107`) - it isn't hardcoded to the five agent names.

## B. New tool contracts (`packages/tools/registry/tools/`)

**`catalogue.admin.list`** - search/filter/paginate for the tagging worklist:
```json
{
  "name": "catalogue.admin.list", "version": "1.0.0",
  "purpose": "List and search the full catalogue for admin tagging, unfiltered by stock or department.",
  "allowed_agents": ["admin"],
  "input_schema": {
    "q": { "type": "string", "required": false, "description": "matches sku, title, or brand" },
    "category": { "type": "string", "required": false },
    "department": { "type": "string", "required": false },
    "page": { "type": "integer", "required": false, "default": 1 },
    "pageSize": { "type": "integer", "required": false, "default": 50 }
  },
  "output_schema": { "page": "integer", "pageSize": "integer", "total": "integer", "results": "array" },
  "transport": { "service": "services", "method": "GET", "path": "/admin/products" }
}
```

**`catalogue.admin.get`** - one full record by SKU:
```json
{
  "name": "catalogue.admin.get", "version": "1.0.0",
  "purpose": "Fetch one product's full editable record by SKU.",
  "allowed_agents": ["admin"],
  "input_schema": { "sku": { "type": "string", "required": true } },
  "output_schema": { "sku": "string" },
  "transport": { "service": "services", "method": "GET", "path": "/admin/products/{sku}" }
}
```

**`catalogue.admin.update`** - the write path, same `POST` + path-param shape
`context.write` already uses:
```json
{
  "name": "catalogue.admin.update", "version": "1.0.0",
  "purpose": "Update a product's tagging/attributes, regenerate its description, and re-embed it into the semantic search index.",
  "allowed_agents": ["admin"],
  "input_schema": {
    "sku": { "type": "string", "required": true },
    "category": { "type": "string", "required": false },
    "department": { "type": "string", "required": false },
    "brand": { "type": "string", "required": false },
    "colour": { "type": "string", "required": false },
    "material": { "type": "string", "required": false },
    "cut": { "type": "string", "required": false },
    "style_tags": { "type": "string", "required": false, "description": "comma-separated free text" },
    "price_tier": { "type": "string", "required": false },
    "relevance_boost": { "type": "number", "required": false }
  },
  "output_schema": { "sku": "string", "updated": "boolean", "reindexed": "boolean" },
  "transport": { "service": "services", "method": "POST", "path": "/admin/products/{sku}" }
}
```
Regenerated into `packages/tools/src/bundled.ts` via `npm run gen`, same as any other
contract change.

## C. Schema (`packages/services/schema.sql`)

Add one column: `relevance_boost REAL NOT NULL DEFAULT 0` on `products`. No change to
`scripts/gen-seed.ts`'s INSERT column list needed - every seeded row gets the column
default (0, a no-op) for free; only hand-tagged SKUs will ever carry a non-zero value.

## D. Services routes (`packages/services/src/index.ts`)

Three additions next to the existing `Catalogue` section:

- `GET /admin/products` - builds a `WHERE` clause from optional `q` (LIKE across
  `sku`/`title`/`brand`), `category`, `department`; runs a `COUNT(*)` and a paginated
  `SELECT * ... ORDER BY sku LIMIT ? OFFSET ?` in one `DB.batch`; returns
  `{ page, pageSize, total, results }`. Deliberately does not filter by stock or
  department the way `catalogue.search` does - an admin needs to find and fix
  out-of-stock or wrong-department SKUs too.
- `GET /admin/products/:sku` - `SELECT * FROM products WHERE sku = ?`, 404 if missing.
- `POST /admin/products/:sku` - loads the existing row, merges in only the whitelisted
  editable fields from the body (never builds SQL from arbitrary request keys), then:
  1. Regenerates `description` via a small `describeProduct()` helper ported into this
     file (same template as `scripts/gen-seed.ts`'s - can't share the module directly,
     `scripts/` runs under Node for codegen and `services` runs on the Workers runtime,
     so this is an intentional small duplication, not a shared lib).
  2. `UPDATE products SET ... , description = ? WHERE sku = ?`.
  3. Re-embeds just this one product (`AI.run(EMBED_MODEL, { text: [description] })`)
     and `VECTORS.upsert([{ id: sku, values, metadata: { category } }])` - same call
     shape `/catalogue/reindex` already uses, for a single row instead of a batch.
  4. Wrapped in try/catch: if the embed/upsert step throws, the D1 write has already
     succeeded - return `{ sku, updated: true, reindexed: false, degraded_reason }`
     rather than failing the whole save. Same degrade-path convention used everywhere
     else in this codebase (`/catalogue/search`'s semantic fallback, `/complete`'s
     mock fallback).

## E. Ranking integration (`packages/services/src/index.ts`, `packages/app/src/agents/discovery.ts`)

`relevance_boost` rides along for free in both search paths - `lexicalSearch` and
`semanticSearch` both `SELECT p.*`, so the new column is already present on every
candidate object without touching either function's signature. Two small additions:

- `lexicalSearch`'s per-term scoring loop (`index.ts:120-128`) adds
  `score += Number(r.relevance_boost ?? 0)` once per row, alongside the existing
  keyword/category/style_tags bumps (comparable ±2/±3 scale).
- `discovery.ts`'s score formula (line 50) adds one term:
  `score = relevance*1.0 + tierW*1.4 + rating*0.35 + stockBoost + fitBoost - returnPenalty*1.2 + (p.relevance_boost ?? 0)`.

A boost of 0 (the default for every SKU until an admin sets one) changes nothing -
existing ranking behaviour for every currently-seeded product is untouched until someone
deliberately sets a non-zero value.

## F. Admin UI (`packages/app/public/admin.html`, `packages/app/src/index.ts`)

Three thin proxy routes in `app`, mirroring `/outcome`'s pattern exactly:
```ts
app.get('/admin/products', async c => {
  const k = new Kernel('admin', new Trace(), c.env);
  const data = await k.invoke('catalogue.admin.list', { q, category, department, page, pageSize });
  return c.json(data);
});
app.get('/admin/products/:sku', ...);   // -> catalogue.admin.get
app.post('/admin/products/:sku', ...);  // -> catalogue.admin.update, body forwarded as args
```
`admin.html` is a static page (served by the existing `ASSETS` binding, same as
`shop.html`/`index.html`): a search box (matches sku/title/brand) plus category/
department filters, a paginated table (~50 rows/page), and a click-to-edit form with
the fields from §B. On save, show the response's `reindexed`/`degraded_reason` inline
("saved - semantic index update failed, will be stale until reindexed" when
`degraded_reason` is present) so a stale index is visible, not silent. Vanilla HTML/JS,
no framework, consistent with the existing `shop.html`.

## G. Docs

- `DEMO.md` gets a short admin section: open `admin.html`, search a SKU, retag it,
  re-run the same semantic search query from the main demo to show the result change.
- Root `README.md`'s command list gets one line noting the admin page's path once
  `npm run dev` is running.

## H. Explicitly unchanged

The five specialist agents and their tool contracts; the tool gateway's validator and
audit logging (the new contracts flow through both unmodified - every admin call is
already audited to Analytics Engine as `invoke`/`invoke.error`, same as agent calls);
`fairnessBand`/the diversity floor beyond the one additive ranking term; `scripts/
gen-seed.ts`'s INSERT statements; the schema-recreate-on-`db:local` workflow (no ALTER
TABLE migration path, matching how `description` was added in the semantic-search spec);
`scripts/smoke.ts` (every seeded SKU's `relevance_boost` is 0, so the deterministic demo
path is bit-for-bit unaffected until someone uses the new admin page).

## I. Verification

`npm run gen` (rebuilds `bundled.ts` from the three new contract JSON files), then
`npm run db:local` (picks up the new column), then `npm run typecheck`. With
`npm run dev` running: curl `/admin/products?q=hoodie` to confirm paginated results;
curl `/admin/products/:sku` for one full record; `POST /admin/products/:sku` with a
tag change and confirm `reindexed: true`; re-curl `/catalogue/search?q=...&
searchMode=semantic` for that same query and confirm the retagged SKU's rank moved.
Open `admin.html`, search, edit, save, confirm the table reflects the edit without a
full reload. Finally `npm run smoke` to confirm the existing end-to-end demo is
unaffected.
