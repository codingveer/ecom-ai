import { PROMPTS, type Prompt } from '../../packages/llm/src/prompts.js';
import { render, ROUTING, callOpenAI } from '../../packages/llm/src/providers.js';

const prompts = new Map(PROMPTS.map(p => [p.id, p]));

/**
 * Calls the exact rendering and HTTP-calling code packages/llm's Worker uses in
 * production, against real OpenAI - so a prompt-quality regression shows up here
 * before it reaches the demo.
 */
export async function runPrompt(promptId: string, variables: Record<string, unknown>): Promise<string> {
  const prompt = prompts.get(promptId) as Prompt | undefined;
  if (!prompt) throw new Error(`unknown prompt: ${promptId}`);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to run evals (mock output cannot be meaningfully scored)');
  const model = ROUTING.openai[prompt.model_class];
  const user = render(prompt.template, variables);
  const out = await callOpenAI(apiKey, null, model, prompt.system, user);
  return out.text;
}
