import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ProtocolError, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export async function startMcpStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const key = env.COMPDF_API_KEY?.trim();
  if (!key || !env.COMPDF_MCP_URL) throw new Error('COMPDF_MCP_URL and COMPDF_API_KEY are required');
  const url = new URL(env.COMPDF_MCP_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('COMPDF_MCP_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  const remote = new Client({ name: 'compdf-stdio-bridge', version: '1.0.0' });
  await remote.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'x-api-key': key }, redirect: 'error' },
  }));
  const bridge = serveStdio(() => {
    const server = new Server({ name: 'compdf-self-hosted', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async (request, context) => {
      try {
        return await remote.listTools(request.params, { signal: context.mcpReq.signal });
      } catch {
        throw new ProtocolError(-32603, 'The remote MCP service could not list tools');
      }
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      try {
        return await remote.callTool(request.params, { signal: context.mcpReq.signal });
      } catch {
        throw new ProtocolError(-32603, 'The remote MCP service could not complete the tool call');
      }
    });
    return server;
  }, { onerror: () => { process.stderr.write('MCP stdio protocol error\n'); } });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await bridge.close();
    await remote.close();
  };
  process.stdin.once('end', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}

if (require.main === module) {
  void startMcpStdio().catch(() => {
    process.stderr.write('MCP bridge could not start; check URL, API Key and network connectivity\n');
    process.exitCode = 1;
  });
}
