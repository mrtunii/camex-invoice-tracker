/**
 * Creates an admin user. The only way to create the first user (there is no signup endpoint).
 *
 *   pnpm create-admin --email ops@camex.aero --name "Ops Admin"            # prompts for the password
 *   pnpm create-admin --email ops@camex.aero --name "Ops Admin" --password '…'   # for scripts
 */
import { parseArgs } from 'node:util';
import { emailSchema, newPasswordSchema, userNameSchema } from '@camex/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import type { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { envSchema, loadRootEnvFile } from '../config/env.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

const USAGE =
  'Usage: pnpm create-admin --email <email> --name <name> [--password <password>]\n' +
  'Without --password you are prompted for it (requires an interactive terminal).';

class CliError extends Error {}

function check<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CliError(`${label}: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

/** Input typed or pasted ahead of the next prompt (e.g. both passwords pasted at once). */
let typeahead = '';

/** Reads a line from the TTY without echoing it. */
function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      // Code points (not UTF-16 units) so backspace never splits a surrogate pair.
      const chars = Array.from(chunk);
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i] ?? '';
        if (char === '\r' || char === '\n') {
          if (char === '\r' && chars[i + 1] === '\n') i++;
          typeahead = chars.slice(i + 1).join('');
          finish();
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          finish(new CliError('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
    if (typeahead) {
      const buffered = typeahead;
      typeahead = '';
      onData(buffered);
    }
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError('No interactive terminal to prompt for a password; pass --password.');
  }
  const password = await promptHidden('Password: ');
  check(newPasswordSchema, password, 'Password');
  if ((await promptHidden('Repeat password: ')) !== password) {
    throw new CliError('Passwords do not match.');
  }
  return password;
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.email === undefined || values.name === undefined) throw new CliError(USAGE);

  const email = check(emailSchema, values.email, 'Email');
  const name = check(userNameSchema, values.name, 'Name');

  loadRootEnvFile();
  const { DATABASE_URL } = check(
    envSchema.pick({ DATABASE_URL: true }),
    process.env,
    'Environment',
  );
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

  try {
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new CliError(`A user with email ${email} already exists.`);
    }
    const password = check(
      newPasswordSchema,
      values.password ?? (await readPassword()),
      'Password',
    );

    const user = await prisma.user
      .create({ data: { email, name, passwordHash: await hashPassword(password) } })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new CliError(`A user with email ${email} already exists.`);
        }
        throw error;
      });
    console.log(`Created admin ${user.email} (${user.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

function isUsageError(error: unknown): error is Error {
  if (error instanceof CliError) return true;
  // parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes for unknown/invalid flags.
  return (
    error instanceof TypeError &&
    String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(isUsageError(error) ? error.message : error);
  process.exitCode = 1;
});
