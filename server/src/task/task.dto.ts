import { IsIn, IsString, IsOptional, IsArray } from 'class-validator';

export class CreateTaskDto {
  @IsOptional() @IsIn(['pdf', 'conversion']) kind!: 'pdf' | 'conversion';
  @IsOptional() @IsString() op!: string;    // merge | split | convert | convert-to-pdf | documentai | ...
  @IsOptional() @IsString() target?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() operation?: string;
  @IsOptional() @IsString() request?: string;   // JSON string (pdf ops)
  @IsOptional() @IsString() options?: string;   // JSON string (conversion)
  @IsOptional() @IsString() password?: string;
}
