import { BadRequestException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { Readable } from 'stream';
import { BatchInfo, BatchService, BATCH_CONVERSION_OPERATIONS, BATCH_PDF_OPERATIONS } from '../batch/batch.service';
import { MysqlClient } from '../clients/mysql.client';
import { ErrorCode } from '../common/errors/error-codes';
import { RuntimeModeService } from '../runtime/runtime-mode.service';
import { mcpDescriptions, mcpSchemas, McpToolName } from './mcp.schemas';
import { McpSettings } from './mcp.settings';

export interface McpPrincipal { apiKeyId: string; owner: string | null }

@Injectable()
export class McpTools {
  private readonly logger = new Logger(McpTools.name);

  constructor(
    private readonly batches: BatchService,
    private readonly runtime: RuntimeModeService,
    private readonly settings: McpSettings,
    private readonly mysql: MysqlClient,
  ) {}

  createServer(principal: McpPrincipal): McpServer {
    const server = new McpServer({ name: 'compdf-self-hosted', version: '1.0.0' });
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    server.registerTool('list_operations', { description: mcpDescriptions.list_operations, inputSchema: mcpSchemas.list_operations, annotations: read },
      async () => this.invoke('list_operations', principal, false, async () => ({
        operations: { pdf: BATCH_PDF_OPERATIONS, conversion: BATCH_CONVERSION_OPERATIONS },
        examples: {
          compress: { kind: 'pdf', op: 'compress' },
          encrypt: { kind: 'pdf', op: 'encrypt', request: { userPassword: '<OUTPUT_PASSWORD>', ownerPassword: '<OPTIONAL_OWNER_PASSWORD>' } },
          headersFooters: { kind: 'pdf', op: 'headers-footers/add', request: { regions: { bottomCenter: 'Page <<1>>' }, pages: 'all' } },
          bates: { kind: 'pdf', op: 'bates/add', request: { position: 'bottomRight', startNumber: 1, digits: 6 }, options: { numberingMode: 'per-file' } },
          pdfToWord: { kind: 'conversion', op: 'convert', target: 'docx' },
          pdfToMarkdown: { kind: 'conversion', op: 'convert', type: 'pdf/markdown' },
          documentToPdf: { kind: 'conversion', op: 'convert-to-pdf' },
        },
        parameterRules: {
          sourcePassword: 'Supply password on each upload, never in shared request/options.',
          pdf: 'Use request for the same PDF operation parameters as REST.',
          conversion: 'Use options for conversion options. For convert, supply either target or type. For documentai, supply operation.',
          bates: 'Only per-file numbering is supported; numbering restarts for each input.',
        },
        limits: this.settings.limits(),
        workflow: ['create_batch', 'upload_batch_file (once per file)', 'commit_batch', 'get_batch', 'download through REST'],
        rest: { baseUrl: new URL(this.settings.url).origin, upload: '/api/v1/batches/{batchId}/files', download: '/api/v1/batches/{batchId}/download', authenticationHeader: 'x-api-key' },
      })));
    server.registerTool('create_batch', { description: mcpDescriptions.create_batch, inputSchema: mcpSchemas.create_batch, annotations: write },
      async (args) => this.invoke('create_batch', principal, true, async () => this.safeBatch(await this.batches.create(args, principal.apiKeyId))));
    server.registerTool('upload_batch_file', { description: mcpDescriptions.upload_batch_file, inputSchema: mcpSchemas.upload_batch_file, annotations: write },
      async (args) => this.invoke('upload_batch_file', principal, true, async () => {
        const buffer = decodeFile(args.contentBase64, this.settings.maxInlineFileBytes);
        const file: Express.Multer.File = {
          fieldname: 'file', originalname: args.filename, encoding: '7bit', mimetype: 'application/octet-stream',
          buffer, size: buffer.length, stream: Readable.from(buffer), destination: '', filename: '', path: '',
        };
        const item = await this.batches.upload(args.batchId, file, args.password, args.relativePath, principal.apiKeyId);
        return { ...item, failureReason: item.failureReason ? 'Processing failed; inspect the authenticated REST response for details.' : undefined };
      }));
    server.registerTool('commit_batch', { description: mcpDescriptions.commit_batch, inputSchema: mcpSchemas.commit_batch, annotations: { ...write, idempotentHint: true } },
      async ({ batchId }) => this.invoke('commit_batch', principal, true, async () => this.safeBatch(await this.batches.commit(batchId, principal.apiKeyId))));
    server.registerTool('get_batch', { description: mcpDescriptions.get_batch, inputSchema: mcpSchemas.get_batch, annotations: read },
      async ({ batchId }) => this.invoke('get_batch', principal, false, async () => this.safeBatch(await this.batches.getRequired(batchId, principal.apiKeyId))));
    server.registerTool('cancel_batch', { description: mcpDescriptions.cancel_batch, inputSchema: mcpSchemas.cancel_batch, annotations: { ...write, destructiveHint: true, idempotentHint: true } },
      async ({ batchId }) => this.invoke('cancel_batch', principal, false, async () => this.safeBatch(await this.batches.cancel(batchId, principal.apiKeyId))));
    server.registerTool('retry_batch_item', { description: mcpDescriptions.retry_batch_item, inputSchema: mcpSchemas.retry_batch_item, annotations: write },
      async ({ itemId, password }) => this.invoke('retry_batch_item', principal, true, async () => this.safeBatch(await this.batches.retry(itemId, password, principal.apiKeyId))));
    return server;
  }

  private safeBatch(info: BatchInfo): Record<string, unknown> {
    return {
      ...info,
      items: info.items.map((item) => ({ ...item, failureReason: item.failureReason ? 'Processing failed; inspect the authenticated REST response for details.' : undefined })),
    };
  }

  private async invoke(name: McpToolName, principal: McpPrincipal, newWork: boolean, work: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
    const startedAt = Date.now();
    let status = 200;
    let data: Record<string, unknown>;
    try {
      if (newWork && !this.runtime.isAcceptingNewWork()) {
        throw new ServiceUnavailableException({ code: ErrorCode.SERVICE_MAINTENANCE });
      }
      data = await work();
    } catch (err) {
      status = err instanceof HttpException ? err.getStatus() : 500;
      const response = err instanceof HttpException ? err.getResponse() : null;
      const proposedCode = response && typeof response === 'object' && 'code' in response ? response.code : undefined;
      const code = typeof proposedCode === 'string' && Object.values(ErrorCode).includes(proposedCode as ErrorCode)
        ? proposedCode : status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_ARGUMENT;
      data = { error: { code, status, message: safeErrorMessage(status) } };
    }
    await this.audit(name, principal, status, Date.now() - startedAt);
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(status >= 400 ? { isError: true } : {}) };
  }

  private async audit(name: McpToolName, principal: McpPrincipal, status: number, duration: number): Promise<void> {
    try {
      await this.mysql.execute(
        `INSERT INTO operation_logs
          (log_type, operator, api_key_id, method, endpoint, feature, status_code, level, result, result_category, duration_ms, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [status >= 400 ? 'error' : 'api_call', principal.owner, principal.apiKeyId, 'POST', '/mcp', `mcp/${name}`, status,
          status >= 400 ? 'WARN' : 'INFO', status >= 400 ? 'fail' : 'success', status >= 500 ? 'exception' : status >= 400 ? 'invalid' : 'success',
          status < 400 ? duration : null, JSON.stringify({ tool: name, status })],
      );
    } catch {
      this.logger.warn('MCP audit write failed');
    }
  }
}

export function decodeFile(base64: string, limit: number): Buffer {
  if (base64.length > 4 * Math.ceil(limit / 3)) {
    throw new BadRequestException({ code: ErrorCode.FILE_TOO_LARGE });
  }
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.toString('base64') !== base64) throw new BadRequestException({ code: ErrorCode.INVALID_ARGUMENT });
  if (buffer.length > limit) throw new BadRequestException({ code: ErrorCode.FILE_TOO_LARGE });
  return buffer;
}

function safeErrorMessage(status: number): string {
  if (status === 404) return 'Batch or item not found for this API Key.';
  if (status === 409) return 'The current batch or item state does not allow this operation.';
  if (status === 503) return 'New processing is temporarily unavailable; try again after maintenance.';
  if (status >= 500) return 'The service could not complete this request.';
  return 'Invalid operation or parameters; check list_operations and the corresponding REST parameter contract.';
}
