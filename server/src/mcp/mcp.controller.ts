import { All, ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { rpcError } from './mcp.http';
import { MCP_BODY_LIMIT, McpSettings } from './mcp.settings';
import { McpTools } from './mcp.tools';
import { McpStatusService } from './mcp-status.service';

@Catch()
export class McpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    const status = error instanceof HttpException ? error.getStatus() : 500;
    response.status(status).json(rpcError(status === 401 ? -32001 : -32603, status === 401 ? 'A valid x-api-key is required' : 'MCP request failed'));
  }
}

@Controller('mcp')
@UseFilters(McpExceptionFilter)
@UseGuards(ApiKeyGuard)
export class McpController {
  constructor(private readonly tools: McpTools) {}

  @All()
  async handle(@Req() req: Request & { apiKeyId: string; apiKeyOwner: string | null }, @Res() res: Response): Promise<void> {
    const handler = createMcpHandler(() => this.tools.createServer({ apiKeyId: req.apiKeyId, owner: req.apiKeyOwner }),
      { maxRequestBodySize: MCP_BODY_LIMIT });
    try {
      await toNodeHandler(handler, { maxRequestBodySize: MCP_BODY_LIMIT })(req, res, req.body);
    } finally {
      await handler.close();
    }
  }
}

@Controller('api/v1/dashboard/mcp')
@UseGuards(JwtAuthGuard)
export class McpAdminController {
  constructor(private readonly settings: McpSettings) {}

  @Get()
  configuration() {
    return this.settings.clientConfiguration();
  }
}

@Controller('api/v1/dashboard/mcp/status')
@UseGuards(JwtAuthGuard)
export class McpStatusController {
  constructor(private readonly status: McpStatusService) {}

  @Get()
  check() {
    return this.status.check();
  }
}
