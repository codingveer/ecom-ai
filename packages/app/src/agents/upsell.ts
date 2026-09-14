/**
 * Agent #4 - Service Upsell & Monetisation.
 * M3 Sequence 4. The offer is timed by demonstrated value, and the policy engine -
 * not the agent - decides whether the customer may be asked at all.
 */
import type { Kernel } from '../kernel.js';
import { upsellFrequencyCap } from '../policy.js';

const THRESHOLD_SESSIONS = 3;

export async function evaluate(k: Kernel, customerId: string) {
  const usage = await k.invoke<any>('usage.get', { customer_id: customerId, feature: 'styling_advisory' }, 'S4.5');

  if (usage.entitlement !== 'free') {
    k.note('agent', `already on ${usage.entitlement} - no offer`, {}, 'S4.4');
    return { offer: null, entitlement: usage.entitlement, reason: 'already_subscribed', policy: null, usage };
  }
  if (usage.sessions < THRESHOLD_SESSIONS) {
    k.note('agent', `usage threshold not met (${usage.sessions}/${THRESHOLD_SESSIONS})`, {}, 'S4.4');
    return { offer: null, entitlement: 'free', reason: 'threshold_not_met', policy: null, usage };
  }

  // The cap is evaluated before the offer is composed, and the agent cannot overrule it.
  const verdict = k.record(upsellFrequencyCap(usage.last_offer_at, usage.offers_declined), 'S4.9');
  if (verdict.decision === 'block') {
    return { offer: null, entitlement: 'free', reason: 'suppressed_by_policy', policy: verdict, usage };
  }

  const copy = await k.llm('upsell.copy', {
    feature: 'Styling Advisory', sessions: usage.sessions,
    signals: (usage.value_signals ?? []).join(', ') || 'repeat use',
    tier: 'Plus', price: '4.99', benefits: 'AI styling, AR try-on and 2x loyalty accrual',
  }, 'S4.11');

  await k.invoke('usage.offer.record', { customer_id: customerId }, 'S4.9');

  k.note('agent', 'offer composed at moment of demonstrated value',
    { sessions: usage.sessions, value_signals: usage.value_signals }, 'S4.11');

  return {
    offer: { tier: 'plus', price_gbp_month: 4.99, copy,
             benefits: ['AI styling advisory', 'AR try-on', '2x loyalty accrual'] },
    entitlement: 'free', reason: 'offered', policy: verdict, usage,
  };
}

/** Accept the offer. Writes the entitlement that Sequence 5 then reads for the 2x multiplier. */
export async function accept(k: Kernel, customerId: string, tier = 'plus') {
  const sub = await k.invoke<any>('subscription.upgrade', { customer_id: customerId, tier }, 'S4.13');
  await k.invoke('context.write', {
    customer_id: customerId, key: 'entitlement',
    value: { tier: sub.tier, since: new Date().toISOString() },
  }, 'S4.14');
  k.note('agent', `entitlement = ${sub.tier} written to shared context`,
    { note: 'Sequence 5 reads this for the accrual multiplier' }, 'S4.14');
  return sub;
}
