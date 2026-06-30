import { IsIn, IsString, IsOptional, IsArray } from 'class-validator';

export class CreateTaskDto {
  @IsIn(['pdf', 'conversion']) kind!: 'pdf' | 'conversion';
  @IsString() op!: string;                  // merge | split | convert | convert-to-pdf | documentai | ...
  @IsOptional() @IsString() target?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() operation?: string;
  @IsOptional() @IsString() request?: string;   // JSON string (pdf ops)
  @IsOptional() @IsString() options?: string;   // JSON string (conversion)
  @IsOptional() @IsString() password?: string;
}
