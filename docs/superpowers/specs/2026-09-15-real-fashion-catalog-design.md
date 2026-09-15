# Real fashion catalog + fitment-grounded Size & Fit — design

## Why

`packages/services/seed.sql` (via `scripts/gen-seed.ts`) is entirely synthetic: invented
titles ("Aurelia midnight dress"), invented brands, invented bust/waist/hip cm size
charts. Two real datasets were dropped into the repo root:

- `Fashion Data.csv` — 194k-row real scrape (Ajio, India): title, brand, image URLs,
  ₹ prices, colour, 197-way category taxonomy, star ratings (82% zero/unusable),
  free-text product detail blobs.
- `fitment_dat.csv` — 120k real records of `weight, age, height → size`
  (`XXS/S/M/L/XL/XXL/XXXL`).

Goal: replace the synthetic product catalog with 1200 real SKUs, and ground the Size &
Fit agent's grading table in the real anthropometric data, without changing the app's
architecture, agent boundaries, trace tagging, or the 34.0% return-rate baseline the
demo quotes.

## A. Product catalog ingestion

`scripts/gen-seed.ts` gains a CSV ingestion step (hand-rolled quote-aware line parser,
no new dependency — the files are large enough that a streaming parse matters):

1. **Filter.** Drop rows with no usable image, no price, or a category in an exclusion
   list: intimates/lingerie/swimwear/nightwear/baby items, and the handful of corrupted
   numeric-junk category values (e.g. `830316018`).
2. **Category mapping.** Keyword-rule mapping from the real 197-way taxonomy into the
   app's existing 8 categories (`dresses, tops, knitwear, outerwear, trousers, skirts,
   footwear, accessories`) — e.g. Kurtas/Shirts/Tshirts/Blouses → `tops`; Sarees/Women's
   Ethnic/Lehenga/Dresses/Jumpsuits → `dresses`; every Slippers/Sandals/Shoes/Casuals
   variant → `footwear`; Handbags/Watches/Jewellery/Scarves/Belts → `accessories`;
   Jeans/Track Pants/Leggings/Shorts/Dhoti → `trousers`; Sweaters/Sweatshirts/Hoodies →
   `knitwear`; Jackets & Coats/Blazers → `outerwear`; Skirts/Skirt/Skirts & Ghagras →
   `skirts`. No category may end up empty.
3. **Sample.** Using the same deterministic seeded PRNG already in the file, sample up
   to 150 real rows per category → exactly 1200 SKUs, deduped by title+brand.
4. **Field mapping.**
   - `title`, `brand`, `colour` (first value if comma-listed) — real, as-is.
   - `image_url` — new `products` column, first URL from the `images` field (delimiter
     is either `~^` or `,` depending on source row — handle both).
   - `price_gbp` — `selling_price` (₹) divided by a fixed conversion constant chosen to
     preserve the existing price-tier spread (value/private_label/core/premium), not
     the literal ₹/£ rate — the real rate would squash nearly everything into "value"
     and break the affluent-customer premium-tier narrative the personas rely on.
     Outlier prices clipped before conversion.
   - `price_tier` — inferred from the converted price against fixed £ thresholds
     (replacing the old brand-list-based tier).
   - `material` — heuristically extracted from `product_detials` text (cotton, silk,
     wool, linen, viscose, denim, leather...) via keyword match; falls back to the
     existing synthetic pick when nothing matches.
   - `rating`, `style_tags`, `cut` — stay synthetic (real ratings are ~82%
     zero/missing; the source has no style-tag or brand-cut equivalent).
5. Everything downstream — `inventory`, `orders`/`order_items`, the exact-quota 34%
   return rate, the four named personas — is untouched: it already only consumes a
   `{sku, category, brand, price, tier, cut}` shape from the products array.

## B. Fit & Size Agent — real anthropometric grounding

**Schema (`packages/services/schema.sql`):**
- `customers` gains `height_cm REAL`, `weight_kg REAL`, `age INTEGER`.
- `fit_profiles` drops `bust_cm`, `waist_cm`, `hip_cm`.
- `size_charts` drops `brand` and its cm columns; becomes `(category, size,
  weight_kg_avg, weight_kg_stdev, height_cm_avg, height_cm_stdev)` — one row per
  (category, size), derived from real per-size statistics in `fitment_dat.csv`.
  Fitment sizes are collapsed to the app's existing 5 sizes: `XXS→XS`, `XL/XXL/XXXL`
  folded into `XL` (weighted). No change to `inventory`/`orders` sizing.

**Seed generation (`scripts/gen-seed.ts`):**
- Compute real per-size weight/height mean+stdev once from `fitment_dat.csv`, reused
  for every category's `size_charts` rows (the dataset isn't category-specific).
- Each seeded customer gets `height_cm`/`weight_kg`/`age` sampled from a real
  `fitment_dat.csv` row matching (via the size collapse above) their dominant
  historical preferred size, so a customer's body stats agree with their own
  purchase/fit history. Customers with no fit history get an unconditioned random real
  row. C001/C003 (hand-authored personas) get an explicit matching row (M / S
  respectively) for narrative consistency.

**Agent (`packages/app/src/agents/fit.ts`):**
- `k.invoke('fit.sizechart.get', { category })` (brand dropped from the call).
- Matching swaps the bust/waist delta-vs-cm-tolerance calculation for a normalized
  height/weight distance against each size's real mean/stdev; nearest size wins.
- Same downstream logic unchanged: `cut` (`runs_small`/`runs_large`) nudges the size
  by one step, `fit_preference: 'relaxed'` nudges up, confidence = observation depth +
  match tightness + cut bonus − prior-fit-return penalty, abstain below 70%.
- Evidence field renamed from `grading_delta_cm` to a unitless `grading_delta`
  (z-score-like); `shop.html`'s "Why?" panel and the `fit.explanation` prompt copy
  updated to match (no more literal "cm").

**Other touch points:** `packages/services/src/index.ts` (`/size-charts/:category`,
drop `:brand`; `/fit/:customerId` also returns the customer's `height_cm`/`weight_kg`/
`age`), `packages/tools/registry/tools/fit.sizechart.get.json` (drop `brand` from
`input_schema`/`transport.path`), `packages/llm/prompts/fit.explanation.json` (copy),
`DEVIATIONS.md` §5 (note the scorecard's grading distance is now grounded in a real
~120k-row anthropometric dataset, still not a trained model — same distinction as
today, better data).

## C. Frontend realism

- `packages/app/public/shop.html`: real `<img src="${p.image_url}">` in the product
  grid card (`.ph`, CSS already has `.card .ph img{object-fit:cover}` unused) and the
  PDP hero image. Falls back to the existing emoji only if `image_url` is missing.
- `packages/app/public/index.html` (trace console): the kernel's tool-call trace step
  only ever records `{args, ok, error}` — never the tool's returned data — by design,
  to keep traces lean. That does not change. Instead the console keeps a client-side
  `sku → image_url` map built from product data already present in chat replies, and
  `renderTrace` shows a small thumbnail next to any step whose `args.sku`/`args.category`
  it can resolve. Purely additive frontend change, no kernel/trace-shape change.

## D. Explicitly unchanged

1200 SKUs, 34.0% return-rate baseline (58/22/12/8 reason mix), the four personas
(C001–C003, guest C000), all five agents, the kernel/policy/tool-gateway boundaries,
`m3_ref` trace tagging, the four-Worker split and its D1-only-on-`services` capability
boundary.

## E. Verification

`npm run gen` (acceptance numbers must still read `products 1200`, `RETURN RATE 34.0%`),
`npm run db:local`, `npm run typecheck`, `npm run smoke`, then a manual look at
`shop.html` and the trace console in a browser preview (product images render, size
recommendation still explains itself, abstain path still works for C002).
