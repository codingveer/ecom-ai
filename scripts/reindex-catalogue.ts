export {};
/**
 * One-time (or per-reseed) indexing step: POSTs to the services Worker's
 * /catalogue/reindex, which embeds every product description via Workers AI and
 * upserts the vectors into the neutail-catalogue Vectorize index.
 *
 * Requires npm run dev:services (or npm run dev) already running, and the Vectorize
 * index already created (see README.md's Deploying section, or Task 3 Step 1 of
 * docs/superpowers/plans/2026-09-17-semantic-search.md).
 */
const SERVICES_URL = process.env.SERVICES_URL ?? 'http://localhost:8101';

const res = await fetch(`${SERVICES_URL}/catalogue/reindex`, { method: 'POST' });
if (!res.ok) {
  console.error(`reindex failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const body = await res.json() as { indexed: number };
console.log(`Indexed ${body.indexed} products into Vectorize.`);
