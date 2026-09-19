import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = { feature: string; sessions: number; signals: string; tier: string; price: number; benefits: string };

const cases: Case[] = [
  { feature: 'Styling Advisory', sessions: 3, signals: 'used 3x in 14 days', tier: 'Plus', price: 9.99, benefits: '2x loyalty accrual, priority styling' },
  { feature: 'Styling Advisory', sessions: 5, signals: 'used weekly for a month', tier: 'Premium', price: 19.99, benefits: 'unlimited styling sessions, early access' },
];

function noExclamationMarks({ output }: { output: string }) {
  return { name: 'no_exclamation_marks', score: output.includes('!') ? 0 : 1 };
}

function atMostTwoSentences({ output }: { output: string }) {
  const sentences = output.split(/(?<=[.?])\s+/).filter(Boolean);
  return { name: 'at_most_two_sentences', score: sentences.length <= 2 ? 1 : 0 };
}

Eval('neutail', {
  experimentName: 'upsell-copy',
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('upsell.copy', {
    feature: input.feature, sessions: input.sessions, signals: input.signals,
    tier: input.tier, price: input.price, benefits: input.benefits,
  }),
  scores: [noExclamationMarks, atMostTwoSentences, coherenceJudge],
});
