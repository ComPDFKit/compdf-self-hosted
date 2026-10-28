import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs/operators';

export const PROCESSING_DONE = Symbol('processing-request-done');

@Injectable()
export class ProcessingActivityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ [PROCESSING_DONE]?: () => void }>();
    // Handler completion releases the count even after a client disconnect.
    // Queued jobs remain covered by the database drain.
    return next.handle().pipe(finalize(() => request[PROCESSING_DONE]?.()));
  }
}
