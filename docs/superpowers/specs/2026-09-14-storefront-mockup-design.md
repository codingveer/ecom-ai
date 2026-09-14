# Simple storefront mockup for the personalisation demo

Date: 2026-09-14
Status: approved, pending implementation

## Goal

The existing demo console (`packages/app/public/index.html`) is a split debug view —
a chat pane next to a live trace panel — built for explaining the architecture to
judges (`DEMO.md`'s script walks through it step by step). It's the right tool for that
job, but it doesn't look or feel like a real e-commerce site, which makes the "same
query, different customer, different result" personalisation story harder to *feel* as
a shopper would experience it.

Add a second, simpler front end that looks like a real storefront and demonstrates the
same five backend flows, without touching the backend at all.

## Architecture

One new static file, `packages/app/public/shop.html` — same pattern as the existing
`index.html` (self-contained vanilla HTML/CSS/JS, no build step, no framework), served
by the `app` Worker's existing `ASSETS` binding and catch-all route
(`app.all('*', c => c.env.ASSETS.fetch(c.req.raw))` in `packages/app/src/index.ts` —
unchanged). Reachable at `/shop.html`.

**No backend changes.** It calls the exact same `POST /session/:id/message` endpoint
the existing console uses. Storefront actions are translated into short text strings
that the existing intent classifier already routes correctly:

- A search box submission sends the query text as-is → `discovery.rank`.
- A product's "Check my size" button sends `"what size should I get for ${sku}?"` →
  `fit.check`. The literal `SKU-\d{5}`-shaped code in the text is what both the mock
  provider (`packages/llm/src/mock.ts`, regex `SKU-\d{5}`) and a real LLM would extract
  as the target product — verified against the mock provider's actual rules, not
  assumed. Deliberately no category keyword is included in this string, so the fit
  agent resolves category from the real product record (`catalogue.product.get`)
  rather than from a guessed keyword that could conflict with it.
- The account view's subscription card sends `"tell me about the styling advisory
  plan"` → `upsell.moment`; its Accept button sends `"accept"` (handled specially in
  `session-do.ts` when a `pendingOffer` is on the session).
- The account view's "Simulate a purchase" button sends `"how many points did I
  earn?"` → `loyalty.event` (accrual path); a redeem mini-form sends `"redeem
  ${n}"`, matching the existing `redeemMatch` regex in `session-do.ts`.
- On first entering the Account view, a `"who am I"` message is sent → `profile.refresh`,
  to read the segment/tier without triggering any side effect.

Each page links to the other ("View storefront mockup" from the console, "View
technical console" from the storefront), so both views of the same live backend stay
reachable from either entry point.

**Session handling** mirrors the existing console: `sessionId = 'shop-' + customerId +
'-' + Date.now()`, reset whenever the persona switches. The `'shop-'` prefix (vs. the
console's `'web-'`) keeps the two UIs from colliding on session state for the same
persona — they're independent demo entry points into the same customer/backend data.

## Views (one page, client-side view switching — no router, no page reloads)

1. **Header** — brand wordmark, a compact persona switcher (Priya/Aditi/Meera), a
   tier/points badge (populated once the Account view has been visited or a purchase
   simulated), a decorative cart icon+count, and Shop/Account nav links.

2. **Shop view** — a search bar plus category quick-filter pills (Dresses, Outerwear,
   Knitwear, ...) that populate and submit the search. Results render as a product
   grid: each card gets a category-coloured placeholder block (the seed data has no
   product images), title, brand, price, star rating, and a stock note. Above the grid,
   a one-line personalisation blurb (the `rationale` text the discovery agent already
   returns) with a collapsed **"Why am I seeing this?"** toggle that reveals it in full
   plus the price-tier mix — collapsed by default so the storefront reads as a normal
   site until someone asks.

3. **Product detail** (an overlay/panel over the grid, not a separate route) — a larger
   placeholder, title/brand/price/rating, and a "Check my size" button. Firing it shows
   either the recommended size + confidence (highlighted in a size row) or the honest
   abstain message ("not enough fit history to recommend a size"), with the same
   collapsed "why" reveal using the fit explanation text already returned by the
   backend. "Add to bag" is decorative only — it increments the header's cart count
   client-side; there is no cart/checkout backend.

4. **Account view** — a profile/tier summary card (segment, loyalty tier), a
   subscription card that shows the current entitlement or, if eligible, the upsell
   offer with an Accept button, and a loyalty card with a balance/tier-progress display
   and a redeem-points mini-form. Because the backend has no side-effect-free "check my
   balance" flow — checking points *is* recording a purchase-accrual
   (`packages/app/src/agents/loyalty.ts`'s `accrue()`, always invoked by the
   `loyalty.event` intent unless the text matches `redeem N`) — the button that
   triggers this is labeled **"Simulate a purchase"**, not "Check my points", so the UI
   doesn't imply a passive read that the backend doesn't actually offer.

## Explicitly out of scope

- No real cart, checkout, or payment flow — "Add to bag" is a decorative counter.
- No new backend endpoints, tool contracts, agents, or changes to `session-do.ts`.
- No product images — CSS placeholder blocks only.
- No new "peek at balance without a purchase" backend flow. The account view's copy is
  upfront about this instead of adding one.
