import { type Server, type Socket, createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORAGE_CHECK_TIMEOUT_MS } from '../src/health/health.controller.js';
import { type TestApp, createTestApp } from './helpers.js';

/** Boots an app with these env overrides, GETs /api/health once, and closes it again. */
async function healthWith(env: NodeJS.ProcessEnv) {
  const t: TestApp = await createTestApp({ env });
  try {
    const started = Date.now();
    const res = await t.http().get('/api/health');
    return { status: res.status, body: res.body as unknown, ms: Date.now() - started };
  } finally {
    await t.close();
  }
}

describe('GET /api/health', () => {
  // Accepts connections and never answers: an endpoint that hangs.
  let silent: Server;
  const sockets: Socket[] = [];
  let silentPort = 0;

  beforeAll(async () => {
    silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    silentPort = address.port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });

  it('200 when the database and the bucket are reachable (no session needed)', async () => {
    expect(await healthWith({})).toMatchObject({
      status: 200,
      body: { status: 'ok', db: 'ok', storage: 'ok' },
    });
  });

  it('503 when the bucket does not exist', async () => {
    expect(await healthWith({ S3_BUCKET: 'camex-no-such-bucket' })).toMatchObject({
      status: 503,
      body: { status: 'error', db: 'ok', storage: 'error' },
    });
  });

  it('503 when the storage endpoint refuses connections', async () => {
    // Port 1 on loopback: nothing listens there.
    expect(await healthWith({ S3_ENDPOINT: 'http://127.0.0.1:1' })).toMatchObject({
      status: 503,
      body: { status: 'error', db: 'ok', storage: 'error' },
    });
  });

  it(`503 within the ${STORAGE_CHECK_TIMEOUT_MS} ms timeout when the storage endpoint hangs`, async () => {
    const result = await healthWith({ S3_ENDPOINT: `http://127.0.0.1:${silentPort}` });
    expect(result).toMatchObject({
      status: 503,
      body: { status: 'error', db: 'ok', storage: 'error' },
    });
    expect(result.ms).toBeGreaterThanOrEqual(STORAGE_CHECK_TIMEOUT_MS - 100);
    expect(result.ms).toBeLessThan(STORAGE_CHECK_TIMEOUT_MS + 1500);
    expect(sockets.length).toBeGreaterThan(0);
  });
});
