import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import axios from 'axios';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyService } from '../auth/api-key.service';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BatchService } from '../batch/batch.service';
import { MysqlClient } from '../clients/mysql.client';
import { EnvelopeInterceptor } from '../common/interceptors/envelope.interceptor';
import { RuntimeModeService } from '../runtime/runtime-mode.service';
import { McpController, McpStatusController } from './mcp.controller';
import { configureMcpHttp } from './mcp.http';
import { McpSettings } from './mcp.settings';
import { McpStatusService } from './mcp-status.service';
import { McpTools } from './mcp.tools';

describe('Dashboard MCP status (real HTTP and MCP discovery)', () => {
  let app: INestApplication;
  let baseURL: string;
  let token: string;
  let revoked = false;
  let plaintext: string | null = 'status-test-key';
  const config = new ConfigService({ mcp: { publicUrl: 'https://public.example.com/mcp' } });
  const jwt = new JwtService({ secret: 'mcp-status-test-secret' });
  const db = { query: vi.fn(), execute: vi.fn() };
  const apiKeys = { getPlaintextKey: vi.fn(() => plaintext) };
  const batches = { create: vi.fn(), upload: vi.fn(), commit: vi.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [McpController, McpStatusController],
      providers: [
        McpSettings, McpTools, McpStatusService, ApiKeyGuard, JwtAuthGuard,
        { provide: ConfigService, useValue: config },
        { provide: ApiKeyService, useValue: apiKeys },
        { provide: MysqlClient, useValue: db },
        { provide: BatchService, useValue: batches },
        { provide: JwtService, useValue: jwt },
        { provide: RuntimeModeService, useValue: { isAcceptingNewWork: () => true } },
      ],
    }).compile();
    app = module.createNestApplication();
    configureMcpHttp(app);
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    await app.listen(0, '127.0.0.1');
    baseURL = await app.getUrl();
    config.set('port', Number(new URL(baseURL).port));
    token = await jwt.signAsync({ sub: 1, username: 'admin', role: 'admin', ver: 0 });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    revoked = false;
    plaintext = 'status-test-key';
    apiKeys.getPlaintextKey.mockImplementation(() => plaintext);
    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM users WHERE')) return [{ status: 1, token_version: 0, created_at: '2020-01-01' }];
      if (params[0] === createHash('sha256').update('status-test-key').digest('hex')) {
        return [{ key_id: 'test', status: revoked ? 0 : 1, owner_username: 'admin' }];
      }
      return [];
    });
    db.execute.mockResolvedValue({ affectedRows: 1 });
  });

  async function getStatus() {
    return axios.get(`${baseURL}/api/v1/dashboard/mcp/status`, { headers: { Authorization: `Bearer ${token}` } });
  }

  it('requires a Dashboard session', async () => {
    const response = await axios.get(`${baseURL}/api/v1/dashboard/mcp/status`, { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('discovers local tools without contacting the public URL or starting a batch', async () => {
    const response = await getStatus();
    expect(response.data.data).toEqual({ status: 'running', checkedAt: expect.any(String) });
    expect(JSON.stringify(response.data)).not.toContain(plaintext);
    expect(batches.create).not.toHaveBeenCalled();
    expect(batches.upload).not.toHaveBeenCalled();
    expect(batches.commit).not.toHaveBeenCalled();
  });

  it('reports error if the deployment key is revoked', async () => {
    revoked = true;
    expect((await getStatus()).data.data.status).toBe('error');
  });

  it('reports error if no deployment key is available', async () => {
    plaintext = null;
    expect((await getStatus()).data.data.status).toBe('error');
  });

  it('reports not_enabled without reading credentials or making a network request', async () => {
    const service = new McpStatusService(
      new McpSettings(new ConfigService({ mcp: { enabled: false } })),
      apiKeys as unknown as ApiKeyService,
      config,
    );
    const before = apiKeys.getPlaintextKey.mock.calls.length;
    expect((await service.check()).status).toBe('not_enabled');
    expect(apiKeys.getPlaintextKey.mock.calls).toHaveLength(before);
  });
});
