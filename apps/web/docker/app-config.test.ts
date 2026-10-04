// Unit test for the container-start config generator (40-app-config.sh). Runs the real script with
// sh, then evaluates the config.js it wrote the way a browser would. `pnpm --filter @camex/web test`.
// (node:test's describe/it return promises the runner awaits itself, hence `void`.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

const SCRIPT = join(import.meta.dirname, '40-app-config.sh');
const dir = mkdtempSync(join(tmpdir(), 'camex-app-config-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

let runs = 0;

/** Runs the generator with exactly `env` (plus PATH); returns its exit code, stderr and output. */
function generate(env: Record<string, string>) {
  const file = join(dir, `config-${String(++runs)}.js`);
  const result = spawnSync('sh', [SCRIPT], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', APP_CONFIG_FILE: file, ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    written: existsSync(file),
    source: existsSync(file) ? readFileSync(file, 'utf8') : '',
  };
}

/** What the SPA sees: window.__APP_CONFIG__ after the browser ran config.js. */
function evaluate(source: string): { config: unknown; sandbox: Record<string, unknown> } {
  const sandbox: Record<string, unknown> = { window: {} };
  runInNewContext(source, sandbox);
  const config = (sandbox.window as Record<string, unknown>).__APP_CONFIG__;
  // Copied into this realm: objects from the sandbox have another Object prototype.
  return { config: JSON.parse(JSON.stringify(config)) as unknown, sandbox };
}

void describe('40-app-config.sh', () => {
  void it('writes apiBaseUrl (trailing slashes dropped) and inboxAddress', () => {
    const out = generate({
      API_BASE_URL: 'https://api.camex-fin.site//',
      INBOX_ADDRESS: 'invoices@mg.camex-fin.site',
    });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(evaluate(out.source).config, {
      apiBaseUrl: 'https://api.camex-fin.site',
      inboxAddress: 'invoices@mg.camex-fin.site',
    });
  });

  void it('inboxAddress is null when INBOX_ADDRESS is unset or empty', () => {
    for (const env of [{}, { INBOX_ADDRESS: '' }] as Record<string, string>[]) {
      const out = generate({ API_BASE_URL: 'https://api.camex-fin.site', ...env });
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(evaluate(out.source).config, {
        apiBaseUrl: 'https://api.camex-fin.site',
        inboxAddress: null,
      });
    }
  });

  void it('JSON-escapes values: quotes, backslashes and script-like text stay data', () => {
    const tricky = [
      'a"b\\c',
      '"; globalThis.pwned = true; "',
      "'}; globalThis.pwned = true; //",
      '\\"; globalThis.pwned = true; //',
      '</script><script>globalThis.pwned = true</script>',
      'счета@почта.рф ინვოისი',
      '$(touch /tmp/x) `id` ${HOME}',
    ];
    for (const value of tricky) {
      const out = generate({ API_BASE_URL: 'https://api.camex-fin.site', INBOX_ADDRESS: value });
      assert.equal(out.status, 0, out.stderr);
      const { config, sandbox } = evaluate(out.source);
      assert.deepEqual(config, { apiBaseUrl: 'https://api.camex-fin.site', inboxAddress: value });
      assert.equal(sandbox.pwned, undefined, `executed code from ${value}`);
    }
  });

  void it('fails without API_BASE_URL (unset or empty), writing nothing', () => {
    for (const env of [{}, { API_BASE_URL: '' }] as Record<string, string>[]) {
      const out = generate(env);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /API_BASE_URL is required/);
      assert.equal(out.written, false);
    }
  });

  void it('requires an absolute https URL (http only for localhost)', () => {
    for (const value of [
      'api.camex-fin.site',
      '/api',
      'http://api.camex-fin.site',
      'ftp://api.camex-fin.site',
      'https://api.camex-fin.site/ x',
    ]) {
      const out = generate({ API_BASE_URL: value });
      assert.notEqual(out.status, 0, value);
      assert.equal(out.written, false, value);
    }
    for (const value of ['http://localhost:3190', 'http://127.0.0.1:3190/']) {
      const out = generate({ API_BASE_URL: value });
      assert.equal(out.status, 0, out.stderr);
    }
  });

  void it('refuses control characters (a newline would end the JS string)', () => {
    for (const env of [
      { API_BASE_URL: 'https://api.camex-fin.site', INBOX_ADDRESS: 'a\nb' },
      { API_BASE_URL: 'https://api.camex-fin.site', INBOX_ADDRESS: 'a\tb' },
    ]) {
      const out = generate(env);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /control characters/);
      assert.equal(out.written, false);
    }
  });
});
