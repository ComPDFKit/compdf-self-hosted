/**
 * MysqlClient — pooled mysql2/promise connection (app-egress, lives in clients/).
 *
 * Used by LoggingInterceptor (write operation_logs), AuthService (users table),
 * and LicenseController (license_display cache). The schema is configs/init.sql.
 *
 * All query input flows through parameterized values — never string-interpolated.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mysql, {
  Pool,
  PoolOptions,
  RowDataPacket,
  ResultSetHeader,
  QueryValues,
  ExecuteValues,
} from 'mysql2/promise';

@Injectable()
export class MysqlClient implements OnModuleDestroy {
  private readonly logger = new Logger(MysqlClient.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const options: PoolOptions = {
      host: config.get<string>('database.host') ?? 'compdf-infra',
      port: config.get<number>('database.port') ?? 3306,
      user: config.get<string>('database.user') ?? 'compdfkit',
      password: config.get<string>('database.password') ?? '',
      database: config.get<string>('database.name') ?? 'compdfkit',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
    };
    this.pool = mysql.createPool(options);
  }

  /**
   * Parameterized SELECT. Returns rows typed as the caller's `T`.
   *
   * The public generic `T` is left UNCONSTRAINED so callers may write
   * `query<Array<{ id: number; ... }>>(...)` without tripping mysql2's
   * `RowDataPacket` brand (the brand makes plain object arrays inadmissible
   * to `T extends RowDataPacket[]`). Internally we call `pool.query` with the
   * concrete `RowDataPacket[]` (which satisfies mysql2's `QueryResult`
   * constraint) and cast at this single DB boundary — the standard mysql2
   * escape hatch for the brand gap. No `any`.
   */
  async query<T = RowDataPacket[]>(
    sql: string,
    params: QueryValues = [],
  ): Promise<T> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
      return rows as unknown as T;
    } catch (err) {
      this.logger.error(`query failed: ${(err as Error).message} | sql=${sql}`);
      throw err;
    }
  }

  /** Parameterized INSERT/UPDATE/DELETE. Returns the result header. */
  async execute(
    sql: string,
    params: ExecuteValues = [],
  ): Promise<ResultSetHeader> {
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(sql, params);
      return result;
    } catch (err) {
      this.logger.error(`execute failed: ${(err as Error).message} | sql=${sql}`);
      throw err;
    }
  }

  /** Best-effort ping; resolves true/false rather than throwing. */
  async ping(): Promise<boolean> {
    try {
      const conn = await this.pool.getConnection();
      try {
        await conn.ping();
        return true;
      } finally {
        conn.release();
      }
    } catch (err) {
      this.logger.warn(`mysql ping failed: ${(err as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
