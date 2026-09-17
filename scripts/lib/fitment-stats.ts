/**
 * Loads the real anthropometric dataset (`fitment_dat.csv`, ~120k rows of
 * weight/age/height -> size) that grounds the Size & Fit agent's grading table.
 *
 * The file has no quoted fields, so a plain split is safe and a full sync read is fine
 * at ~2MB (unlike the 250MB fashion catalog, which is streamed).
 */
import { readFileSync } from 'node:fs';

export const APP_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type AppSize = typeof APP_SIZES[number];

export type FitmentRow = { weight: number; height: number; age: number };
export type FitmentBySize = Record<AppSize, FitmentRow[]>;

/** The source has no XS and no XXL/XXXL bucket the app can use, so sizes collapse. */
const SIZE_COLLAPSE: Record<string, AppSize | undefined> = {
  XXS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL', XXL: 'XL', XXXL: 'XL',
};

export function loadFitmentRows(csvPath: string): FitmentBySize {
  const bySize: FitmentBySize = { XS: [], S: [], M: [], L: [], XL: [] };
  const text = readFileSync(csvPath, 'utf8');
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [weightRaw, ageRaw, heightRaw, sizeRaw] = line.split(',');
    const size = SIZE_COLLAPSE[(sizeRaw ?? '').trim()];
    if (!size) continue;
    const weight = parseFloat(weightRaw), height = parseFloat(heightRaw), age = parseFloat(ageRaw);
    if (!isFinite(weight) || !isFinite(height) || !isFinite(age)) continue;
    bySize[size].push({ weight, height, age });
  }
  return bySize;
}

export function sizeStats(rows: FitmentRow[]) {
  const n = rows.length;
  const weightMean = rows.reduce((s, r) => s + r.weight, 0) / n;
  const heightMean = rows.reduce((s, r) => s + r.height, 0) / n;
  const weightStdev = Math.sqrt(rows.reduce((s, r) => s + (r.weight - weightMean) ** 2, 0) / n);
  const heightStdev = Math.sqrt(rows.reduce((s, r) => s + (r.height - heightMean) ** 2, 0) / n);
  return { weightMean, weightStdev, heightMean, heightStdev };
}

export function pickFitmentRow(bySize: FitmentBySize, size: AppSize, rnd: () => number): FitmentRow {
  const rows = bySize[size];
  return rows[Math.floor(rnd() * rows.length)];
}

/**
 * The real row closest to its own bucket's mean - i.e. the most "typical" real person
 * of that size, not an arbitrary one. Real data has real outliers (a genuine XXS/S/M/L/XL
 * label can, on raw measurements, sit closer to a neighbouring band than its own), which
 * is correct for ordinary seeded customers but wrong for the two hand-authored demo
 * personas whose whole point is a clean, legible fit story - so they get the
 * representative row instead of a random draw, same principle as their hand-set
 * fit_profiles rows elsewhere in gen-seed.ts.
 */
export function pickRepresentativeRow(bySize: FitmentBySize, size: AppSize): FitmentRow {
  const rows = bySize[size];
  const { weightMean, weightStdev, heightMean, heightStdev } = sizeStats(rows);
  return rows.reduce((best, r) => {
    const d = Math.abs(r.weight - weightMean) / weightStdev + Math.abs(r.height - heightMean) / heightStdev;
    const bestD = Math.abs(best.weight - weightMean) / weightStdev + Math.abs(best.height - heightMean) / heightStdev;
    return d < bestD ? r : best;
  });
}
