/**
 * HealthModule — `GET /api/v1/status` aggregated probe. Imports ClientsModule
 * for MysqlClient + RedisClient. Public (no guard).
 */
import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ClientsModule],
  controllers: [HealthController],
})
export class HealthModule {}
