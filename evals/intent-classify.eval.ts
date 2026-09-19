import { Eval } from 'braintrust';
import { runPrompt } from './lib/harness.js';

// coherenceJudge (evals/lib/judge.ts) is intentionally omitted here: intent.classify's
// system prompt demands raw JSON only ("no prose, no markdown fences"), but the judge's
// rubric asks whether a "reply" is coherent, on-topic, and appropriately toned - a rubric
// written for prose. Scoring JSON against it isn't a meaningful signal for this prompt
// specifically; the other eval files' prose-output prompts should keep it.

type Case = { utterance: string; history: string; expectedIntent: string };

const cases: Case[] = [
  { utterance: 'show me an occasion dress', history: 'none', expectedIntent: 'discovery.rank' },
  { utterance: 'what size should I get?', history: 'none', expectedIntent: 'fit.check' },
  { utterance: 'tell me about the styling advisory plan', history: 'none', expectedIntent: 'upsell.moment' },
  { utterance: 'how many points did I earn?', history: 'none', expectedIntent: 'loyalty.event' },
  { utterance: 'who am I shopping as today?', history: 'none', expectedIntent: 'profile.refresh' },
  { utterance: 'what about the coat', history: 'fit.check: "will this dress fit true to size"', expectedIntent: 'fit.check' },
];

function parsesAsJson({ output }: { output: string }) {
  try {
    JSON.parse(output.replace(/```json|```/g, '').trim());
    return { name: 'valid_json', score: 1 };
  } catch {
    return { name: 'valid_json', score: 0 };
  }
}

function intentMatches({ output, expected }: { output: string; expected: { expectedIntent: string } }) {
  try {
    const parsed = JSON.parse(output.replace(/```json|```/g, '').trim());
    return { name: 'intent_correct', score: parsed.intent === expected.expectedIntent ? 1 : 0 };
  } catch {
    return { name: 'intent_correct', score: 0 };
  }
}

Eval('neutail', {
  experimentName: 'intent-classify',
  data: () => cases.map(c => ({
    input: { utterance: c.utterance, history: c.history },
    expected: { expectedIntent: c.expectedIntent },
  })),
  task: async (input: { utterance: string; history: string }) =>
    runPrompt('intent.classify', { utterance: input.utterance, history: input.history }),
  scores: [parsesAsJson, intentMatches],
});
