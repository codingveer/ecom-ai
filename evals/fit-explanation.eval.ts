import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';
import { coherenceJudge } from './lib/judge.js';

type Case = {
  history: string; brand: string; cut: string; category: string; offset: number;
  size: string; confidence: number; threshold: number;
};

const cases: Case[] = [
  { history: '3 orders, true to size', brand: 'Acme', cut: 'regular', category: 'dresses', offset: 0.2, size: 'M', confidence: 88, threshold: 70 },
  { history: 'no fit history', brand: 'Acme', cut: 'runs_small', category: 'knitwear', offset: 1.9, size: 'L', confidence: 42, threshold: 70 },
  { history: '1 order, unclear fit', brand: 'Bexley', cut: 'runs_small', category: 'trousers', offset: 1.4, size: 'S', confidence: 55, threshold: 70 },
];

function respectsThreshold({ output, input }: { output: string; input: Case }) {
  if (input.confidence >= input.threshold) return { name: 'threshold_respected', score: 1 };
  const mentionsSize = new RegExp(`\\b${input.size}\\b`).test(output) || /recommend(ed)? size/i.test(output);
  return { name: 'threshold_respected', score: mentionsSize ? 0 : 1 };
}

Eval('neutail-fit-explanation', {
  data: () => cases.map(c => ({ input: c })),
  task: async (input: Case) => runPrompt('fit.explanation', {
    history: input.history, brand: input.brand, cut: input.cut, category: input.category,
    offset: input.offset, size: input.size, confidence: input.confidence, threshold: input.threshold,
  }),
  scores: [respectsThreshold, coherenceJudge],
});
