import type { UIMessage } from 'ai';
import type { TraceStep } from '../../app/src/kernel';

export type TurnTrace = {
  intent: string;
  intent_confidence: number;
  agent: string;
  payload: unknown;
  trace: TraceStep[];
  memory: { within_session: { turns: unknown[]; working: unknown }; across_sessions: Record<string, unknown> };
};

export type ChatMessage = UIMessage<unknown, { trace: TurnTrace }>;
