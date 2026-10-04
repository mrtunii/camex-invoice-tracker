import { Prisma } from '../generated/prisma/client.js';

/** Unique-constraint violation (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
