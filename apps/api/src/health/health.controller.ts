import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

/** The bucket probe gives up after this long (a hung endpoint must not hang the health check). */
export const STORAGE_CHECK_TIMEOUT_MS = 2000;

type Check = 'ok' | 'error';

export interface HealthStatus {
  status: Check;
  db: Check;
  storage: Check;
}

/** Liveness and readiness for Docker and Dokploy: the database and the bucket are reachable. */
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async check(): Promise<HealthStatus> {
    const [db, storage] = await Promise.all([
      this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('storage', () => this.storage.checkBucket(STORAGE_CHECK_TIMEOUT_MS)),
    ]);
    const result: HealthStatus = {
      status: db === 'ok' && storage === 'ok' ? 'ok' : 'error',
      db,
      storage,
    };
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }

  private async probe(name: string, check: () => Promise<unknown>): Promise<Check> {
    try {
      await check();
      return 'ok';
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        `health check: ${name} unreachable`,
      );
      return 'error';
    }
  }
}
