import { INestApplication, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import axios from 'axios';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BatchService, BatchInfo } from '../batch/batch.service';
import { MysqlClient } from '../clients/mysql.client';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { EnvelopeInterceptor } from '../common/interceptors/envelope.interceptor';
import { LoggingInterceptor } from '../common/interceptors/logging.interceptor';
import { RuntimeModeService } from '../runtime/runtime-mode.service';
import { McpAdminController, McpController } from './mcp.controller';
import { configureMcpHttp } from './mcp.http';
import { MCP_TOOL_NAMES } from './mcp.schemas';
import { McpSettings, MCP_BODY_LIMIT } from './mcp.settings';
import { McpTools } from './mcp.tools';

describe('MCP HTTP and stdio protocol (real SDK, stubbed persistence and processing)', () => {
  let app: INestApplication;
  let baseline: INestApplication;
  let baseURL: string;
  let baselineURL: string;
  let mode = 'normal';
  let revoked = false;
  const clients: Client[] = [];
  const store = new Map<string, { owner: string; info: BatchInfo }>();
  const batches = { create: vi.fn(), upload: vi.fn(), commit: vi.fn(), getRequired: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
  const db = { query: vi.fn(), execute: vi.fn() };
  const jwt = new JwtService({ secret: 'mcp-test-only-secret' });
  const config = new ConfigService({ port: 8080, mcp: { publicUrl: 'http://localhost:8080/mcp' } });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [McpController, McpAdminController],
      providers: [McpSettings, McpTools, ApiKeyGuard, JwtAuthGuard,
        { provide: ConfigService, useValue: config }, { provide: MysqlClient, useValue: db },
        { provide: BatchService, useValue: batches }, { provide: JwtService, useValue: jwt },
        { provide: RuntimeModeService, useValue: { isAcceptingNewWork: () => mode === 'normal' } }],
    }).compile();
    app = module.createNestApplication();
    configureMcpHttp(app);
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(db as unknown as MysqlClient), new EnvelopeInterceptor());
    await app.listen(0, '127.0.0.1');
    baseURL = await app.getUrl();
    const baselineModule = await Test.createTestingModule({
      controllers: [McpAdminController],
      providers: [McpSettings, { provide: ConfigService, useValue: config }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true }).compile();
    baseline = baselineModule.createNestApplication();
    baseline.useGlobalFilters(new AllExceptionsFilter());
    await baseline.listen(0, '127.0.0.1');
    baselineURL = await baseline.getUrl();
  });
  afterAll(async () => {
    for (const client of clients) await client.close();
    await app?.close();
    await baseline?.close();
  });
  beforeEach(() => {
    mode = 'normal';
    revoked = false;
    store.clear();
    db.query.mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM users WHERE')) return [{ status: 1, token_version: 0, created_at: '2020-01-01' }];
      for (const key of ['test-key-a', 'test-key-b']) {
        if (args[0] === createHash('sha256').update(key).digest('hex') && !(revoked && key === 'test-key-a')) {
          return [{ key_id: key.slice(-1), status: 1, owner_username: 'admin' }];
        }
      }
      return [];
    });
    db.execute.mockResolvedValue({ affectedRows: 1 });
    batches.create.mockImplementation(async (dto, owner: string) => {
      const info = emptyBatch();
      info.kind = dto.kind;
      info.op = dto.op;
      store.set(info.batchId, { owner, info });
      return info;
    });
    batches.getRequired.mockImplementation(async (id: string, owner: string) => {
      const record = store.get(id);
      if (!record || record.owner !== owner) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
      return record.info;
    });
    batches.upload.mockImplementation(async (id, file, _password, _relativePath, owner) => {
      const info = await batches.getRequired(id, owner);
      const item = { itemId: randomUUID(), sequenceNo: 1, sourceName: file.originalname, sourceSize: file.size, status: 'uploaded', attemptCount: 0 };
      info.items.push(item);
      info.totalCount++;
      return item;
    });
    for (const method of ['commit', 'cancel'] as const) {
      batches[method].mockImplementation(async (id, owner) => {
        const info = await batches.getRequired(id, owner);
        info.status = method === 'commit' ? 'queued' : 'canceled';
        return info;
      });
    }
    batches.retry.mockImplementation(async (itemId, _password, owner) => {
      const record = [...store.values()].find((b) => b.owner === owner && b.info.items.some((i) => i.itemId === itemId));
      if (!record) throw new NotFoundException();
      return record.info;
    });
  });

  async function rpc(method: string, params: unknown = {}, key: string | null = 'test-key-a', headers: Record<string, string> = {}) {
    const response = await axios.post(`${baseURL}/mcp`, { jsonrpc: '2.0', id: 1, method, params }, {
      headers: { Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...(key ? { 'x-api-key': key } : {}), ...headers },
      validateStatus: () => true,
    });
    if (response.headers['content-type']?.includes('text/event-stream')) {
      const frames = String(response.data).split('\n').filter((line) => line.startsWith('data: '));
      expect(frames).toHaveLength(1);
      response.data = JSON.parse(frames[0].slice(6));
    }
    return response;
  }
  async function call(name: string, args: unknown = {}, key?: string) {
    return rpc('tools/call', { name, arguments: args }, key);
  }
  async function create(key?: string) {
    return (await call('create_batch', { kind: 'pdf', op: 'compress' }, key)).data.result.structuredContent as BatchInfo;
  }
  async function connect(key: string = 'test-key-a') {
    const client = new Client({ name: 'mcp-http-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), { requestInit: { headers: { 'x-api-key': key } } }));
    return client;
  }

  it('supports the official modern HTTP client discovery and tool call', async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe('compdf-self-hosted');
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect((await client.callTool({ name: 'list_operations', arguments: {} })).structuredContent).toMatchObject({ limits: { maxInlineFileBytes: 4194304 } });
  });

  it('supports legacy initialize without sessions or REST envelopes', async () => {
    const result = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
    expect(result.status).toBe(200);
    expect(result.headers['mcp-session-id']).toBeUndefined();
    expect(result.data.result.protocolVersion).toBe('2025-11-25');
    expect(result.data.code).toBeUndefined();
  });

  it.each([null, 'not-valid'])('rejects missing or invalid API Key %s', async (key) => {
    const response = await rpc('tools/list', {}, key);
    expect(response.status).toBe(401);
    expect(response.data).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('revalidates a revoked API Key after client connection', async () => {
    const client = await connect();
    revoked = true;
    await expect(client.callTool({ name: 'list_operations', arguments: {} })).rejects.toThrow();
  });

  it('forwards creation, file-bound password, commit, query, retry and cancel', async () => {
    const batch = await create();
    const upload = await call('upload_batch_file', { batchId: batch.batchId, filename: 'source.pdf', contentBase64: Buffer.from('%PDF source').toString('base64'), password: 'source-secret', relativePath: 'folder/source.pdf' });
    expect(upload.data.result.structuredContent.status).toBe('uploaded');
    expect(batches.upload).toHaveBeenCalledWith(batch.batchId, expect.objectContaining({ buffer: Buffer.from('%PDF source'), originalname: 'source.pdf' }), 'source-secret', 'folder/source.pdf', 'a');
    expect((await call('commit_batch', { batchId: batch.batchId })).data.result.structuredContent.status).toBe('queued');
    expect((await call('get_batch', { batchId: batch.batchId })).data.result.structuredContent.items).toHaveLength(1);
    await call('retry_batch_item', { itemId: upload.data.result.structuredContent.itemId, password: 'new-secret' });
    expect(batches.retry).toHaveBeenLastCalledWith(upload.data.result.structuredContent.itemId, 'new-secret', 'a');
    expect((await call('cancel_batch', { batchId: batch.batchId })).data.result.structuredContent.status).toBe('canceled');
    expect(JSON.stringify(db.execute.mock.calls)).not.toContain('secret');
  });

  it('preserves public output encryption passwords without logging or returning them', async () => {
    const request = { userPassword: 'output-secret', ownerPassword: 'owner-secret' };
    const response = await call('create_batch', { kind: 'pdf', op: 'encrypt', request });
    expect(response.data.result.isError).toBeUndefined();
    expect(batches.create).toHaveBeenCalledWith({ kind: 'pdf', op: 'encrypt', request }, 'a');
    expect(JSON.stringify(response.data)).not.toContain('secret');
    expect(JSON.stringify(db.execute.mock.calls)).not.toContain('secret');
  });

  it('passes the current API Key identity for every operation and hides another key batch', async () => {
    const a = await create();
    const b = await create('test-key-b');
    for (const name of ['get_batch', 'commit_batch', 'cancel_batch']) {
      const response = await call(name, { batchId: a.batchId }, 'test-key-b');
      expect(response.data.result).toMatchObject({ isError: true, structuredContent: { error: { status: 404 } } });
    }
    const file = { batchId: a.batchId, filename: 'a.pdf', contentBase64: 'JVBERg==' };
    expect((await call('upload_batch_file', file, 'test-key-b')).data.result.structuredContent.error.status).toBe(404);
    const ownItem = (await call('upload_batch_file', file)).data.result.structuredContent;
    expect((await call('retry_batch_item', { itemId: ownItem.itemId }, 'test-key-b')).data.result.structuredContent.error.status).toBe(404);
    expect((await call('get_batch', { batchId: b.batchId }, 'test-key-b')).data.result.structuredContent.batchId).toBe(b.batchId);
  });

  it.each(['draining', 'maintenance'])('blocks new processing in %s but permits reads and cancellation', async (state) => {
    const batch = await create();
    mode = state;
    for (const [name, args] of [
      ['create_batch', { kind: 'pdf', op: 'compress' }],
      ['upload_batch_file', { batchId: batch.batchId, filename: 'a.pdf', contentBase64: 'JVBERg==' }],
      ['commit_batch', { batchId: batch.batchId }],
      ['retry_batch_item', { itemId: randomUUID() }],
    ] as const) {
      expect((await call(name, args)).data.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'SERVICE_MAINTENANCE', status: 503 } } });
    }
    expect(batches.upload).not.toHaveBeenCalled();
    expect(batches.commit).not.toHaveBeenCalled();
    expect(batches.retry).not.toHaveBeenCalled();
    for (const [name, args] of [['list_operations', {}], ['get_batch', { batchId: batch.batchId }], ['cancel_batch', { batchId: batch.batchId }]] as const) {
      expect((await call(name, args)).data.result.isError).toBeUndefined();
    }
  });

  it.each([
    ['create_batch', { kind: 'wrong', op: 'compress' }],
    ['create_batch', { kind: 'pdf', op: 'compress', password: 'secret' }],
    ['get_batch', { batchId: '../../escape' }],
    ['upload_batch_file', { batchId: randomUUID(), filename: '../source.pdf', contentBase64: 'JVBERg==' }],
    ['upload_batch_file', { batchId: randomUUID(), filename: 'a.pdf', contentBase64: 'JVBERg==', url: 'http://internal/' }],
    ['retry_batch_item', { itemId: randomUUID(), password: 'x'.repeat(513) }],
  ])('validates %s parameters before business work', async (name, args) => {
    const response = await call(name, args);
    expect(response.data.error ?? response.data.result?.isError).toBeTruthy();
    expect(batches.create).not.toHaveBeenCalled();
    expect(batches.upload).not.toHaveBeenCalled();
    expect(batches.retry).not.toHaveBeenCalled();
  });

  it('rejects unknown tools', async () => {
    const response = await call('unsupported_tool');
    expect(response.data.error ?? response.data.result?.isError).toBeTruthy();
  });

  it('bounds Base64 decoding and rejects non-canonical encoding', async () => {
    const id = randomUUID();
    for (const contentBase64 of ['JVBERg=!', 'Zh==', 'JVBE Rg==', Buffer.alloc(4194305).toString('base64')]) {
      const response = await call('upload_batch_file', { batchId: id, filename: 'a.pdf', contentBase64 });
      expect(response.data.result.isError).toBe(true);
    }
    expect(batches.upload).not.toHaveBeenCalled();
  });

  it('accepts a 4 MiB inline file without increasing other REST body limits', async () => {
    const batch = await create();
    const response = await call('upload_batch_file', { batchId: batch.batchId, filename: 'large.pdf', contentBase64: Buffer.alloc(4194304).toString('base64') });
    expect(response.data.result.structuredContent.sourceSize).toBe(4194304);
    const largeBody = { padding: 'x'.repeat(130000) };
    const queryCalls = db.query.mock.calls.length;
    const rest = await axios.request({ url: `${baseURL}/api/v1/dashboard/mcp`, method: 'GET', data: largeBody, validateStatus: () => true });
    const control = await axios.request({ url: `${baselineURL}/api/v1/dashboard/mcp`, method: 'GET', data: largeBody, validateStatus: () => true });
    expect(rest.status).toBe(control.status);
    expect(rest.data.errorCode).toBe(control.data.errorCode);
    expect(db.query).toHaveBeenCalledTimes(queryCalls);
  });

  it('returns JSON-RPC for malformed and oversized bodies', async () => {
    for (const [body, status, code] of [['{', 400, -32700], [JSON.stringify({ padding: 'x'.repeat(MCP_BODY_LIMIT) }), 413, -32600]] as const) {
      const response = await axios.post(`${baseURL}/mcp`, body, { headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key-a' }, validateStatus: () => true });
      expect(response.status).toBe(status);
      expect(response.data).toMatchObject({ jsonrpc: '2.0', error: { code } });
    }
  });

  it.each([{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' }, { Origin: 'null' }, { Origin: 'http://localhost:9999' }])('rejects disallowed request source %j', async (headers) => {
    const response = await rpc('tools/list', {}, 'test-key-a', headers);
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('allows the configured exact browser Origin', async () => {
    expect((await rpc('tools/list', {}, 'test-key-a', { Origin: 'http://localhost:8080' })).status).toBe(200);
  });

  it('does not expose raw errors or stored failure details', async () => {
    batches.create.mockRejectedValueOnce(new BadRequestException({ code: 'INVALID_ARGUMENT', message: 'secret password C:/private/file.pdf' }));
    const invalid = await call('create_batch', { kind: 'pdf', op: 'compress' });
    expect(invalid.data.result.structuredContent.error.code).toBe('INVALID_ARGUMENT');
    batches.create.mockRejectedValueOnce(new Error('SQL private-token secret'));
    const crashed = await call('create_batch', { kind: 'pdf', op: 'compress' });
    expect(crashed.data.result.structuredContent.error.code).toBe('INTERNAL_ERROR');
    const batch = await create();
    batch.items.push({ itemId: randomUUID(), sequenceNo: 1, sourceName: 'a.pdf', sourceSize: 10, status: 'failed', attemptCount: 1, failureReason: 'password=secret path=C:/private' });
    for (const response of [invalid, crashed, await call('get_batch', { batchId: batch.batchId })]) {
      expect(JSON.stringify(response.data)).not.toMatch(/secret|private-token|C:\//);
    }
    expect(JSON.stringify(db.execute.mock.calls)).not.toMatch(/secret|private-token|C:\//);
  });

  it('does not fail a tool call if audit storage is unavailable', async () => {
    db.execute.mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await call('list_operations')).data.result.isError).toBeUndefined();
  });

  it('requires Dashboard JWT and returns configurations without stored secrets', async () => {
    const token = await jwt.signAsync({ sub: 1, username: 'admin', role: 'admin', ver: 0 });
    const unauthenticated = await axios.get(`${baseURL}/api/v1/dashboard/mcp`, { headers: { 'x-api-key': 'test-key-a' }, validateStatus: () => true });
    expect(unauthenticated.status).toBe(401);
    const response = await axios.get(`${baseURL}/api/v1/dashboard/mcp`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.data.data.url).toBe('http://localhost:8080/mcp');
    expect(response.data.data.clients.codexToml).toContain('env_http_headers');
    expect(JSON.stringify(response.data)).not.toContain('test-key-a');
    expect(JSON.stringify(response.data)).not.toContain(token);
  });

  it('answers 405 to legacy session GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await axios.request({ url: `${baseURL}/mcp`, method, headers: { 'x-api-key': 'test-key-a' }, validateStatus: () => true });
      expect(response.status).toBe(405);
    }
  });

  it('bridges stdio discovery, successful calls and business errors through official transports', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-r', 'ts-node/register', join(process.cwd(), 'src/mcp/mcp-stdio.ts')],
      cwd: process.cwd(), stderr: 'pipe',
      env: { COMPDF_MCP_URL: `${baseURL}/mcp`, COMPDF_API_KEY: 'test-key-a' },
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const client = new Client({ name: 'stdio-test', version: '1' });
    clients.push(client);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect((await client.callTool({ name: 'create_batch', arguments: { kind: 'pdf', op: 'compress' } })).structuredContent).toMatchObject({ status: 'draft' });
    expect((await client.callTool({ name: 'get_batch', arguments: { batchId: randomUUID() } })).isError).toBe(true);
    expect(stderr).not.toContain('test-key-a');
    await client.close();
  }, 20000);
});

function emptyBatch(): BatchInfo {
  return { batchId: randomUUID(), kind: 'pdf', op: 'compress', status: 'draft', totalCount: 0, queuedCount: 0, processingCount: 0, successCount: 0, failedCount: 0, canceledCount: 0, items: [] };
}
