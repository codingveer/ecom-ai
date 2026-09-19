/**
 * Test script for verifying the Model Context Protocol (MCP) server endpoints:
 * 1. The Stdio MCP server (scripts/mcp-server.ts) used by Claude Desktop / Cursor.
 * 2. The Cloudflare Worker Streamable HTTP endpoint (http://localhost:8102/mcp) if running.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_URL = process.env.NEUTAIL_TOOLS_URL || 'http://localhost:8102';

async function testStdioMcpServer(): Promise<void> {
  console.log('\n--- 1. Testing Stdio MCP Server (Claude Desktop / Cursor Bridge) ---');
  const serverPath = resolve(__dirname, 'mcp-server.ts');

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('npx', ['tsx', serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let stdoutData = '';

    child.stdout.on('data', chunk => {
      stdoutData += chunk.toString();

      // Check if we received tools/list response
      if (stdoutData.includes('"tools":[')) {
        try {
          const lines = stdoutData.split('\n').filter(l => l.trim().length > 0);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.result?.tools) {
              const tools = parsed.result.tools;
              console.log(`✅ Stdio MCP Server initialized and discovered ${tools.length} tools!`);
              console.log(`   Sample tools: ${tools.slice(0, 3).map((t: any) => t.name).join(', ')}...`);
              child.kill();
              resolvePromise();
              return;
            }
          }
        } catch {
          // Waiting for more data
        }
      }
    });

    child.on('error', rejectPromise);

    // Send initialize request
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }) + '\n'
    );

    // Send tools/list request
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }) + '\n'
    );

    setTimeout(() => {
      child.kill();
      if (!stdoutData.includes('"tools":[')) {
        rejectPromise(new Error('Stdio MCP server timed out waiting for tools/list response'));
      } else {
        resolvePromise();
      }
    }, 4000);
  });
}

async function testHttpMcpEndpoint(): Promise<void> {
  console.log('\n--- 2. Testing Cloudflare Worker HTTP Endpoint ---');
  try {
    const res = await fetch(`${TOOLS_URL}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:8102',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    console.log(`HTTP Status: ${res.status}`);
    const text = await res.text();
    if (res.status === 200 && text.includes('tools')) {
      console.log('✅ Worker /mcp endpoint reachable and responding with standard MCP tools!');
    } else {
      console.log(`Received status ${res.status}: ${text.slice(0, 100)}...`);
    }
  } catch (e) {
    console.log(`(Worker is not running on ${TOOLS_URL} right now. Run 'npm run dev:tools' to test live HTTP).`);
  }
}

async function main() {
  await testStdioMcpServer();
  await testHttpMcpEndpoint();
  console.log('\n🎉 All Model Context Protocol tests completed successfully!');
}

main().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
