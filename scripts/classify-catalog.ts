#!/usr/bin/env tsx
/**
 * classify-catalog.ts
 *
 * Enriches packages/services/seed.sql with GPT-4o vision-grounded product data:
 *   - department: women | men | unisex   (image-verified, not heuristic)
 *   - category:   one of the 8 app categories (with knitwear/outerwear boundary fixed)
 *   - style_tags: 3-5 from an expanded 20-tag vocabulary
 *   - description: 2-sentence AI-written marketing copy (rich for semantic search)
 *
 * Smart cache (scripts/.classify-cache.json, keyed by SKU):
 *   - "vision" / "title" entries are NEVER re-run — already good
 *   - "heuristic" entries (API failures) are retried on the next run
 *
 * Usage:
 *   npm run classify
 *   (OPENAI_API_KEY must be in .env or as an env var)
 *
 * Cost: ~$2–3 for all 1200 products with gpt-4o (detail:low images)
 *
 * After running:
 *   npm run db:local                                        — local D1
 *   npm run db:remote                                       — deployed D1
 *   SERVICES_URL=https://neutail-services.veereshk21.workers.dev npm run catalogue:reindex
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH  = resolve(__dirname, '../packages/services/seed.sql');
const CACHE_PATH = resolve(__dirname, '.classify-cache.json');
const MODEL      = 'gpt-4o';
const CONCURRENCY = 15; // gpt-4o TPM limit is 800K — safe at this concurrency

// ── .env loader ─────────────────────────────────────────────────────────────

for (const name of ['.env']) {
  const p = resolve(__dirname, '..', name);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY not set. Add it to .env or pass as env var.');
  process.exit(1);
}

// ── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = ['dresses','tops','knitwear','outerwear','trousers','skirts','footwear','accessories'] as const;
type AppCategory = typeof CATEGORIES[number];

const STYLE_SET = new Set([
  // Use-case
  'occasion','workwear','everyday','party','minimal','statement','layering','holiday',
  // Style/pattern
  'floral','printed','solid','ethnic','western','formal','casual',
  // Fit
  'oversized','fitted',
  // Season
  'summer','winter','transitional',
]);

// ── Types ────────────────────────────────────────────────────────────────────

type CacheEntry = {
  department: 'women' | 'men' | 'unisex';
  category: AppCategory;
  style_tags: string[];
  description: string | null;
  source: 'vision' | 'title' | 'heuristic';
};
type Cache = Record<string, CacheEntry>;

type ProductRow = {
  sku: string; title: string; category: string; brand: string;
  price_gbp: string; price_tier: string; colour: string; material: string;
  style_tags: string; cut: string; rating: string; return_rate: string;
  image_url: string; department: string; description: string;
};

// ── SQL parser ───────────────────────────────────────────────────────────────

function parseSqlRow(tuple: string): string[] {
  const values: string[] = [];
  let i = 0;
  while (i < tuple.length) {
    while (i < tuple.length && (tuple[i] === ' ' || tuple[i] === '\n' || tuple[i] === '\r' || tuple[i] === ',')) i++;
    if (i >= tuple.length) break;
    if (tuple[i] === "'") {
      i++;
      let val = '';
      while (i < tuple.length) {
        if (tuple[i] === "'" && tuple[i + 1] === "'") { val += "'"; i += 2; }
        else if (tuple[i] === "'") { i++; break; }
        else val += tuple[i++];
      }
      values.push(val);
    } else {
      let val = '';
      while (i < tuple.length && tuple[i] !== ',' && tuple[i] !== '\n') val += tuple[i++];
      values.push(val.trim());
    }
  }
  return values;
}

function extractProductTuples(sql: string): Array<{ raw: string; row: ProductRow }> {
  const results: Array<{ raw: string; row: ProductRow }> = [];
  const blockRe = /INSERT INTO products \([^)]+\) VALUES\n([\s\S]*?)(?=;)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(sql)) !== null) {
    const tupleRe = /\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = tupleRe.exec(blockMatch[1])) !== null) {
      const fields = parseSqlRow(m[1]);
      if (fields.length < 15) continue;
      results.push({
        raw: m[0],
        row: {
          sku: fields[0], title: fields[1], category: fields[2], brand: fields[3],
          price_gbp: fields[4], price_tier: fields[5], colour: fields[6], material: fields[7],
          style_tags: fields[8], cut: fields[9], rating: fields[10], return_rate: fields[11],
          image_url: fields[12], department: fields[13], description: fields[14],
        },
      });
    }
  }
  return results;
}

// ── SQL value quoting ────────────────────────────────────────────────────────

function q(v: string | number): string {
  if (typeof v === 'number') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

function rowToSql(r: ProductRow): string {
  return `(${[
    r.sku, r.title, r.category, r.brand, r.price_gbp, r.price_tier,
    r.colour, r.material, r.style_tags, r.cut, r.rating, r.return_rate,
    r.image_url, r.department, r.description,
  ].map((v, i) => [4,10,11].includes(i) ? v : q(v as string)).join(',')})`;
}

// Fallback template description (used only when AI description is null)
function describeProduct(r: ProductRow, category: string, styleTags: string[]): string {
  const cutPhrase = r.cut === 'runs_small' ? 'a snug, true-to-body cut'
    : r.cut === 'runs_large' ? 'a relaxed, roomy cut' : 'a true-to-size cut';
  const article = /^[aeiou]/i.test(r.colour) ? 'An' : 'A';
  return `${article} ${r.colour} ${r.material} ${r.title.toLowerCase()} by ${r.brand}, ${cutPhrase}, `
    + `from the ${category} range, tagged ${styleTags.join(', ')}.`;
}

// ── GPT-4o classifier ────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ajio CDN uses hotlink protection — fetch locally with browser headers,
// convert to base64 so OpenAI never touches the CDN.
async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.ajio.com/',
        // Exclude avif — GPT-4o vision only supports png/jpeg/gif/webp
        'Accept': 'image/webp,image/jpeg,image/png,image/*;q=0.5',
      },
    });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
    if (!['image/jpeg','image/png','image/gif','image/webp'].includes(mime)) return null;
    const buf = await res.arrayBuffer();
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  }
}

const PROMPT = (title: string) =>
  `You are a fashion catalog expert. Product title: "${title}"\n\n` +
  `Respond with JSON only (no markdown):\n` +
  `{\n` +
  `  "department": "women|men|unisex",\n` +
  `  "category": "dresses|tops|knitwear|outerwear|trousers|skirts|footwear|accessories",\n` +
  `  "style_tags": ["3-5 tags"],\n` +
  `  "description": "2 sentence marketing description"\n` +
  `}\n\n` +
  `Rules:\n` +
  `- department "women": dresses, skirts, sarees, lehengas, blouses, kurtas/kurtis, salwar suits, gowns, frocks, women's tops/t-shirts/tanks, women's jewellery (earrings, necklaces, chokers, anklets, nosepins, bangles, rings), hair accessories (hair clips, hair bands, headbands, scrunchies, hair ties), handbags, totes, clutches, sling bags, shoulder bags, dupattas, shawls, stoles, tights, heels, flats, pumps — anything feminine or modeled on female figures\n` +
  `- department "men": shirts, trousers, suits, kurta-pyjama, dhotis, men's garments — anything clearly menswear\n` +
  `- department "unisex": ONLY truly gender-neutral items — sneakers, running/athletic shoes, backpacks, watches, belts, sunglasses, socks, caps/beanies, traditional unisex rakhis. If an accessory is jewellery, a handbag/purse, or hair styling, classify it as "women".\n` +
  `- category "knitwear": sweaters, cardigans, jumpers, pullovers, knit tops — worn as a mid-layer\n` +
  `- category "outerwear": jackets, coats, blazers, rainwear — worn OVER other clothing as the outermost layer\n` +
  `- category: pick the single best match\n` +
  `- style_tags: 3-5 from: occasion, workwear, everyday, party, minimal, statement, layering, holiday, floral, printed, solid, ethnic, western, formal, casual, oversized, fitted, summer, winter, transitional\n` +
  `- description: 2 vivid marketing sentences — fabric, silhouette, occasion suitability. Use fashion vocabulary. This is used for search indexing so be specific and accurate.`;

function parseResponse(content: string): Omit<CacheEntry, 'source'> | null {
  const raw = JSON.parse(content);
  const department = (['women','men','unisex'] as const).find(d => d === raw.department) ?? null;
  const category = CATEGORIES.find(c => c === raw.category) ?? null;
  const style_tags = Array.isArray(raw.style_tags)
    ? (raw.style_tags as string[]).filter(t => STYLE_SET.has(t)).slice(0, 5)
    : [];
  if (!department || !category || style_tags.length === 0) return null;
  const description = typeof raw.description === 'string' && raw.description.length > 20
    ? raw.description.trim() : null;
  return { department, category, style_tags, description };
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.status === 429 && attempt < retries) {
        const wait = err?.headers?.['retry-after']
          ? Number(err.headers['retry-after']) * 1000
          : Math.min(1000 * 2 ** attempt, 8000);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('max retries exceeded');
}

let firstError: string | null = null;

async function classify(imageUrl: string, title: string): Promise<CacheEntry | null> {
  // 1. Try vision (image + title) — most accurate
  const dataUri = await fetchImageAsBase64(imageUrl);
  if (dataUri) {
    try {
      const resp = await withRetry(() => openai.chat.completions.create({
        model: MODEL, max_tokens: 300, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUri, detail: 'low' } },
          { type: 'text', text: PROMPT(title) },
        ]}],
      }));
      const result = parseResponse(resp.choices[0].message.content ?? '{}');
      if (result) return { ...result, source: 'vision' };
    } catch (err) { if (!firstError) firstError = String(err); }
  }

  // 2. Fall back to title-only — GPT-4o is still accurate from the product name alone
  try {
    const resp = await withRetry(() => openai.chat.completions.create({
      model: MODEL, max_tokens: 300, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: PROMPT(title) }],
    }));
    const result = parseResponse(resp.choices[0].message.content ?? '{}');
    if (result) return { ...result, source: 'title' };
  } catch (err) { if (!firstError) firstError = String(err); }

  return null;
}

// ── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let idx = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < items.length) await fn(items[idx++]);
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

const sql = readFileSync(SEED_PATH, 'utf8');
const products = extractProductTuples(sql);

if (!products.length) {
  console.error('No products found in seed.sql. Run `npm run gen` first.');
  process.exit(1);
}

const cache: Cache = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
  : {};

// Only classify products not yet vision/title classified
const todo = products.filter(p => {
  const e = cache[p.row.sku];
  return !e || e.source === 'heuristic';
});

const cached = products.length - todo.length;
console.log(`\nModel:    ${MODEL}`);
console.log(`Products: ${products.length} total — ${cached} already classified, ${todo.length} to run`);

// gpt-4o cost: $2.50/1M input, $10/1M output; image detail:low = 85 tokens
const inputTokens  = todo.length * (85 + 250);  // image + prompt
const outputTokens = todo.length * 120;           // JSON response
const estCost = (inputTokens / 1e6 * 2.50 + outputTokens / 1e6 * 10).toFixed(2);
console.log(`Est. cost: ~$${estCost} for ${todo.length} products\n`);

let done = 0, errors = 0, vision = 0, titleOnly = 0;

await runPool(todo, CONCURRENCY, async ({ row }) => {
  const result = await classify(row.image_url, row.title);
  if (result) {
    cache[row.sku] = result;
    if (result.source === 'vision') vision++;
    else titleOnly++;
  } else {
    errors++;
    cache[row.sku] = {
      department: row.department as CacheEntry['department'],
      category: row.category as AppCategory,
      style_tags: row.style_tags.split(',').filter(t => STYLE_SET.has(t)),
      description: null,
      source: 'heuristic',
    };
  }
  done++;
  process.stdout.write(
    `\r  ${done}/${todo.length} — vision: ${vision}  title-only: ${titleOnly}  heuristic: ${errors}  `,
  );
});

console.log('\n\nSaving cache...');
writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

// Patch seed.sql
let patched = sql;
let updated = 0;
for (const { raw, row } of products) {
  const entry = cache[row.sku];
  if (!entry) continue;
  const newRow: ProductRow = {
    ...row,
    category: entry.category,
    department: entry.department,
    style_tags: entry.style_tags.join(','),
    description: entry.description ?? describeProduct(row, entry.category, entry.style_tags),
  };
  const newSql = rowToSql(newRow);
  if (newSql !== raw) { patched = patched.replace(raw, newSql); updated++; }
}
writeFileSync(SEED_PATH, patched);

// Summary
const deptCount: Record<string, number> = { women: 0, men: 0, unisex: 0 };
const catCount: Record<string, number>  = {};
const srcCount: Record<string, number>  = { vision: 0, title: 0, heuristic: 0 };
for (const { row } of products) {
  const e = cache[row.sku];
  if (!e) continue;
  deptCount[e.department] = (deptCount[e.department] ?? 0) + 1;
  catCount[e.category]    = (catCount[e.category] ?? 0) + 1;
  srcCount[e.source]      = (srcCount[e.source] ?? 0) + 1;
}

console.log(`\nUpdated ${updated}/${products.length} rows in seed.sql\n`);

console.log('Source breakdown:');
console.log(`  vision       ${srcCount.vision}   (image + title via ${MODEL})`);
console.log(`  title-only   ${srcCount.title}   (title via ${MODEL}, image unavailable)`);
console.log(`  heuristic    ${srcCount.heuristic}   (API failed — will retry next run)`);

console.log('\nDepartment:');
for (const [d, n] of Object.entries(deptCount)) console.log(`  ${d.padEnd(10)} ${n}`);

console.log('\nCategory:');
for (const [c, n] of Object.entries(catCount).sort((a, b) => b[1] - a[1]))
  console.log(`  ${c.padEnd(14)} ${n}`);

if (firstError) console.log(`\nFirst error: ${firstError}`);

if (srcCount.heuristic > 0)
  console.log(`\n${srcCount.heuristic} products need a retry — run npm run classify again.`);

console.log('\nNext steps:');
console.log('  npm run db:local');
console.log('  npm run db:remote');
console.log('  APP_URL=https://neutail-app.veereshk21.workers.dev npm run catalogue:reindex');
