#!/usr/bin/env node
/**
 * Neu.Tail Stdio MCP Server for Claude Desktop, Cursor, and local MCP clients.
 *
 * Runs over standard input/output (stdio) and delegates tool invocations to the
 * running Neu.Tail tools worker (http://localhost:8102).
 */
import { z, type ZodTypeAny } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BUNDLED } from '../packages/tools/src/bundled.js';
import type { ToolContract } from '../packages/tools/src/types.js';

const TOOLS_URL = process.env.NEUTAIL_TOOLS_URL || 'http://localhost:8102';

function contractToZodShape(inputSchema: ToolContract['input_schema']): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, spec] of Object.entries(inputSchema)) {
    let field: ZodTypeAny;

    if (spec.type === 'integer') {
      field = z.coerce.number().int();
    } else if (spec.type === 'number') {
      field = z.coerce.number();
    } else if (spec.type === 'boolean') {
      field = z.coerce.boolean();
    } else {
      field = z.string();
    }

    if (spec.description) {
      field = field.describe(spec.description);
    }

    if (!spec.required) {
      if (spec.default !== undefined) {
        field = field.default(spec.default);
      } else {
        field = field.optional();
      }
    }

    shape[key] = field;
  }

  return shape;
}

const server = new McpServer({
  name: 'neutail-local-bridge',
  version: '1.0.0',
});

for (const contract of BUNDLED) {
  const shape = contractToZodShape(contract.input_schema);
  const callingAgent = contract.allowed_agents[0] || 'orchestrator';

  server.tool(
    contract.name,
    contract.purpose || `Tool ${contract.name}`,
    shape,
    async (args: Record<string, unknown>) => {
      try {
        const res = await fetch(`${TOOLS_URL}/invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: callingAgent,
            tool: contract.name,
            args,
          }),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(errBody, null, 2),
              },
            ],
          };
        }

        const data = await res.json();
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error connecting to Neu.Tail tools worker at ${TOOLS_URL}: ${String(err)}.\nMake sure 'npm run dev' or 'npm run dev:tools' is running.`,
            },
          ],
        };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Fatal error in MCP server:', err);
  process.exit(1);
});
