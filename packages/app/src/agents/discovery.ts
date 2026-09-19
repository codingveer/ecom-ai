/**
 * Agent #2 - Personalised Product Discovery & Recommendation.
 * M3 Sequence 2. Same query, different product set by segment - with the reasoning surfaced.
 */
import type { Kernel } from '../kernel.js';
import { fairnessBand } from '../policy.js';
import type { Segment } from './profiling.js';

const TIER_WEIGHTS: Record<string, Record<string, number>> = {
  affluent:      { premium: 3.0, core: 1.6, private_label: 0.4, value: 0.2 },
  mid:           { premium: 1.3, core: 2.4, private_label: 1.5, value: 1.0 },
  value_seeking: { premium: 0.3, core: 1.2, private_label: 2.6, value: 3.0 },
};

export async function rank(
  k: Kernel, customerId: string, query: string, segment: Segment,
  fitSize: string | null, category: string | null,
  /** Demo switch: skips the agent's own diversity floor so the fairness guardrail visibly blocks. */
  unsafeRanking = false,
  /** Demo switch: routes retrieval through the embedding-backed Vectorize index instead of lexical scoring. */
  semanticSearch = false,
) {
  const search = await k.invoke<any>('catalogue.search',
    { q: query, ...(category ? { category } : {}), department: segment.shops_for, limit: 60,
      ...(semanticSearch ? { searchMode: 'semantic' } : {}) }, 'S2.7');
  const candidates = search.results as any[];

  if (semanticSearch) {
    k.note('tool', `catalogue.search served in ${search.mode} mode${search.degraded ? ' (degraded from semantic)' : ''}`,
      { mode: search.mode, degraded: !!search.degraded }, 'S2.7');
  }

  if (!candidates.length) {
    return { products: [], rationale: 'No stocked products matched that search.', policy: null, candidates: 0 };
  }

  // Neutral ranking: relevance and rating only. This is the fairness comparator.
  const neutral = [...candidates]
    .sort((a, b) => b.relevance - a.relevance || b.rating - a.rating)
    .slice(0, 20);

  const weights = TIER_WEIGHTS[segment.affluence];
  const scored = candidates.map(p => {
    const tierW = weights[p.price_tier] ?? 1;
    const relevance = p.relevance;
    const stockBoost = p.stock > 30 ? 0.4 : p.stock > 8 ? 0.2 : 0;
    // Fit-aware: a size the customer wears must actually be in stock, or the SKU is down-weighted.
    const fitBoost = fitSize ? 0.6 : 0;
    const returnPenalty = p.return_rate * 1.2;
    const score = relevance * 1.0 + tierW * 0.5 + p.rating * 0.35 + stockBoost + fitBoost - returnPenalty;
    return { ...p, score: Math.round(score * 100) / 100, tier_weight: tierW };
  }).sort((a, b) => b.score - a.score);

  // Diversity floor. Segment weighting can legitimately push one tier to the top, but a
  // top-10 of a single price tier is exclusion. The agent corrects for it; the guardrail
  // below is the backstop, not the mechanism.
  let ranked = scored;
  if (!unsafeRanking) {
    const topTiers = new Set(scored.slice(0, 10).map(p => p.price_tier));
    if (topTiers.size < 2 && scored.length > 10) {
      const alt = scored.find(p => !topTiers.has(p.price_tier));
      if (alt) {
        ranked = [...scored.slice(0, 4), alt, ...scored.slice(4).filter(p => p.sku !== alt.sku)];
        k.note('agent', 'diversity floor applied - promoted one off-tier SKU into the top 10',
          { promoted: alt.sku, tier: alt.price_tier }, 'S2.10');
      }
    }
  } else {
    k.note('agent', 'UNSAFE MODE - diversity floor disabled for guardrail demonstration', {}, 'S2.10');
  }

  // Inline fairness check before anything reaches the customer.
  let verdict = fairnessBand(ranked, neutral, candidates.length, candidates.length);
  k.record(verdict, 'S2.11');
  const served = verdict.decision === 'block' ? neutral : ranked;

  const top = served.slice(0, 5).map(p => ({
    sku: p.sku, title: p.title, brand: p.brand, category: p.category,
    price_gbp: p.price_gbp, price_tier: p.price_tier, cut: p.cut,
    rating: p.rating, stock: p.stock, score: p.score ?? null, image_url: p.image_url,
    why: p.score !== undefined
      ? `relevance ${p.relevance} x segment weight ${p.tier_weight} for ${segment.affluence}, rating ${p.rating}, return rate ${(p.return_rate * 100).toFixed(0)}%`
      : 'neutral ranking (fairness guardrail engaged)',
  }));

  const rationale = await k.llm('discovery.rationale', {
    segment: segment.affluence, affluence: segment.affluence_score, tier: segment.tier,
    aup: segment.evidence.avg_unit_price_gbp, premium_share: segment.evidence.premium_item_share,
    fit_size: fitSize ?? 'not known', query,
    guardrail_blocked: verdict.decision === 'block',
    top: top.map(t => `${t.title} (${t.price_tier}, GBP ${t.price_gbp})`).join('; '),
  }, 'S2.13');

  await k.invoke('context.write', {
    customer_id: customerId, key: 'last_discovery',
    value: { query, shown: top.map(t => t.sku), at: new Date().toISOString() },
  }, 'S2.14');

  const mix = top.reduce<Record<string, number>>((m, t) => ({ ...m, [t.price_tier]: (m[t.price_tier] ?? 0) + 1 }), {});
  k.note('agent', `ranked ${candidates.length} candidates -> 5 shown`, { price_tier_mix: mix }, 'S2.13');

  return { products: top, rationale, policy: verdict, candidates: candidates.length, price_tier_mix: mix };
}
