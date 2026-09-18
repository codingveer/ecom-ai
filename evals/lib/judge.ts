import { LLMClassifierFromTemplate } from 'autoevals';
import type { EvalScorer } from 'braintrust';

/**
 * Optional, shared across all five eval files: a coherence check independent of any
 * prompt-specific correctness scorer. Easy to drop from an eval file's `scores` array
 * if the extra OpenAI spend per run isn't wanted.
 *
 * Cast to `EvalScorer<any, string, any, any>`: autoevals types an `LLMClassifierFromTemplate`
 * scorer's `expected` field as `string | undefined`, but each eval file's `Expected` case
 * shape differs (e.g. `{ expectedIntent: string }` in intent-classify.eval.ts) - a
 * structural TS mismatch only, since this judge never reads `expected` at all.
 */
export const coherenceJudge = LLMClassifierFromTemplate({
  name: 'coherence',
  promptTemplate:
    'You are grading whether a retail assistant\'s reply is coherent, on-topic, and ' +
    'appropriately toned. Reply text:\n\n{{output}}\n\nIs this reply coherent and ' +
    'appropriate?',
  choiceScores: { yes: 1, no: 0 },
}) as unknown as EvalScorer<any, string, any, any>;
