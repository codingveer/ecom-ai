/**
 * Agent #5 - Loyalty Accrual & Gamification.
 * M3 Sequence 5. Reads the entitlement written by Sequence 4 - this is the
 * cross-agent memory handoff, demonstrated rather than claimed.
 */
import type { Kernel } from '../kernel.js';

export async function accrue(k: Kernel, customerId: string, action: string, basePoints: number) {
  const sub = await k.invoke<any>('subscription.get', { customer_id: customerId }, 'S5.4');
  const multiplier = sub.tier === 'premium' ? 3 : sub.tier === 'plus' ? 2 : 1;

  k.note('memory', `entitlement read from Sequence 4: ${sub.tier} -> ${multiplier}x multiplier`,
    { source: 'subscription state written by the Upsell Agent' }, 'S5.4');

  const result = await k.invoke<any>('loyalty.accrue',
    { customer_id: customerId, base_points: basePoints, multiplier, reason: action }, 'S5.5');

  const nudge = await k.llm('loyalty.nudge', {
    awarded: result.awarded, multiplier, entitlement: sub.tier,
    balance: result.balance, tier: result.tier, to_next: result.points_to_next_tier,
  }, 'S5.8');

  await k.invoke('context.write', {
    customer_id: customerId, key: 'engagement',
    value: { last_action: action, points_balance: result.balance, tier: result.tier, at: new Date().toISOString() },
  }, 'S5.9');

  k.note('agent', `awarded ${result.awarded} points at ${multiplier}x`,
    { tier_changed: result.tier_changed, liability_gbp: result.liability_gbp }, 'S5.6');

  return { ...result, multiplier, entitlement: sub.tier, nudge };
}

export async function status(k: Kernel, customerId: string) {
  const r = await k.invoke<any>('loyalty.account.get', { customer_id: customerId }, 'S5.3');
  k.note('agent', `balance read: ${r.points_balance} points on ${r.tier}, ${r.points_to_next_tier} to next tier`, r, 'S5.3');
  return r;
}

export async function redeem(k: Kernel, customerId: string, points: number) {
  const r = await k.invoke<any>('loyalty.redeem', { customer_id: customerId, points }, 'S5.13');
  k.note('agent', r.redeemed ? `redeemed ${points} points` : `shortfall of ${r.shortfall} points`,
    r, 'S5.14');
  return r;
}
