export {};
/**
 * Paginates through the remote /catalogue/reindex endpoint in pages of 100 so
 * each request stays within Cloudflare Workers' subrequest limit.
 *
 * Remote (deployed):  APP_URL=https://neutail-app.veereshk21.workers.dev npm run catalogue:reindex
 * Local:              SERVICES_URL=http://localhost:8101 npm run catalogue:reindex
 */
const SERVICES_URL = process.env.SERVICES_URL;
const APP_URL      = process.env.APP_URL ?? 'http://localhost:8100';
const PAGE_SIZE    = 100;

function url(offset: number): string {
  if (SERVICES_URL) return `${SERVICES_URL}/catalogue/reindex?offset=${offset}&limit=${PAGE_SIZE}`;
  return `${APP_URL}/admin/reindex?offset=${offset}&limit=${PAGE_SIZE}`;
}

let offset = 0;
let total  = 0;

while (true) {
  const res = await fetch(url(offset), { method: 'POST' });
  if (!res.ok) {
    console.error(`reindex failed at offset ${offset}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json() as { indexed: number; done: boolean };
  total += body.indexed;
  offset += PAGE_SIZE;
  process.stdout.write(`\r  Indexed ${total} products...`);
  if (body.done) break;
}

console.log(`\nDone — indexed ${total} products into Vectorize.`);
