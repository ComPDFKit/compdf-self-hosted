/**
 * LicensePassthroughInterceptor (architecture §8.1, verbatim intent).
 *
 * Single responsibility: stamp `req.__licenseToken` from LicenseTokenService so
 * the SDK clients can attach `X-ComPDF-License` on every upstream call.
 *
 * ★ Red line: it does NOT read, validate, or overwrite any license-limit
 * parameter, and it MUST NOT mutate `req.body` (no `watermark:true` injection).
 * All limit decisions live in the closed-source app against the signed token.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { LicenseTokenService } from '../../license/license-token.service';

@Injectable()
export class LicensePassthroughInterceptor implements NestInterceptor {
  constructor(private readonly licenseToken: LicenseTokenService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    // The ONLY license-related touch on the request. Clients read this to build
    // the `X-ComPDF-License` header. Nothing else.
    req.__licenseToken = this.licenseToken.getRawToken();
    return next.handle();
  }
}
