import { z, type ZodTypeAny } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import type { ToolContract } from './types.js';
import type { Env } from './index.js';
import { executeTool, loadRegistry } from './index.js';

/**
 * Converts a Neu.Tail ToolContract input_schema into a Zod shape compatible
 * with the Model Context Protocol SDK.
 */
export function contractToZodShape(inputSchema: ToolContract['input_schema']): Record<string, ZodTypeAny> {
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

/**
 * Builds an McpServer instance populated with all registered tool contracts.
 */
export function buildMcpServer(env: Env, contracts: ToolContract[]): McpServer {
  const server = new McpServer({
    name: 'neutail-tools',
    version: '1.0.0',
  });

  for (const contract of contracts) {
    const shape = contractToZodShape(contract.input_schema);

    server.registerTool(
      contract.name,
      {
        description: contract.purpose || `Tool ${contract.name}`,
        inputSchema: shape,
      },
      async (args: any) => {
        const result = await executeTool(env, contract.name, 'mcp', args, { skipAgentCheck: true });

        if (!result.ok) {
          const errMsg = result.detail || (result.errors ? result.errors.join('; ') : result.error);
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: result.error, detail: errMsg }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2),
            },
          ],
        };
      }
    );
  }

  return server;
}

/**
 * Creates the Cloudflare Worker MCP HTTP handler.
 */
export function createToolsMcpHandler(env: Env) {
  return createMcpHandler(
    async () => {
      const reg = await loadRegistry(env);
      return buildMcpServer(env, [...reg.values()]);
    },
    {
      route: '/mcp',
      allowedOriginHostnames: '*',
      corsOptions: {
        origin: '*',
        methods: 'GET, POST, OPTIONS',
        headers: 'Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      },
    }
  );
}
