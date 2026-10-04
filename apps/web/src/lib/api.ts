import type { z } from 'zod';

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

function messageFrom(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

async function send(path: string, { method = 'GET', body }: RequestOptions): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.", null);
  }

  const data: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new ApiError(res.status, messageFrom(data) ?? `Request failed (${res.status})`, data);
  }
  return data;
}

/** JSON request whose response is parsed with a schema from @camex/shared. */
export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  return schema.parse(await send(path, options));
}

/** Request whose response has no body (204). */
export async function apiNoContent(path: string, options: RequestOptions): Promise<void> {
  await send(path, options);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
