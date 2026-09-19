# Admin dashboard: Users section

## Goal

Add a read-only "Users" section to the existing admin dashboard (`packages/app/public/admin.html`)
that lets an admin search customers and view the full data Neu.Tail holds about any one of them.

## Non-goals

- Editing customer data (consent flags, loyalty tier, etc.) — view-only for now.
- New tables or schema changes — everything needed already exists in `packages/services/schema.sql`.
- Cross-agent access — this is admin-only, same trust boundary as the existing products/credits/AI-keys
  panels.

## Data

No schema changes. The full view aggregates existing tables: `customers`, `loyalty_accounts`,
`subscriptions`, `fit_profiles`, `context_store`, `orders`/`order_items`, `returns`, `events`.

## Services layer (`packages/services/src/index.ts`)

- `GET /admin/customers` — paginated list. Query params: `q` (matches `id`, `name`, or `email`),
  `city`, `page`, `pageSize`. Mirrors the existing `/admin/products` handler's shape
  (`{ page, pageSize, total, results }`).
- `GET /admin/customers/:id/full` — one customer's full 360 view. Reuses the aggregation already
  in `/customers/:id/profile` (identity, consent, loyalty, subscription, transaction/return
  summary) and adds:
  - `fit_profiles` rows for that customer
  - `context_store` rows for that customer (cross-session agent memory)
  - last 20 `orders`, last 20 `returns`, last 20 `events` (raw activity, not just aggregates)

  404s with `{ error: 'customer_not_found' }` if the id doesn't exist, matching existing customer
  endpoints' error shape.

## Tool contracts (`packages/tools/registry/tools/`)

Two new JSON contracts, modeled directly on `catalogue.admin.list.json` / `catalogue.admin.get.json`:

- `customer.admin.list.json` — `allowed_agents: ["admin"]`, transport `GET services/admin/customers`.
- `customer.admin.get.json` — `allowed_agents: ["admin"]`, transport
  `GET services/admin/customers/{id}/full`.

Registering these means `npm run gen` must be re-run so `packages/tools/src/bundled.ts` picks them up.

## App routes (`packages/app/src/index.ts`)

- `GET /admin/customers` and `GET /admin/customers/:id`, both gated by the existing `adminAuthed(c)`
  check (same `x-admin-token` header convention as `/admin/products`).
- Each constructs a `Kernel('admin', new Trace(), c.env)` and calls `k.invoke('customer.admin.list', ...)`
  / `k.invoke('customer.admin.get', { id })`, matching the existing products admin routes exactly.

## UI (`packages/app/public/admin.html`)

A new "Users" section, placed below the existing products table (same page, same login gate —
no new auth surface).

- **Search bar**: text input (matches id/name/email) + a city filter, "Search" button — same
  interaction pattern as the products filter bar.
- **Table**: columns `id`, `name`, `email`, `city`, `joined_at`, `loyalty tier`, `lifetime spend`.
  Paginated with the same prev/next control pattern as the products table.
- **Detail panel**: clicking a row opens a slide-in panel (new `#userPanel`, separate from the
  existing product-edit `#panel` so the two don't collide) showing, read-only:
  - Identity & consent (id, name, email, city, joined date, tenure, shops_for, consent flags)
  - Loyalty & subscription
  - Transactions & returns summary
  - Fit profiles (per-category preferred size / fit preference)
  - Context store entries (key/value/updated_at)
  - Recent activity: last orders, returns, events (each a small scrollable list)
  - No save/cancel actions — a single "Close" control.

## Error handling

Follows existing conventions: missing/invalid admin token → 401 `{ error: 'unauthorized' }`;
unknown customer id → 404 `{ error: 'customer_not_found' }`; the UI shows the error text inline
near the search bar or panel rather than failing silently.

## Testing

No dedicated test suite exists for this repo beyond `npm run typecheck` and `npm run smoke`
(per `CLAUDE.md`). Verification is: `npm run typecheck` passes, `npm run gen` + `npm run db:local`
succeed, and manual verification via the running admin UI (search, paginate, open a user, confirm
all sections render) plus a couple of direct curls against the new endpoints.
