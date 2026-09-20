/**
 * Agent #5 - Loyalty Accrual & Gamification.
 * M3 Sequence 5. Reads the entitlement written by Sequence 4 (cross-agent memory handoff),
 * calculates Zero-Return Fit Streaks, and governs AI Style Quests.
 */
import type { Kernel } from '../kernel.js';

export async function accrue(k: Kernel, customerId: string, action: string, basePoints: number) {
  const sub = await k.invoke<any>('subscription.get', { customer_id: customerId }, 'S5.4').catch(() => ({ tier: 'free' }));
  const multiplier = sub.tier === 'premium' ? 3 : sub.tier === 'plus' ? 2 : 1;

  k.note('memory', `entitlement read from Sequence 4: ${sub.tier} -> ${multiplier}x subscription multiplier`,
    { source: 'subscription state written by the Upsell Agent' }, 'S5.4');

  const result = await k.invoke<any>('loyalty.accrue',
    { customer_id: customerId, base_points: basePoints, multiplier, reason: action }, 'S5.5');

  const nudge = await k.llm('loyalty.nudge', {
    awarded: result.awarded, multiplier: result.multiplier, entitlement: sub.tier,
    balance: result.balance, tier: result.tier, to_next: result.points_to_next_tier,
  }, 'S5.8');

  await k.invoke('context.write', {
    customer_id: customerId, key: 'engagement',
    value: {
      last_action: action, points_balance: result.balance, tier: result.tier,
      fit_streak: result.fit_streak, fit_streak_multiplier: result.fit_streak_multiplier,
      at: new Date().toISOString(),
    },
  }, 'S5.9');

  k.note('agent', `awarded ${result.awarded} points at ${result.multiplier}x (sub: ${multiplier}x, fit streak: ${result.fit_streak_multiplier}x)`,
    { tier_changed: result.tier_changed, liability_gbp: result.liability_gbp, fit_streak: result.fit_streak }, 'S5.6');

  return { ...result, multiplier: result.multiplier, entitlement: sub.tier, nudge };
}

export async function status(k: Kernel, customerId: string) {
  const sub = await k.invoke<any>('subscription.get', { customer_id: customerId }, 'S5.4').catch(() => ({ tier: 'free' }));
  const subMultiplier = sub.tier === 'premium' ? 3 : sub.tier === 'plus' ? 2 : 1;

  const r = await k.invoke<any>('loyalty.account.get', { customer_id: customerId }, 'S5.3');
  const streakMultiplier = Number(r.fit_streak_multiplier) || 1.0;
  const effectiveMultiplier = Math.round(subMultiplier * streakMultiplier * 10) / 10;

  k.note('memory', `cross-agent handoff read: subscription (${sub.tier} -> ${subMultiplier}x) + fit streak (${r.fit_streak} orders -> ${streakMultiplier}x)`,
    { entitlement: sub.tier, sub_multiplier: subMultiplier, streak_multiplier: streakMultiplier, effective_multiplier: effectiveMultiplier }, 'S5.4');

  k.note('agent', `balance read: ${r.points_balance} points on ${r.tier}, ${r.points_to_next_tier} to next tier, streak: ${r.fit_streak}`, r, 'S5.3');
  return {
    ...r,
    multiplier: effectiveMultiplier,
    subscription_multiplier: subMultiplier,
    fit_streak_multiplier: streakMultiplier,
    entitlement: sub.tier,
  };
}

export async function getQuests(k: Kernel, customerId: string, customerName: string = 'Shopper', tier: string = 'Member') {
  const r = await k.invoke<any>('loyalty.quests.get', { customer_id: customerId }, 'S5.10');
  const quests = r.quests || [];
  const questsSummary = quests.map((q: any) =>
    `- [${q.progress}/${q.target}] ${q.title}: ${q.desc} (+${q.reward_points} NeuPoints${q.badge ? `, Badge: ${q.badge}` : ''})`
  ).join('\n') || 'No active quests at this time.';

  const summary = await k.llm('loyalty.quest.generate', {
    name: customerName,
    tier: r.tier || tier,
    quests_summary: questsSummary,
    badges: (r.badges || []).join(', ') || 'none',
  }, 'S5.11');

  k.note('agent', `retrieved ${quests.length} active style quests`,
    { quests_count: quests.length, badges: r.badges }, 'S5.10');

  return { ...r, summary, formatted_quests: quests };
}

export async function getStreak(k: Kernel, customerId: string, customerName: string = 'Shopper') {
  const r = await k.invoke<any>('loyalty.streak.get', { customer_id: customerId }, 'S5.12');
  const milestoneText = r.next_milestone
    ? `${r.next_milestone.target} orders for ${r.next_milestone.multiplier}x multiplier (${r.next_milestone.badge})`
    : 'Maximum tier achieved';

  const celebration = await k.llm('loyalty.streak.celebrate', {
    name: customerName,
    streak: r.fit_streak,
    multiplier: r.fit_streak_multiplier,
    saved_gbp: r.estimated_reverse_logistics_saved_gbp,
    saved_co2: r.estimated_co2_kg_saved,
    next_milestone: milestoneText,
  }, 'S5.13');

  k.note('agent', `evaluated Zero-Return Fit Streak: ${r.fit_streak} orders at ${r.fit_streak_multiplier}x multiplier`,
    { streak: r.fit_streak, saved_gbp: r.estimated_reverse_logistics_saved_gbp, saved_co2: r.estimated_co2_kg_saved }, 'S5.12');

  return { ...r, celebration };
}

export async function redeem(k: Kernel, customerId: string, points: number) {
  const r = await k.invoke<any>('loyalty.redeem', { customer_id: customerId, points }, 'S5.13');
  k.note('agent', r.redeemed ? `redeemed ${points} points` : `shortfall of ${r.shortfall} points`,
    r, 'S5.14');
  return r;
}
