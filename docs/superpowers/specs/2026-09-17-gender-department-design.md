# Department-aware catalog + a male persona — design

## Why

Reported bug: men's items appear in results for female personas. Root cause traced in
this session: neither `products` nor `customers` carries any gender/department field.
`scripts/lib/fashion-catalog.ts` ingests the raw Ajio scrape — which *does* carry the
signal (footwear rows arrive as `men_Casuals`/`women_Sandals`; category names like
`"Men's Garments"`/`"Women's Ethnic"` exist; `meta_data` often reads "... for Men by
...") — but the category mapping collapses everything into 8 unisex buckets and drops
it. `catalogue.search` therefore mixes both departments for every query, and all
personas (Priya, Aditi, Meera, the 36 generated background customers) are also
ungendered, so nothing downstream can filter on it either.

Goal: tag every product with a department, give every customer a declared shopping
department, filter `catalogue.search` on it, and add one hand-authored male persona so
the fix has a visible proof point in the demo. Treated as a **catalog navigation
concept** (Men/Women/Unisex, same as any storefront's department tabs), not a personal
or protected attribute — kept fully outside `profiling.ts`'s affluence-score inputs,
which deliberately uses no protected attribute.

## A. Schema (`packages/services/schema.sql`)

- `products.department TEXT NOT NULL DEFAULT 'unisex'` — `'women' | 'men' | 'unisex'`.
- `customers.shops_for TEXT NOT NULL DEFAULT 'unisex'` — same enum; `'unisex'` means "no
  department filter", used for the guest persona and any customer with no signal.

No migration path needed: `schema.sql` is dropped/recreated by `npm run db:local` on
every run, per existing project workflow.

## B. Ingestion (`scripts/lib/fashion-catalog.ts`)

New `departmentFor(rawCategory, metaData, title)` helper, checked in priority order
(women checked before men everywhere, so "women" text is never misread via a careless
`includes('men')`):

1. **Explicit signal.** Raw `category` starts with `women`/`men` or contains
   `women_`/`men_` (covers the footwear rows), or `meta_data`/`title` matches
   `/for women\b/` / `/for men\b/`.
2. **Category-keyword guess.** A curated table maps unambiguous raw categories to a
   department without needing an explicit marker: Sarees, Kurtis, Kurta Suit Sets,
   Blouses, Lehenga, Salwars & Churidars, Dupatta, Leggings → `women`; Men's Garments,
   Dhoti, Nehru jacket → `men`.
3. **Everything else** (generic T-shirts, Jeans, Sweaters, Jackets & Coats, unprefixed
   Footwear/Accessories) → `unisex`. This is the honest best-effort guess for these
   categories — real storefronts sell them cross-department too — not a lazy fallback.

`FashionCandidate` gains a `department` field; `gen-seed.ts`'s product row emission
includes it.

## C. Filtering

`catalogue.search` (`packages/services/src/index.ts`) gains an optional `department`
query param. When present, both SQL branches (with/without `category`) add
`AND (p.department = ? OR p.department = 'unisex')` — a hard filter, unisex products
always eligible. This runs at candidate-retrieval time, the same layer as the existing
`category` filter, so `policy.ts`'s `fairnessBand` guardrail (which compares rankings
*within* the already-filtered candidate pool) is unaffected.

`packages/tools/registry/tools/catalogue.search.json` gains `department` as an optional
`input_schema` field (regenerated into `bundled.ts` via `npm run gen`).

## D. Plumbing

- `/customers/:id/profile` (`packages/services/src/index.ts`) returns
  `identity.shops_for` from the new `customers.shops_for` column.
- `profiling.ts`'s `Segment` type gains `shops_for: 'women' | 'men' | 'unisex'`,
  populated from `profile.identity.shops_for`. No change to the affluence-score formula.
- `discovery.rank` (`packages/app/src/agents/discovery.ts`) passes
  `department: segment.shops_for` on its `catalogue.search` call. No new parameter
  threaded through `session-do.ts` or `Kernel` — reuses the segment already cached in
  Durable Object session state.

## E. Personas (`scripts/gen-seed.ts`)

- New hand-authored `C004 'Arjun Mehta'`, `shops_for: 'men'`, note framed as a live proof
  point for this fix (menswear-only results). Own segment/journey distinct from the
  existing three (not a duplicate of Priya's affluent-loyal story).
- The 36-name background pool (`NAMES`) becomes an array of `{name, shopsFor}` pairs
  (hand-tagged, not inferred) instead of bare strings; those customers renumber to
  `C005+`.
- Order/return generation's per-customer product `pool` gets filtered to
  `p.department === customer.shopsFor || p.department === 'unisex'` — otherwise a
  customer's own purchase history could still contain opposite-department items, the
  same bug one layer deeper.

## F. Console UI

`packages/app/public/index.html` and `shop.html`: add Arjun to the hardcoded `PERSONAS`
picker array alongside Priya/Aditi/Meera.

## G. Explicitly unchanged

The five agents' architecture, kernel/policy/tool-gateway boundaries, `m3_ref` trace
tagging, the 34.0% return-rate baseline, the four-Worker split, `category` filtering
behavior for queries that don't specify a department.

## H. Verification

`npm run gen`, `npm run db:local`, `npm run typecheck`, `npm run smoke`, then curl
`discovery.rank` for all four named personas with a query that would previously have
leaked cross-department items (e.g. "jacket", "footwear") and confirm no wrong-department
SKU appears in the top 5; spot-check that Arjun's and a few background male customers'
own `order_items` contain no women's-only SKUs.
