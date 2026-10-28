import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { MCP_TOOL_NAMES } from './mcp.schemas';

export const MCP_BODY_LIMIT = 6 * 1024 * 1024;

@Injectable()
export class McpSettings {
  readonly enabled: boolean;
  readonly url: string;
  readonly allowedHosts: string[];
  readonly allowedOrigins: string[];
  readonly maxInlineFileBytes: number;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get<boolean>('mcp.enabled') ?? true;
    this.url = config.get<string>('mcp.publicUrl') || `http://localhost:${config.get<number>('port') ?? 8080}/mcp`;
    const parsed = new URL(this.url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.pathname !== '/mcp') {
      throw new Error('MCP_PUBLIC_URL must be an HTTP(S) URL ending in /mcp, without credentials, query or fragment');
    }
    this.allowedHosts = [...new Set(['localhost', '127.0.0.1', '[::1]', parsed.hostname,
      ...(config.get<string[]>('mcp.allowedHosts') ?? [])])];
    this.allowedOrigins = [...new Set([parsed.origin, ...(config.get<string[]>('mcp.allowedOrigins') ?? [])])];
    for (const origin of this.allowedOrigins) {
      const candidate = new URL(origin);
      if (!['http:', 'https:'].includes(candidate.protocol) || candidate.origin !== origin) {
        throw new Error('MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
      }
    }
    const limit = config.get<number>('mcp.maxInlineFileBytes') ?? 4 * 1024 * 1024;
    this.maxInlineFileBytes = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 4 * 1024 * 1024) : 4 * 1024 * 1024;
  }

  acceptsOrigin(request: Pick<Request, 'headers'>): boolean {
    const origin = request.headers.origin;
    return origin === undefined || (typeof origin === 'string' && this.allowedOrigins.includes(origin));
  }

  limits() {
    return {
      maxInlineFileBytes: this.maxInlineFileBytes,
      maxFileBytes: Math.min(this.config.get<number>('batch.maxFileBytes') ?? 100 * 1024 * 1024, 100 * 1024 * 1024),
      maxFiles: this.config.get<number>('batch.maxFiles') ?? 100,
      maxTotalBytes: this.config.get<number>('batch.maxTotalBytes') ?? 1024 * 1024 * 1024,
    };
  }

  clientConfiguration() {
    return {
      enabled: this.enabled,
      url: this.url,
      transport: 'streamable-http',
      authentication: { header: 'x-api-key', credential: 'API Access Key' },
      tools: MCP_TOOL_NAMES,
      limits: this.limits(),
      clients: {
        claudeDesktop: {
          mcpServers: {
            compdf: {
              command: 'node',
              args: ['<ABSOLUTE_PATH>/server/dist/src/mcp/mcp-stdio.js'],
              env: { COMPDF_MCP_URL: this.url, COMPDF_API_KEY: '<API_ACCESS_KEY>' },
            },
          },
        },
        claudeCode: {
          mcpServers: {
            compdf: { type: 'http', url: this.url, headers: { 'x-api-key': '${COMPDF_API_KEY}' } },
          },
        },
        vscode: {
          inputs: [{ id: 'compdfApiKey', type: 'promptString', description: 'ComPDF API Access Key', password: true }],
          servers: { compdf: { type: 'http', url: this.url, headers: { 'x-api-key': '${input:compdfApiKey}' } } },
        },
        codexToml: `[mcp_servers.compdf]\nurl = ${JSON.stringify(this.url)}\nenv_http_headers = { "x-api-key" = "COMPDF_API_KEY" }\n`,
      },
    };
  }
}
