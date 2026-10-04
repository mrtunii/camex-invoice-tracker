import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateUserRequest,
  ResetPasswordRequest,
  UpdateUserRequest,
  User,
} from '@camex/shared';
import { hashPassword } from '../auth/password.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { User as UserRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<User[]> {
    const rows = await this.prisma.user.findMany({ orderBy: [{ createdAt: 'asc' }] });
    return rows.map(toUserDto);
  }

  async create(input: CreateUserRequest, actorId: string): Promise<User> {
    try {
      const row = await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          // The admin chose this password: the new user must replace it at first sign-in.
          mustChangePassword: true,
          createdById: actorId,
        },
      });
      this.logger.log({ userId: row.id, actorId }, 'user created');
      return toUserDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
  }

  /** Deactivation also revokes all of the target's sessions, atomically. */
  async update(id: string, input: UpdateUserRequest, actorId: string): Promise<User> {
    if (input.isActive === false && id === actorId) {
      throw new BadRequestException('You cannot deactivate yourself');
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('User not found');

      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      if (input.isActive === false) await tx.session.deleteMany({ where: { userId: id } });
      return updated;
    });

    this.logger.log({ userId: id, actorId, isActive: row.isActive }, 'user updated');
    return toUserDto(row);
  }

  /**
   * Sets a temporary password for another user (your own goes through change-password).
   * Signs the target out everywhere and forces a new password at their next sign-in, atomically.
   */
  async resetPassword(id: string, input: ResetPasswordRequest, actorId: string): Promise<User> {
    if (id === actorId) {
      throw new BadRequestException('Use "Change password" to change your own password');
    }
    const passwordHash = await hashPassword(input.newPassword);

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('User not found');

      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
      });
      await tx.session.deleteMany({ where: { userId: id } });
      return updated;
    });

    this.logger.log({ userId: id, actorId }, 'password reset by admin');
    return toUserDto(row);
  }
}
