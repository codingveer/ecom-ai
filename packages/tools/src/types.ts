export type ToolContract = {
  name: string; version: string; purpose: string;
  allowed_agents: string[];
  input_schema: Record<string, { type: string; required?: boolean; default?: unknown; description?: string }>;
  output_schema: Record<string, string>;
  transport: { service: string; method: 'GET' | 'POST'; path: string };
};
