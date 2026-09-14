/**
 * Policy-as-code - the four guardrails named on slide 9 of the M3 blueprint.
 *
 * Every rule is evaluated INLINE, before a decision reaches the customer, and every
 * evaluation is written to the trace whether it passes or blocks. These are declarative
 * predicates over agent output, kept separate from agent logic so an agent cannot
 * overrule them.
 */
import type { PolicyVerdict } from './kernel.js';

/** Segment-based ranking is allowed; segment-based exclusion is not. */
export const UPSELL_COOLDOWN_DAYS = 7;
export const FIT_CONFIDENCE_THRESHOLD = 70;

export function fairnessBand(
  rankedForSegment: { sku: string; price_tier: string }[],
  neutralRanking: { sku: string; price_tier: string }[],
  candidatePoolSize: number,
  neutralPoolSize: number,
): PolicyVerdict {
  const top = 10;
  const tiers = new Set(rankedForSegment.slice(0, top).map(p => p.price_tier));
  const a = new Set(rankedForSegment.slice(0, top).map(p => p.sku));
  const b = new Set(neutralRanking.slice(0, top).map(p => p.sku));
  const overlap = [...a].filter(s => b.has(s)).length / Math.max(1, Math.min(a.size, b.size));

  // Rule A - no tier exclusion. Segments may be ranked differently; none may be
  // locked out of a price tier entirely.
  if (tiers.size < 2 && rankedForSegment.length > top) {
    return {
      policy: 'fairness_band', decision: 'block',
      detail: `top ${top} collapsed to a single price tier (${[...tiers][0]}) - that is exclusion, not personalisation. Serving neutral ranking, audit event raised.`,
    };
  }
  // Rule B - identical eligibility. Personalisation re-weights the same candidate set;
  // it never removes a SKU from one segment's reachable inventory.
  if (candidatePoolSize !== neutralPoolSize) {
    return {
      policy: 'fairness_band', decision: 'block',
      detail: `candidate pool differs by segment (${candidatePoolSize} vs ${neutralPoolSize}) - eligibility must be segment-independent. Serving neutral ranking, audit event raised.`,
    };
  }
  return {
    policy: 'fairness_band', decision: 'pass',
    detail: `identical ${candidatePoolSize}-SKU eligibility pool, ${tiers.size} price tiers in the top ${top}, ${(overlap * 100).toFixed(0)}% overlap with the neutral ranking - ranking differs, access does not`,
  };
}

export function fitConsent(consent: boolean): PolicyVerdict {
  return consent
    ? { policy: 'fit_data_consent', decision: 'pass', detail: 'explicit opt-in on file; purpose limited to size recommendation' }
    : { policy: 'fit_data_consent', decision: 'block', detail: 'no fit-data opt-in on file - body measurements not read, degrading to size guide' };
}

export function piiMinimisation(profile: any): PolicyVerdict {
  // Nothing that identifies the person is allowed to leave for a model.
  const leaked = ['email', 'name', 'city'].filter(k => JSON.stringify(profile ?? {}).includes(String(profile?.identity?.[k] ?? '\u0000')));
  return leaked.length
    ? { policy: 'pii_minimisation', decision: 'block', detail: `raw identifiers present in model payload: ${leaked.join(', ')}` }
    : { policy: 'pii_minimisation', decision: 'pass', detail: 'segment and derived scores only; raw identifiers stay inside the Customer 360 boundary' };
}

export function upsellFrequencyCap(lastOfferAt: string | null, declined: number): PolicyVerdict {
  if (!lastOfferAt) {
    return { policy: 'upsell_frequency_cap', decision: 'pass', detail: 'no prior offer on record' };
  }
  const days = (Date.now() - new Date(lastOfferAt).getTime()) / 864e5;
  if (days < UPSELL_COOLDOWN_DAYS) {
    return {
      policy: 'upsell_frequency_cap', decision: 'block',
      detail: `last offer ${days.toFixed(1)} days ago, inside the ${UPSELL_COOLDOWN_DAYS}-day cap - suppressed, re-evaluate later`,
    };
  }
  if (declined >= 2) {
    return { policy: 'upsell_frequency_cap', decision: 'block', detail: `${declined} prior declines - suppressed` };
  }
  return { policy: 'upsell_frequency_cap', decision: 'pass', detail: `last offer ${days.toFixed(0)} days ago, outside the cap` };
}
