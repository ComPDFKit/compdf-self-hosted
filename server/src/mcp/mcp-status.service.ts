import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ApiKeyService } from '../auth/api-key.service';
import { MCP_TOOL_NAMES } from './mcp.schemas';
import { McpSettings } from './mcp.settings';

export interface McpServiceStatus {
  status: 'running' | 'not_enabled' | 'error';
  checkedAt: string;
}

@Injectable()
export class McpStatusService {
  constructor(
    private readonly settings: McpSettings,
    private readonly apiKeys: ApiKeyService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<McpServiceStatus> {
    if (!this.settings.enabled) return this.result('not_enabled');
    const key = this.apiKeys.getPlaintextKey();
    if (!key) return this.result('error');

    const client = new Client({ name: 'compdf-dashboard-status', version: '1.0.0' });
    const signal = AbortSignal.timeout(5_000);
    // Probe this Server only. Never send the deployment key to a configured
    // public URL or an incoming Host header, and never follow a redirect.
    const url = new URL(`http://127.0.0.1:${this.config.get<number>('port') ?? 8080}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { 'x-api-key': key }, redirect: 'error', signal },
    });
    try {
      await client.connect(transport, { signal, timeout: 5_000 });
      const { tools } = await client.listTools(undefined, { signal, timeout: 5_000 });
      const names = new Set(tools.map((tool) => tool.name));
      return this.result(MCP_TOOL_NAMES.every((name) => names.has(name)) ? 'running' : 'error');
    } catch {
      return this.result('error');
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private result(status: McpServiceStatus['status']): McpServiceStatus {
    return { status, checkedAt: new Date().toISOString() };
  }
}
