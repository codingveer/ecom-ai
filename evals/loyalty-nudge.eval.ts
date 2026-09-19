import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = { awarded: number; multiplier: number; entitlement: string; balance: number; tier: string; to_next: number };

const cases: Case[] = [
  { awarded: 65, multiplier: 1, entitlement: 'free', balance: 269, tier: 'Bronze', to_next: 1231 },
  { awarded: 130, multiplier: 2, entitlement: 'plus', balance: 2370, tier: 'Gold', to_next: 2130 },
];

function noExclamationMarks({ output }: { output: string }) {
  return { name: 'no_exclamation_marks', score: output.includes('!') ? 0 : 1 };
}

function atMostTwoSentences({ output }: { output: string }) {
  const sentences = output.split(/(?<=[.?])\s+/).filter(Boolean);
  return { name: 'at_most_two_sentences', score: sentences.length <= 2 ? 1 : 0 };
}

Eval('neutail', {
  experimentName: 'loyalty-nudge',
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('loyalty.nudge', {
    awarded: input.awarded, multiplier: input.multiplier, entitlement: input.entitlement,
    balance: input.balance, tier: input.tier, to_next: input.to_next,
  }),
  scores: [noExclamationMarks, atMostTwoSentences, coherenceJudge],
});
