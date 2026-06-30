/**
 * SpaController — serves the ComPDF Web SPA and injects the display-only license
 * payload into its index.html.
 *
 *   GET /        → public/compdf-web/index.html  (ComPDF Web, no login)
 *   GET /pdf-tools/:convert → same index.html (Vue history route fallback)
 *
 * Injection: `window.COMPDF_LICENSE = <decodeForDisplay() JSON>`. The payload is
 * DISPLAY-ONLY (sub/exp/scope/limits/status/present) — it contains NO limit
 * toggles and NOT the raw token. The raw token reaches upstream only via the
 * clients' `X-ComPDF-License` header (sourced from `req.__licenseToken`).
 *
 * The static `public/*` dirs are populated by the frontend build. In dev they
 * may not exist; a missing index.html yields a clean 503 "frontend not built"
 * rather than crashing boot or throwing on the request.
 */
import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { LicenseTokenService, LicenseDisplay } from '../license/license-token.service';

@Controller()
export class SpaController {
  private readonly webDemoIndex: string;

  constructor(
    private readonly licenseToken: LicenseTokenService,
    config: ConfigService,
  ) {
    const publicDir = config.get<string>('publicDir') ?? join(process.cwd(), 'public');
    this.webDemoIndex = join(publicDir, 'compdf-web', 'index.html');
    // Resolve once at construction; existence is checked per-request so a missing
    // dir never crashes boot.
  }

  @Get()
  webDemo(@Res() res: Response): void {
    this.serve(res, this.webDemoIndex);
  }

  @Get(['pdf-tools', 'pdf-tools/:convert'])
  webRoute(@Res() res: Response): void {
    this.serve(res, this.webDemoIndex);
  }

  private serve(res: Response, indexPath: string): void {
    if (!existsSync(indexPath)) {
      res
        .status(503)
        .set('Content-Type', 'application/json')
        .send({
          code: 'FRONTEND_NOT_BUILT',
          message: 'frontend assets not built; the SPA index.html is missing. Build the frontends into public/.',
        });
      return;
    }
    const html = readFileSync(indexPath, 'utf8');
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(injectLicense(html, this.licenseToken.decodeForDisplay()));
  }
}

/**
 * Embed `window.COMPDF_LICENSE = <json>` into the SPA HTML. Prefer a
 * `<!--COMPDF_LICENSE-->` marker (lets the build template control placement);
 * otherwise inject before `</head>`, or append as a last resort. `<`, `>`, and
 * `&` are escaped to their `\u00XX` forms so no string field can break out of
 * the <script> context or inject HTML.
 */
export function injectLicense(html: string, payload: LicenseDisplay): string {
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const script = `<script>window.COMPDF_LICENSE=${json};</script>`;
  if (html.includes('<!--COMPDF_LICENSE-->')) {
    return html.replace('<!--COMPDF_LICENSE-->', script);
  }
  if (html.includes('</head>')) {
    return html.replace('</head>', `${script}</head>`);
  }
  return `${html}${script}`;
}
