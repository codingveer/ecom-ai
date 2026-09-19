/**
 * Ingests the real Ajio fashion scrape (`Fashion Data.csv`, ~194k rows) into candidate
 * products for the app's existing 8 categories. Streamed with readline rather than
 * loaded whole, because the source file is ~250MB.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const APP_CATEGORIES = [
  'dresses', 'tops', 'knitwear', 'outerwear', 'trousers', 'skirts', 'footwear', 'accessories',
] as const;
export type AppCategory = typeof APP_CATEGORIES[number];

export const DEPARTMENTS = ['women', 'men', 'unisex'] as const;
export type Department = typeof DEPARTMENTS[number];

export type FashionCandidate = {
  title: string;
  brand: string;
  imageUrl: string;
  colour: string | null;
  priceInr: number;
  materialHint: string | null;
  department: Department;
};

/** First match wins; anything matching none of these (or an EXCLUDE keyword) is dropped. */
const EXCLUDE_KEYWORDS = [
  'night', 'bra', 'panty', 'pantie', 'lingerie', 'innerwear', 'brief', 'boxer', 'trunk',
  'shapewear', 'swimwear', 'baby', 'towel', 'bath robe', 'skd set', 'dress material',
  'vest', 'camisole', 'ziyaa',
];

const CATEGORY_RULES: Array<[AppCategory, string[]]> = [
  ['skirts', ['skirt', 'ghagra']],
  ['trousers', ['jean', 'jegging', 'trouser', 'track pant', 'legging', 'short', 'dhoti',
    'churidar', 'salwar', 'pyjama', 'pant', 'ethnic bottom']],
  ['footwear', ['footwear', 'shoe', 'boot', 'sneaker', 'flip flop', 'flipflop', 'slipper',
    'sandal', 'men_casuals', 'women_casuals', 'men_sports', 'women_sports', 'men_formals',
    'women_formals']],
  ['accessories', ['handbag', 'bag', 'wallet', 'clutch', 'backpack', 'belt', 'scarf', 'stole',
    'shawl', 'wrap', 'muffler', 'dupatta', 'jewel', 'necklace', 'earring', 'ring', 'bangle',
    'bracelet', 'watch', 'sunglass', 'cap', 'hat', 'sock', 'hair accessor', 'rakhi',
    'travel accessor']],
  ['knitwear', ['sweater', 'cardigan', 'sweatshirt', 'hoodie', 'shrug', 'bolero', 'thermal']],
  ['outerwear', ['jacket', 'coat', 'blazer', 'waistcoat', 'rainwear', 'windcheater', 'tracksuit']],
  ['dresses', ['dress', 'gown', 'frock', 'jumpsuit', 'playsuit', 'lehenga', 'kurta suit',
    'kurta pyjama', 'kurta-bottom', 'saree', "women's ethnic", 'womens ethnic',
    "women's western", 'womens western', 'fusion wear', 'suit set', 'dungaree']],
  ['tops', ['kurta', 'kurti', 'shirt', 'tshirt', 't-shirt', 'tunic', 'top', 'blouse']],
];

const MATERIAL_KEYWORDS = ['cotton', 'silk', 'polyester', 'rayon', 'leather', 'georgette',
  'viscose', 'denim', 'chiffon', 'satin', 'nylon', 'linen', 'velvet', 'wool'];

/**
 * Categories the raw taxonomy names unambiguously, with no explicit "men_"/"women_"
 * marker on the row itself (that marker is checked separately, first). Anything not
 * covered here (generic T-shirts, Jeans, Sweaters, Jackets, unprefixed Footwear/
 * Accessories) is genuinely cross-department in real retail too, so it falls through to
 * 'unisex' rather than a forced guess.
 */
const WOMEN_ONLY_KEYWORDS = ['saree', 'kurti', 'kurta suit', 'blouse', 'lehenga', 'ghagra',
  'salwar', 'churidar', 'dupatta', 'legging', "women's", 'womens',
  // Unambiguous women's garments often absent from the raw category prefix:
  'dress', 'gown', 'frock', 'playsuit', 'skirt'];
const MEN_ONLY_KEYWORDS = ["men's garments", 'dhoti', 'nehru jacket', "men's",
  // Men's traditional garment that appears in the dresses category rule:
  'kurta pyjama'];

/** Women checked before men everywhere below, so "women" text is never misread via a
 * careless `includes('men')` (the word "men" is a substring of "women"). */
function departmentFor(rawCategory: string, metaData: string, title: string): Department {
  const cat = rawCategory.trim().toLowerCase();
  if (cat.startsWith('women') || cat.includes('women_')) return 'women';
  if (cat.startsWith('men') || cat.includes('men_')) return 'men';

  // Include cat + title + metadata so "Floral Print A-line Dress" (cat="Dresses") is
  // caught by the 'dress' keyword rather than falling through to 'unisex'.
  const text = `${cat} ${metaData} ${title}`.toLowerCase();
  if (/\bfor women\b/.test(text)) return 'women';
  if (/\bfor men\b/.test(text)) return 'men';

  if (WOMEN_ONLY_KEYWORDS.some(k => text.includes(k))) return 'women';
  if (MEN_ONLY_KEYWORDS.some(k => text.includes(k))) return 'men';

  return 'unisex';
}

function mapCategory(rawCategory: string): AppCategory | null {
  const c = rawCategory.trim().toLowerCase();
  if (!c || /^\d+$/.test(c) || c === 'sets' || c === 'set') return null;
  if (EXCLUDE_KEYWORDS.some(k => c.includes(k))) return null;
  for (const [appCategory, keywords] of CATEGORY_RULES) {
    if (keywords.some(k => c.includes(k))) return appCategory;
  }
  return null;
}

function extractMaterial(text: string): string | null {
  const t = text.toLowerCase();
  for (const m of MATERIAL_KEYWORDS) if (t.includes(m)) return m;
  return null;
}

/**
 * Only assets.ajio.com URLs are live (spot-checked): udaan.azureedge.net blobs come
 * back "BlobArchived" (Azure cold-tier, no longer servable), ik.imagekit.io rows are
 * truncated to a bare transform prefix with no filename, and the handful of bijnis.com
 * rows end in a literal "/undefined". Restricting to the one confirmed-live host beats
 * shipping ~35% dead image links into the catalog.
 */
function firstImageUrl(raw: string): string | null {
  if (!raw) return null;
  const parts = raw.includes('~^') ? raw.split('~^') : raw.split(',');
  const first = parts.find(u => {
    const trimmed = u.trim();
    if (!trimmed.toLowerCase().startsWith('http')) return false;
    try { return new URL(trimmed).hostname === 'assets.ajio.com'; } catch { return false; }
  });
  return first ? first.trim() : null;
}

function firstColour(raw: string): string | null {
  const first = raw.split(',')[0]?.trim();
  return first || null;
}

/** Quote-aware CSV line splitter. Returns `carry` when a quoted field spans a newline. */
function parseCsvLine(line: string): { fields: string[]; carry: boolean } {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return { fields, carry: inQuotes };
}

/** Simple reservoir sample (Algorithm R) so per-category memory stays bounded on a 194k-row file. */
function reservoirPush<T>(reservoir: T[], seen: number, item: T, cap: number, rnd: () => number) {
  if (reservoir.length < cap) reservoir.push(item);
  else {
    const j = Math.floor(rnd() * seen);
    if (j < cap) reservoir[j] = item;
  }
}

export async function loadFashionCatalog(
  csvPath: string,
  opts: { rnd: () => number; reservoirSize?: number },
): Promise<Record<AppCategory, FashionCandidate[]>> {
  const cap = opts.reservoirSize ?? 4000;
  const pools = Object.fromEntries(APP_CATEGORIES.map(c => [c, [] as FashionCandidate[]])) as
    Record<AppCategory, FashionCandidate[]>;
  const seenPerCategory = Object.fromEntries(APP_CATEGORIES.map(c => [c, 0])) as Record<AppCategory, number>;
  const dedupe = new Set<string>();

  const rl = createInterface({ input: createReadStream(csvPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let header: string[] | null = null;
  let buffer = '';
  let pending = false;

  for await (const line of rl) {
    buffer = pending ? buffer + '\n' + line : line;
    const { fields, carry } = parseCsvLine(buffer);
    if (carry) { pending = true; continue; }
    pending = false;
    const row = fields;
    buffer = '';
    if (!header) { header = row.map(h => h.replace(/^﻿/, '')); continue; }

    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = row[i] ?? ''; });

    const category = mapCategory(rec.category ?? '');
    if (!category) continue;

    const title = (rec.title ?? '').trim();
    const brand = (rec.brand ?? '').trim();
    if (!title || !brand) continue;

    const imageUrl = firstImageUrl(rec.images ?? '');
    if (!imageUrl) continue;

    const priceInr = parseFloat(rec.selling_price ?? '');
    if (!isFinite(priceInr) || priceInr <= 0) continue;

    const dedupeKey = `${brand.toLowerCase()}|${title.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    const candidate: FashionCandidate = {
      title, brand, imageUrl,
      colour: firstColour(rec.colour ?? ''),
      priceInr,
      materialHint: extractMaterial(`${rec.product_detials ?? ''} ${rec.meta_data ?? ''}`),
      department: departmentFor(rec.category ?? '', rec.meta_data ?? '', title),
    };

    seenPerCategory[category]++;
    reservoirPush(pools[category], seenPerCategory[category], candidate, cap, opts.rnd);
  }

  return pools;
}
