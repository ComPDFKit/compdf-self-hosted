import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export const BATCH_KINDS = ['pdf', 'conversion'] as const;
export type BatchKind = typeof BATCH_KINDS[number];

export class CreateBatchDto {
  @IsIn(BATCH_KINDS)
  kind!: BatchKind;

  @IsString()
  @MaxLength(64)
  op!: string;

  @IsOptional() @IsString() @MaxLength(64)
  target?: string;

  @IsOptional() @IsString() @MaxLength(64)
  type?: string;

  @IsOptional() @IsString() @MaxLength(64)
  operation?: string;

  @IsOptional() @IsObject()
  request?: Record<string, unknown>;

  @IsOptional() @IsObject()
  options?: Record<string, unknown>;

  @IsOptional() @IsString() @MaxLength(128)
  idempotencyKey?: string;
}

export class RetryBatchItemDto {
  @IsOptional() @IsString() @MaxLength(512)
  password?: string;
}

/** Password belongs to this uploaded item only, never to the batch request. */
export class UploadBatchFileDto {
  @IsOptional() @IsString() @MaxLength(512)
  password?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  relativePath?: string;
}
