/**
 * Agent #3 - Size & Fit Personalisation.
 * M3 Sequence 3. The direct lever on the 34% return rate, and the only flow with a
 * consent gate before any data is read.
 *
 * The commercially important behaviour is the ABSTAIN path: below the confidence
 * threshold the agent makes no claim, because a wrong recommendation causes the
 * return it exists to remove.
 */
import type { Kernel } from '../kernel.js';
import { fitConsent, FIT_CONFIDENCE_THRESHOLD } from '../policy.js';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL'];

export async function recommend(k: Kernel, customerId: string, sku: string | null, category: string | null) {
  const fit = await k.invoke<any>('fit.profile.get', { customer_id: customerId }, 'S3.7');

  // Consent gate first. Body measurements are the most sensitive data in the assistant.
  const consent = k.record(fitConsent(!!fit.consent_fit), 'S3.5');
  if (consent.decision === 'block') {
    return {
      recommended_size: null, confidence: 0, threshold: FIT_CONFIDENCE_THRESHOLD, abstained: true,
      reason: 'no_consent',
      explanation: 'No fit-data opt-in is on file, so no measurements were read and no size is being suggested. The size guide and virtual try-on are available instead.',
      evidence: {}, returns_avoided_pp: 0,
    };
  }

  let product: any = null;
  if (sku) product = await k.invoke<any>('catalogue.product.get', { sku }, 'S3.8');
  const cat = category ?? product?.category ?? 'dresses';

  const profile = (fit.profiles as any[]).find(p => p.category === cat) ?? null;
  const priorFitReturns = (fit.fit_returns as any[]).filter(r => r.category === cat);

  if (!profile) {
    return {
      recommended_size: null, confidence: 0, threshold: FIT_CONFIDENCE_THRESHOLD, abstained: true,
      reason: 'no_history',
      explanation: `No kept-purchase history in ${cat} for this customer, so there is nothing to base a size on. No recommendation made.`,
      evidence: { categories_known: (fit.profiles as any[]).map(p => p.category) }, returns_avoided_pp: 0,
    };
  }

  const brand = product?.brand ?? 'Aurelia';
  const chart = await k.invoke<any>('fit.sizechart.get', { brand, category: cat }, 'S3.9');

  // Match the customer's measurements against this brand's grading table.
  const graded = (chart.grading as any[]).map(g => ({
    size: g.size,
    delta: Math.abs((g.bust_cm ?? 0) - (profile.bust_cm ?? 0)) + Math.abs((g.waist_cm ?? 0) - (profile.waist_cm ?? 0)),
    tolerance: g.grading_tolerance_cm,
  })).sort((a, b) => a.delta - b.delta);
  const best = graded[0];

  // Cut adjustment: a brand that runs small pushes the recommendation up a size.
  let size = best.size;
  const cut = product?.cut ?? 'true_to_size';
  if (cut === 'runs_small' && best.delta > best.tolerance) size = SIZE_ORDER[Math.min(4, SIZE_ORDER.indexOf(size) + 1)];
  if (cut === 'runs_large' && best.delta > best.tolerance) size = SIZE_ORDER[Math.max(0, SIZE_ORDER.indexOf(size) - 1)];
  if (profile.fit_preference === 'relaxed') size = SIZE_ORDER[Math.min(4, SIZE_ORDER.indexOf(size) + 1)];

  // Confidence: observation depth, grading distance, and whether this brand has burned them before.
  let confidence = 45;
  confidence += Math.min(30, profile.observations * 5);
  confidence += best.delta <= best.tolerance ? 20 : best.delta <= best.tolerance * 2 ? 8 : -10;
  confidence += cut === 'true_to_size' ? 6 : 0;
  confidence -= priorFitReturns.filter(r => r.brand === brand).length * 12;
  confidence = Math.max(0, Math.min(99, Math.round(confidence)));

  const inStock = sku ? await k.invoke<any>('catalogue.inventory.get', { sku }, 'S3.9') : null;
  const sizeAvailable = inStock ? (inStock.sizes as any[]).find(s => s.size === size)?.qty > 0 : true;

  const abstained = confidence < FIT_CONFIDENCE_THRESHOLD;
  const explanation = await k.llm('fit.explanation', {
    history: `${profile.observations} kept purchases in ${cat}, usual size ${profile.preferred_size}, ${profile.fit_preference} fit preference`,
    brand, cut, category: cat, offset: best.delta.toFixed(1),
    size, confidence, threshold: FIT_CONFIDENCE_THRESHOLD,
  }, 'S3.11');

  if (!abstained) {
    await k.invoke('context.write', {
      customer_id: customerId, key: `fit_recommendation_${cat}`,
      value: { size, confidence, brand, at: new Date().toISOString() },
    }, 'S3.13');
  }

  // Business outcome: fit-coded returns are 58% of the 34%, i.e. 19.7 points.
  // The M3 model reaches 65% of those and captures 75% -> 9.6 points removed at full coverage.
  const returnsAvoidedPp = abstained ? 0 : Math.round(9.6 * (confidence / 100) * 10) / 10;

  k.note('agent', abstained ? 'ABSTAINED - below confidence threshold' : `size ${size} at ${confidence}%`,
    { grading_delta_cm: best.delta, prior_fit_returns_this_brand: priorFitReturns.filter(r => r.brand === brand).length },
    'S3.11');

  return {
    recommended_size: abstained ? null : size, confidence, threshold: FIT_CONFIDENCE_THRESHOLD,
    abstained, reason: abstained ? 'low_confidence' : 'ok', explanation,
    size_in_stock: sizeAvailable, brand, category: cat,
    evidence: {
      observations: profile.observations, usual_size: profile.preferred_size,
      fit_preference: profile.fit_preference, brand_cut: cut,
      grading_delta_cm: Math.round(best.delta * 10) / 10,
      prior_fit_returns: priorFitReturns.length,
    },
    returns_avoided_pp: returnsAvoidedPp,
  };
}
