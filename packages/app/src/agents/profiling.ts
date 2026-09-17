/**
 * Agent #1 - Customer Profiling & Segmentation.
 * M3 Sequence 1. Resolves identity, pulls features, classifies segment, writes to shared context.
 *
 * Note the imports: no db, no http client, no urls. Only the kernel.
 */
import type { Kernel } from '../kernel.js';
import { piiMinimisation } from '../policy.js';

export type Segment = {
  affluence: 'affluent' | 'mid' | 'value_seeking';
  affluence_score: number;
  loyalty_status: 'new' | 'developing' | 'loyal';
  tier: string;
  /** Declared catalogue department - navigation, not a protected attribute. 'unisex' = no filter. */
  shops_for: 'women' | 'men' | 'unisex';
  evidence: Record<string, number | string>;
};

export async function classify(k: Kernel, customerId: string) {
  const profile = await k.invoke<any>('customer.profile.get', { customer_id: customerId }, 'S1.7');
  const events = await k.invoke<any[]>('customer.events.get', { customer_id: customerId, limit: 40 }, 'S1.9');

  const tx = profile.transactions;
  // Affluence score: three weighted observable signals, no protected attribute anywhere.
  const aupScore = Math.min(1, tx.avg_unit_price_gbp / 120);
  const premiumScore = Math.min(1, tx.premium_item_share / 0.6);
  const spendScore = Math.min(1, profile.declared.annual_spend_gbp / 3500);
  const affluenceScore = Math.round((0.4 * aupScore + 0.35 * premiumScore + 0.25 * spendScore) * 100) / 100;
  const affluence = affluenceScore >= 0.62 ? 'affluent' : affluenceScore >= 0.32 ? 'mid' : 'value_seeking';

  const tenureDays = profile.identity.tenure_days;
  const loyalty_status = tx.orders >= 8 && tenureDays > 270 ? 'loyal' : tx.orders >= 3 ? 'developing' : 'new';

  const segment: Segment = {
    affluence, affluence_score: affluenceScore, loyalty_status,
    tier: profile.loyalty?.tier ?? 'Bronze',
    shops_for: profile.identity.shops_for ?? 'unisex',
    evidence: {
      avg_unit_price_gbp: tx.avg_unit_price_gbp,
      premium_item_share: tx.premium_item_share,
      annual_spend_gbp: profile.declared.annual_spend_gbp,
      orders: tx.orders, tenure_days: tenureDays,
      recent_events: events.length,
      return_rate: profile.returns.rate,
    },
  };

  // Inline guardrail: nothing identifying may travel onward to a model.
  k.record(piiMinimisation({ segment }), 'S1.11');

  // Long-term memory write-back: every other agent reads this, this session and the next.
  await k.invoke('context.write', { customer_id: customerId, key: 'segment', value: segment }, 'S1.13');

  k.note('agent', `segment = ${affluence} / ${loyalty_status}`, segment.evidence, 'S1.14');
  return { segment, profile };
}
