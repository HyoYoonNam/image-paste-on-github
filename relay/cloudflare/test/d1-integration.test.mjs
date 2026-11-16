import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://auth.example.test';
const environment = {
  AUTH_ENABLED: 'true', APP_NAMESPACE: 'integration_auth', PUBLIC_BASE_URL: origin,
  GITHUB_CLIENT_ID: 'Iv1.integration-test', GITHUB_CLIENT_SECRET: 'mock-server-secret', GITHUB_APP_SLUG: 'image-paste-test',
};
const pair = {
  access_token: 'mock-integration-access', token_type: 'bearer', expires_in: 28800,
  refresh_token: 'mock-integration-refresh', refresh_token_expires_in: 15897600,
};
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clientState = randomBytes(32).toString('base64url');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { upstream } = {}) {
  const calls = [];
  const modules = await Promise.all(['worker.mjs', 'd1-store.mjs'].map(async name => ({
    type: 'ESModule', path: fileURLToPath(new URL(`../${name}`, import.meta.url)),
    contents: await readFile(new URL(`../${name}`, import.meta.url), 'utf8'),
  })));
  const runtime = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: ['first', 'second', 'disabled'].map(name => ({
      name, modules, scriptPath: fileURLToPath(new URL('../worker.mjs', import.meta.url)),
      compatibilityDate: '2026-11-13',
      bindings: { ...environment, AUTH_ENABLED: name === 'disabled' ? 'false' : 'true' },
      d1Databases: { DB: 'local-worker-integration' },
      outboundService: async request => {
        const call = { url: request.url, method: request.method, body: await request.text(), headers: Object.fromEntries(request.headers) };
        calls.push(call);
        if (upstream) return upstream(call);
        if (request.url === 'https://github.com/login/oauth/access_token') return RuntimeResponse.json(pair);
        if (request.url === 'https://api.github.com/applications/Iv1.integration-test/token') {
          // GitHub REST rejects API requests without a User-Agent.
          return new RuntimeResponse(null, { status: request.headers.get('User-Agent') ? 204 : 403 });
        }
        throw new Error('Unexpected outbound destination in local test');
      },
    })),
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB', 'first');
  const migration = await readFile(new URL('../migrations/0001_auth_transactions.sql', import.meta.url), 'utf8');
  await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const [first, second, disabled] = await Promise.all(['first', 'second', 'disabled'].map(name => runtime.getWorker(name)));
  const post = (worker, path, body) => worker.fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    runtime, db, first, second, disabled, post, calls,
    proof: transaction => ({ transactionId: transaction.transactionId, codeVerifier: verifier }),
    async start(worker = first) {
      const response = await post(worker, '/auth/start', { codeChallenge: challenge, clientState });
      assert.equal(response.status, 200); return response.json();
    },
    callback(worker, transaction, suffix = 'code=mock-authorization-code') {
      const state = new URL(transaction.authorizationUrl).searchParams.get('state');
      return worker.fetch(`${origin}/auth/callback?state=${state}&${suffix}`);
    },
  };
}

test('workerd and real local D1 enforce the complete Worker authentication flow', { timeout: 60000 }, async t => {
  await t.test('bootstrap exposes health but cannot start authentication', async t => {
    const f = await fixture(t);
    assert.deepEqual(await (await f.disabled.fetch(`${origin}/health`)).json(), { status: 'ok' });
    assert.equal((await f.post(f.disabled, '/auth/start', { codeChallenge: challenge, clientState })).status, 503);
    const config = await f.first.fetch(`${origin}/auth/config`);
    assert.equal(config.status, 200);
    assert.equal((await config.json()).callbackUrl, `${origin}/auth/callback`);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM auth_transactions').first()).count, 0);
    assert.equal(f.calls.length, 0);
  });

  await t.test('another isolate handles the callback and one PKCE exchange returns the original contract', async t => {
    const f = await fixture(t);
    const transaction = await f.start();
    const pending = await f.post(f.second, '/auth/complete', f.proof(transaction));
    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).error, 'authorization_pending');
    const callback = await f.callback(f.second, transaction);
    const html = await callback.text();
    assert.equal(callback.status, 200);
    assert.match(html, new RegExp(`transaction_id=${transaction.transactionId}&amp;state=${clientState}`));
    assert.doesNotMatch(html, /mock-authorization-code|mock-server-secret|mock-integration-access/);
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.match(callback.headers.get('content-security-policy'), /default-src 'none'/);
    const completed = await f.post(f.first, '/auth/complete', f.proof(transaction));
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), pair);
    assert.equal(f.calls.length, 1);
    const form = new URLSearchParams(f.calls[0].body);
    assert.equal(form.get('code_verifier'), verifier);
    assert.equal(form.get('code'), 'mock-authorization-code');
    assert.equal(form.get('redirect_uri'), `${origin}/auth/callback`);
    assert.ok([404, 409].includes((await f.post(f.second, '/auth/complete', f.proof(transaction))).status));
    assert.equal(f.calls.length, 1);
  });

  await t.test('simultaneous callbacks and complete requests across isolates perform one exchange', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { upstream: async call => {
      assert.equal(call.url, 'https://github.com/login/oauth/access_token');
      entered.resolve(); await release.promise; return RuntimeResponse.json(pair);
    } });
    const transaction = await f.start();
    const callbacks = await Promise.all([f.callback(f.first, transaction), f.callback(f.second, transaction)]);
    assert.deepEqual(callbacks.map(response => response.status).sort(), [200, 409]);
    const first = f.post(f.first, '/auth/complete', f.proof(transaction));
    const second = f.post(f.second, '/auth/complete', f.proof(transaction));
    try {
      await Promise.race([entered.promise, Promise.all([first, second]).then(responses => {
        assert.fail(`No upstream exchange started; completion statuses: ${responses.map(response => response.status).join(', ')}`);
      })]);
      const duplicate = await Promise.race([first, second]);
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).error, 'transaction_consumed');
      const stored = await f.db.prepare('SELECT status, code FROM auth_transactions WHERE transaction_id = ?').bind(transaction.transactionId).first();
      assert.deepEqual(stored, { status: 'consuming', code: null });
      assert.equal(f.calls.length, 1);
    } finally {
      release.resolve();
      assert.deepEqual((await Promise.all([first, second])).map(response => response.status).sort(), [200, 409]);
    }
    assert.equal(f.calls.length, 1);
  });

  await t.test('wrong proof preserves the login, while cancellation and denial prevent exchange', async t => {
    const f = await fixture(t);
    const transaction = await f.start();
    assert.equal((await f.callback(f.second, transaction)).status, 200);
    assert.equal((await f.post(f.second, '/auth/complete', { transactionId: transaction.transactionId, codeVerifier: 'b'.repeat(64) })).status, 403);
    assert.equal((await f.post(f.first, '/auth/cancel', f.proof(transaction))).status, 204);
    assert.equal((await f.post(f.second, '/auth/complete', f.proof(transaction))).status, 404);
    const denied = await f.start();
    assert.equal((await f.callback(f.second, denied, 'error=access_denied')).status, 200);
    const response = await f.post(f.first, '/auth/complete', f.proof(denied));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'user_denied');
    assert.equal(f.calls.length, 0);
  });

  await t.test('expired rows are rejected before the scheduled cleanup deletes them', async t => {
    const f = await fixture(t);
    const expired = await f.start(), active = await f.start();
    await f.db.prepare('UPDATE auth_transactions SET expires_at = ? WHERE transaction_id = ?').bind(Date.now() - 1, expired.transactionId).run();
    assert.equal((await f.post(f.second, '/auth/complete', f.proof(expired))).status, 404);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM auth_transactions').first()).count, 2);
    await f.disabled.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() });
    const remaining = await f.db.prepare('SELECT transaction_id FROM auth_transactions').all();
    assert.deepEqual(remaining.results, [{ transaction_id: active.transactionId }]);
    assert.equal(f.calls.length, 0);
  });

  await t.test('refresh and revoke use only fixed GitHub endpoints without creating session rows', async t => {
    const f = await fixture(t);
    const refresh = await f.post(f.first, '/auth/refresh', { refreshToken: 'mock-old-refresh' });
    assert.equal(refresh.status, 200);
    assert.deepEqual(await refresh.json(), pair);
    const form = new URLSearchParams(f.calls[0].body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'mock-old-refresh');
    assert.equal((await f.post(f.second, '/auth/revoke', { accessToken: pair.access_token })).status, 204);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].method, 'DELETE');
    assert.equal(f.calls[1].url, 'https://api.github.com/applications/Iv1.integration-test/token');
    assert.deepEqual(JSON.parse(f.calls[1].body), { access_token: pair.access_token });
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM auth_transactions').first()).count, 0);
  });

  await t.test('GitHub redirects fail without following a second destination or retrying the code', async t => {
    const f = await fixture(t, { upstream: async () => new RuntimeResponse(null, {
      status: 302, headers: { Location: 'https://untrusted.example.test/collect' },
    }) });
    const transaction = await f.start();
    assert.equal((await f.callback(f.second, transaction)).status, 200);
    const response = await f.post(f.first, '/auth/complete', f.proof(transaction));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'github_error');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://github.com/login/oauth/access_token');
    assert.ok([404, 409].includes((await f.post(f.second, '/auth/complete', f.proof(transaction))).status));
    assert.equal(f.calls.length, 1);
  });
});
