import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';
import { callOpenAI } from '../packages/llm/src/providers.js';

type Case = {
  segment: string; affluence: number; tier: string; aup: number; premium_share: number;
  fit_size: string; query: string; guardrail_blocked: boolean;
  top: Array<{ title: string; sku: string }>;
};

const cases: Case[] = [
  {
    segment: 'affluent', affluence: 0.82, tier: 'gold', aup: 145.5, premium_share: 0.61,
    fit_size: 'M', query: 'occasion dress', guardrail_blocked: false,
    top: [{ title: 'Silk Wrap Midi Dress', sku: 'SKU-00123' }, { title: 'Tailored Blazer Dress', sku: 'SKU-00456' }],
  },
  {
    segment: 'value_seeking', affluence: 0.23, tier: 'bronze', aup: 34.9, premium_share: 0.05,
    fit_size: 'S', query: 'work trousers', guardrail_blocked: false,
    top: [{ title: 'Cotton Blend Chinos', sku: 'SKU-00789' }],
  },
  {
    segment: 'affluent', affluence: 0.82, tier: 'gold', aup: 145.5, premium_share: 0.61,
    fit_size: 'M', query: 'occasion dress', guardrail_blocked: true,
    top: [{ title: 'Cotton Blend Chinos', sku: 'SKU-00789' }],
  },
];

/**
 * "Never invent products" is a semantic constraint, so it is graded semantically: an LLM
 * judge is asked, in the way a human reviewer would be, whether the rationale references
 * any product outside the ones passed in `top`. Three earlier word-overlap heuristics
 * (pooled known-title words, per-title majority overlap, then an absolute 2-shared-word
 * floor) all failed here - any bag-of-words threshold either waves through a short
 * invented name that happens to reuse a generic category word ("Emerald Dress" vs "Silk
 * Wrap Midi Dress"), or, once tightened enough to catch that, flags ordinary prose that
 * refers to a real product in shorthand ("The Chinos offer strong value"). A judge
 * handles paraphrase, shorthand and plurals natively, which is exactly what the
 * threshold could not.
 *
 * Exported so it can be exercised directly against hand-written outputs (both legitimate
 * prose and fabricated invented-product text) without waiting for the real model to
 * happen to emit that phrasing.
 *
 * The raw-SKU check is kept in front of the judge: it is deterministic, free, and a
 * SKU-shaped code outside `top` is unambiguously a violation, so there is no reason to
 * spend a judge call on it.
 *
 * Judge settings were chosen by measurement, not taste: the rubric, model and temperature
 * below were run against 16 hand-written outputs (the legitimate-shorthand prose earlier
 * rounds wrongly flagged, fabricated invented products, and real captured model outputs),
 * three times each. gpt-4o at temperature 0 is the combination that scored all 16
 * correctly with identical verdicts on every repeat; gpt-4o-mini misread "Ruby Cotton
 * Pleated Tapered Chinos" as a reference to "Cotton Blend Chinos", and leaving temperature
 * at the provider default made several verdicts flip between runs on the same input.
 */
export async function noInventedProducts({ output, input }: { output: string; input: Case }) {
  const known = new Set(input.top.flatMap(p => [p.title, p.sku]));
  const mentionsUnknownSku = (output.match(/SKU-\d{5}/g) ?? []).some(sku => !known.has(sku));
  if (mentionsUnknownSku) return { name: 'no_invented_products', score: 0 };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to run evals');
  const knownTitles = input.top.map(p => `- ${p.title} (${p.sku})`).join('\n');
  const judgePrompt =
    `A retail assistant explained why a set of products suits a customer. The ONLY ` +
    `products it is allowed to mention are:\n${knownTitles}\n\n` +
    `Explanation:\n${output}\n\n` +
    `Has the assistant invented a product - that is, does the explanation name a ` +
    `specific product that is none of the allowed ones?\n\n` +
    `Read it the way a shopper would. Referring to an allowed product loosely - by part ` +
    `of its name, in a different word order, in the plural, or as "the dress" / "the ` +
    `option" - is still that product, not an invention. Words quoted from the customer's ` +
    `own search query, and bare category words, are not product names at all. Only count ` +
    `a product as invented if it genuinely cannot be any of the allowed ones, because it ` +
    `carries a colour, material, cut or brand word that no allowed product's name has, ` +
    `or blends words from two different allowed products into a third.\n\n` +
    `Answer with exactly one word: "yes" or "no".`;
  // gpt-4o (not the routing table's class-based pick) and temperature 0 are pinned here
  // deliberately, so a change to the app's model routing can't silently change how this
  // eval grades, and so re-running the eval on unchanged output gives the same score.
  const result = await callOpenAI(
    apiKey, null, 'gpt-4o',
    'You are a careful, literal grader. Answer with exactly one word.',
    judgePrompt, 0,
  );
  const invented = /\byes\b/i.test(result.text.trim());
  return { name: 'no_invented_products', score: invented ? 0 : 1 };
}

function respectsGuardrail({ output, input }: { output: string; input: Case }) {
  if (!input.guardrail_blocked) return { name: 'guardrail_language', score: 1 };
  const mentionsNeutral = /neutral|guardrail|blocked/i.test(output);
  return { name: 'guardrail_language', score: mentionsNeutral ? 1 : 0 };
}

Eval('neutail', {
  experimentName: 'discovery-rationale',
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('discovery.rationale', {
    segment: input.segment, affluence: input.affluence, tier: input.tier, aup: input.aup,
    premium_share: input.premium_share, fit_size: input.fit_size, query: input.query,
    guardrail_blocked: input.guardrail_blocked, top: JSON.stringify(input.top),
  }),
  scores: [noInventedProducts, respectsGuardrail, coherenceJudge],
});
