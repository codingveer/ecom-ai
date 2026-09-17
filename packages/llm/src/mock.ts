/**
 * Deterministic offline provider.
 *
 * Same interface as the real providers, so the orchestrator cannot tell them apart.
 * Exists for two reasons: the demo must not depend on a network, and a judge asking
 * "run it again" must see the same output.
 */
const est = (s: string) => Math.ceil(s.length / 4);

const INTENT_RULES: Array<[RegExp, string]> = [
  [/\b(size|fit|sizing|measure|measurement|true to size|will (this|it) fit|what size)\b/i, 'fit.check'],
  [/\b(points?|reward|redeem|tier|gold|silver|badge|referral|loyalty)\b/i, 'loyalty.event'],
  [/\b(upgrade|subscription|subscribe|plus|premium plan|plan|styling advisory|stylist)\b/i, 'upsell.moment'],
  [/\b(who am i|my (account|profile|segment)|log ?in|sign ?in|my details)\b/i, 'profile.refresh'],
  [/\b(show|find|looking for|need|want|search|browse|recommend|suggest|dress|coat|jumper|trousers|shirt|skirt|shoes)\b/i, 'discovery.rank'],
];

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\bdress(es)?\b/i, 'dresses'], [/\b(coat|jacket|outerwear)\b/i, 'outerwear'],
  [/\b(jumper|knit|sweater|cardigan)\b/i, 'knitwear'], [/\b(trouser|chino|jean)/i, 'trousers'],
  [/\b(top|shirt|blouse|tee)\b/i, 'tops'], [/\bskirt/i, 'skirts'],
  [/\b(shoe|boot|trainer|heel)/i, 'footwear'], [/\b(bag|scarf|belt|accessor)/i, 'accessories'],
];

export function mockComplete(promptId: string, vars: Record<string, any>, system: string, user: string) {
  const input_tokens = est(system + user);
  let text = '';

  switch (promptId) {
    case 'intent.classify': {
      const utterance = String(vars.utterance ?? '');
      const history = String(vars.history ?? '');
      let intent = 'discovery.rank';
      let confidence = 0.62;
      for (const [re, i] of INTENT_RULES) {
        if (re.test(utterance)) { intent = i; confidence = 0.93; break; }
      }
      // Multi-turn: a bare follow-up inherits the previous intent's subject.
      if (/^(what about|and|how about|in |the )/i.test(utterance.trim()) && history.includes('fit.check')) {
        intent = 'fit.check'; confidence = 0.88;
      }
      let category: string | null = null;
      for (const [re, c] of CATEGORY_RULES) if (re.test(utterance)) { category = c; break; }
      if (!category && history) for (const [re, c] of CATEGORY_RULES) if (re.test(history)) { category = c; break; }
      text = JSON.stringify({
        intent, confidence,
        entities: { category, sku: (utterance.match(/SKU-\d{5}/) ?? [null])[0] },
        rationale: `matched ${intent} on lexical signal in the utterance${category ? ` with category ${category}` : ''}`,
      });
      break;
    }
    case 'discovery.rationale': {
      const seg = String(vars.segment ?? 'unknown');
      const premium = Number(vars.premium_share ?? 0);
      const blocked = vars.guardrail_blocked === true || vars.guardrail_blocked === 'true';
      text = blocked
        ? `Personalised ranking was blocked by the fairness guardrail because it would have excluded a price tier, so a neutral ranking - by relevance and rating only, the same for every segment - is shown instead.`
        : seg === 'affluent'
        ? `Ranked premium and core ranges first because ${Math.round(premium * 100)}% of past purchases were premium-tier at an average unit price of GBP ${vars.aup}, and ${vars.tier} tier signals sustained spend.`
        : `Surfaced value and private-label ranges first because past purchases average GBP ${vars.aup} per item with a ${Math.round(premium * 100)}% premium share, so higher price points would rank items this customer does not buy.`;
      break;
    }
    case 'fit.explanation': {
      const conf = Number(vars.confidence ?? 0);
      const threshold = Number(vars.threshold ?? 70);
      text = conf >= threshold
        ? `Size ${vars.size} in ${vars.brand}, based on ${vars.history} and a ${vars.offset}σ match against this category's real height/weight band. This brand ${String(vars.cut).replace(/_/g, ' ')}, which is already accounted for.`
        : `Not enough fit history to recommend a size here with confidence, so no size is being suggested. The size guide and virtual try-on are the safer route for this purchase.`;
      break;
    }
    case 'upsell.copy':
      text = `You have used ${vars.feature} across ${vars.sessions} sessions and saved work from it, so ${vars.tier} at GBP ${vars.price} a month would give you ${vars.benefits} on what you are already doing.`;
      break;
    case 'loyalty.nudge':
      text = `${vars.awarded} points added at ${vars.multiplier}x on your ${vars.entitlement} entitlement, taking you to ${vars.balance} and leaving ${vars.to_next} to the next tier.`;
      break;
    default:
      text = `[mock] no canned response registered for prompt '${promptId}'.`;
  }

  return { text, input_tokens, output_tokens: est(text) };
}
