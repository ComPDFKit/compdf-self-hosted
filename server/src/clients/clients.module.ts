/**
 * ClientsModule — single ownership of the four egress/infra clients.
 *
 * Provides AND exports: MysqlClient, RedisClient, PdfSdkClient, ConversionClient.
 * Feature modules (Auth, Pdf, Conversion, Health, License) import this
 * module instead of re-declaring the clients locally — one ownership model, no
 * duplicate provider registrations.
 *
 * All four clients are `@Injectable` and depend only on the global `ConfigService`
 * (ConfigModule is global in AppModule), so they construct cleanly here.
 */
import { Module } from '@nestjs/common';
import { MysqlClient } from './mysql.client';
import { RedisClient } from './redis.client';
import { PdfSdkClient } from './pdf-sdk.client';
import { ConversionClient } from './conversion.client';

@Module({
  providers: [MysqlClient, RedisClient, PdfSdkClient, ConversionClient],
  exports: [MysqlClient, RedisClient, PdfSdkClient, ConversionClient],
})
export class ClientsModule {}
