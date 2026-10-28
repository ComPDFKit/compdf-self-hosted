import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { McpSettings } from './mcp.settings';
import { decodeFile } from './mcp.tools';
import { configureMcpHttp } from './mcp.http';
import { startMcpStdio } from './mcp-stdio';

describe('MCP settings and file boundaries', () => {
  it('uses local defaults and configured batch limits', () => {
    const settings = new McpSettings(new ConfigService({ batch: { maxFiles: 20 } }));
    expect(settings.enabled).toBe(true);
    expect(settings.url).toBe('http://localhost:8080/mcp');
    expect(settings.limits().maxFiles).toBe(20);
  });
  it('adds the public hostname and explicit proxy hosts without trusting inbound headers', () => {
    const settings = new McpSettings(new ConfigService({ mcp: { publicUrl: 'https://pdf.example.com/mcp', allowedHosts: ['compdf-server'], allowedOrigins: ['https://admin.example.com'], maxInlineFileBytes: 50 * 1024 * 1024 } }));
    expect(settings.allowedHosts).toContain('pdf.example.com');
    expect(settings.allowedHosts).toContain('compdf-server');
    expect(settings.allowedOrigins).toContain('https://admin.example.com');
    expect(settings.maxInlineFileBytes).toBe(4194304);
    expect(settings.clientConfiguration().clients.codexToml).toContain('https://pdf.example.com/mcp');
    expect(settings.clientConfiguration().clients.claudeCode).toEqual({
      mcpServers: {
        compdf: { type: 'http', url: 'https://pdf.example.com/mcp', headers: { 'x-api-key': '${COMPDF_API_KEY}' } },
      },
    });
  });
  it.each(['file:///private', 'https://user:secret@pdf.example.com/mcp', 'https://pdf.example.com/other', 'https://pdf.example.com/mcp?secret=value', 'https://pdf.example.com/mcp#fragment'])('rejects unsafe public URL %s', (publicUrl) => {
    expect(() => new McpSettings(new ConfigService({ mcp: { publicUrl } }))).toThrow();
  });
  it.each(['*', 'null', 'https://admin.example.com/path', 'https://admin.example.com/'])('rejects non-exact allowed Origin %s', (origin) => {
    expect(() => new McpSettings(new ConfigService({ mcp: { allowedOrigins: [origin] } }))).toThrow();
  });
  it('can disable the endpoint and lower the inline upload limit', () => {
    const settings = new McpSettings(new ConfigService({ mcp: { enabled: false, maxInlineFileBytes: 2 } }));
    expect(settings.clientConfiguration().enabled).toBe(false);
    expect(() => decodeFile(Buffer.from('abc').toString('base64'), settings.maxInlineFileBytes)).toThrow();
  });
  it('returns 404 for a disabled endpoint before authentication or protocol parsing', () => {
    const settings = new McpSettings(new ConfigService({ mcp: { enabled: false } }));
    const use = vi.fn();
    configureMcpHttp({ get: () => settings, use } as any);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    use.mock.calls[0][1]({}, response, next);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ jsonrpc: '2.0' }));
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects missing bridge credentials and non-HTTP or credential-bearing URLs', async () => {
    await expect(startMcpStdio({})).rejects.toThrow();
    for (const url of ['file:///private', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?key=secret']) {
      await expect(startMcpStdio({ COMPDF_API_KEY: 'test-key', COMPDF_MCP_URL: url })).rejects.toThrow();
    }
  });
  it.each(['', 'Zg', 'Zg=', 'Zg===', 'Zh==', 'Zg==\n', '!!!!', '===='])('rejects invalid or noncanonical Base64 %j', (encoded) => {
    expect(() => decodeFile(encoded, 100)).toThrow();
  });
  it('accepts canonical padded and unpadded complete-quantum Base64', () => {
    expect(decodeFile('Zg==', 1).toString()).toBe('f');
    expect(decodeFile('Zm8=', 2).toString()).toBe('fo');
    expect(decodeFile('Zm9v', 3).toString()).toBe('foo');
  });
});
