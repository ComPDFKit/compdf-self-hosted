import { INestApplication } from '@nestjs/common';
import { hostHeaderValidation } from '@modelcontextprotocol/node';
import express, { ErrorRequestHandler } from 'express';
import { McpSettings, MCP_BODY_LIMIT } from './mcp.settings';

export function configureMcpHttp(app: Pick<INestApplication, 'get' | 'use'>): void {
  const settings = app.get(McpSettings);
  const validateHost = hostHeaderValidation(settings.allowedHosts);
  app.use('/mcp', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!settings.enabled) {
      res.status(404).json(rpcError(-32601, 'MCP is disabled'));
      return;
    }
    if (!validateHost(req, res)) return;
    if (!settings.acceptsOrigin(req)) {
      res.status(403).json(rpcError(-32600, 'Origin is not allowed'));
      return;
    }
    next();
  });
  app.use('/mcp', express.json({ limit: MCP_BODY_LIMIT }));
  const parserErrors: ErrorRequestHandler = (err, _req, res, next) => {
    if (err?.type === 'entity.too.large') res.status(413).json(rpcError(-32600, 'MCP request body is too large'));
    else if (err?.type === 'entity.parse.failed') res.status(400).json(rpcError(-32700, 'Invalid JSON'));
    else next(err);
  };
  app.use('/mcp', parserErrors);
  // Nest detects the scoped jsonParser by name and skips its default parser.
  // Restore that default globally; it skips MCP bodies that are already parsed.
  app.use(express.json());
}

export function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}
