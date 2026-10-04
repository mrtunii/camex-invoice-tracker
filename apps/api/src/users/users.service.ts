import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CreateUserRequest, UpdateUserRequest, User } from '@camex/shared';
import { hashPassword } from '../auth/password.js';
import { Prisma } from '../generated/prisma/client.js';
import type { User as UserRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
}
