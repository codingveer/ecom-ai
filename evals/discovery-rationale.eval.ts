import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

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

function noInventedProducts({ output, input }: { output: string; input: Case }) {
  const known = new Set(input.top.flatMap(p => [p.title, p.sku]));
  const mentionsUnknownSku = /SKU-\d{5}/g.test(output) && (output.match(/SKU-\d{5}/g) ?? []).some(sku => !known.has(sku));
  return { name: 'no_invented_products', score: mentionsUnknownSku ? 0 : 1 };
}

function respectsGuardrail({ output, input }: { output: string; input: Case }) {
  if (!input.guardrail_blocked) return { name: 'guardrail_language', score: 1 };
  const mentionsNeutral = /neutral|guardrail|blocked/i.test(output);
  return { name: 'guardrail_language', score: mentionsNeutral ? 1 : 0 };
}

Eval('neutail-discovery-rationale', {
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('discovery.rationale', {
    segment: input.segment, affluence: input.affluence, tier: input.tier, aup: input.aup,
    premium_share: input.premium_share, fit_size: input.fit_size, query: input.query,
    guardrail_blocked: input.guardrail_blocked, top: JSON.stringify(input.top),
  }),
  scores: [noInventedProducts, respectsGuardrail, coherenceJudge],
});
