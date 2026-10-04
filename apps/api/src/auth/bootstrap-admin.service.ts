import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { ENV } from '../config/env.module.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashPassword } from './password.js';

export type BootstrapOutcome = 'created' | 'already-created' | 'users-exist' | 'not-configured';

/**
 * Creates the first admin from BOOTSTRAP_ADMIN_* (production has no interactive shell), during
 * app bootstrap and so before the server listens. Only ever acts on an empty users table: it
 * never updates, reactivates or recreates an existing user.
 */
@Injectable()
export class BootstrapAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<BootstrapOutcome> {
    const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = this.env;

    if ((await this.prisma.user.findFirst({ select: { id: true } })) !== null) {
      if (email !== undefined) {
        this.logger.warn(
          'BOOTSTRAP_ADMIN_* is set but users already exist, so it was ignored. Remove these variables.',
        );
      }
      return 'users-exist';
    }
    if (email === undefined || password === undefined) {
      this.logger.warn(
        'No users exist. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (or run `pnpm create-admin` locally).',
      );
      return 'not-configured';
    }

    try {
      await this.prisma.user.create({
        data: {
          email,
          name: this.env.BOOTSTRAP_ADMIN_NAME,
          passwordHash: await hashPassword(password),
          isActive: true,
          mustChangePassword: true,
        },
      });
    } catch (error) {
      // Another instance booting at the same time created it first.
      if (isUniqueViolation(error)) {
        this.logger.log(`bootstrap admin already created: ${email}`);
        return 'already-created';
      }
      throw error;
    }
    this.logger.log(`bootstrap admin created: ${email}`);
    return 'created';
  }
}
