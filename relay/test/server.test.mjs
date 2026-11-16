import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { configFromEnvironment, createRelayServer } from '../server.mjs';
import { MemoryTransactionStore } from '../transaction-store.mjs';

const CONFIG = {
  clientId: 'Iv1.test-client', clientSecret: 'server-only-secret', appSlug: 'image-paste-test',
  publicBaseUrl: 'https://auth.example.test',
};
const PAIR = {
  access_token: 'ghu_test-access', token_type: 'bearer', expires_in: 28800,
  refresh_token: 'ghr_test-refresh', refresh_token_expires_in: 15897600,
};
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clientState = randomBytes(32).toString('base64url');

async function fixture(t, options = {}) {
  let time = 1700000000000;
  const calls = [];
  const server = createRelayServer({ ...CONFIG, ...options.config }, {
    store: options.store,
    now: () => time,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      return options.fetch ? options.fetch(url, init) : Response.json(PAIR);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const start = async () => {
    const result = await post('/auth/start', { codeChallenge: challenge, clientState });
    assert.equal(result.status, 200);
    return result.json();
  };
  const callback = (transaction, suffix = 'code=github-code') => {
    const state = new URL(transaction.authorizationUrl).searchParams.get('state');
    return fetch(`${base}/auth/callback?state=${state}&${suffix}`);
  };
  return { server, base, post, start, callback, calls, advance: (ms) => { time += ms; } };
}

test('config exposes only public App metadata and uses the configured origin', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/auth/config`, { headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    clientId: CONFIG.clientId, appSlug: CONFIG.appSlug,
    installationUrl: 'https://github.com/apps/image-paste-test/installations/new',
    callbackUrl: 'https://auth.example.test/auth/callback',
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await (await fetch(`${f.base}/health`)).json(), { status: 'ok' });
  assert.equal(f.calls.length, 0);
});

test('start creates distinct random IDs and sends S256, expiry scope, and fixed callback to GitHub', async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start();
  const authorize = new URL(first.authorizationUrl);
  assert.equal(authorize.origin, 'https://github.com');
  assert.equal(authorize.pathname, '/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), CONFIG.clientId);
  assert.equal(authorize.searchParams.get('code_challenge'), challenge);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('scope'), 'offline_access');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://auth.example.test/auth/callback');
  assert.notEqual(authorize.searchParams.get('state'), clientState);
  assert.notEqual(authorize.searchParams.get('state'), first.transactionId);
  assert.notEqual(first.transactionId, second.transactionId);
  assert.equal(first.expiresAt, 1700000600000);
  assert.ok(!first.authorizationUrl.includes(CONFIG.clientSecret));
});

test('callback only provides the fixed, escaped Obsidian link and cannot be replayed', async (t) => {
  const f = await fixture(t);
  const tx = await f.start();
  const response = await f.callback(tx, 'code=secret-code&error_description=%3Cscript%3Ebad%3C/script%3E');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`obsidian://image-paste-on-github-auth\\?transaction_id=${tx.transactionId}&amp;state=${clientState}`));
  assert.ok(!html.includes('secret-code'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes(verifier));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await f.callback(tx)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('complete verifies PKCE, preserves pending transactions, and returns only rotating token fields', async (t) => {
  const f = await fixture(t, { fetch: () => Response.json({ ...PAIR, scope: '', internal: 'do not forward' }) });
  const tx = await f.start();
  const body = { transactionId: tx.transactionId, codeVerifier: verifier };
  const pending = await f.post('/auth/complete', body);
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).error, 'authorization_pending');
  assert.equal((await f.post('/auth/complete', { ...body, codeVerifier: 'b'.repeat(64) })).status, 403);
  assert.equal(f.calls.length, 0);
  await f.callback(tx);
  const complete = await f.post('/auth/complete', body);
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), PAIR);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error');
  assert.ok(f.calls[0].signal instanceof AbortSignal);
  const form = new URLSearchParams(f.calls[0].body);
  assert.equal(form.get('client_secret'), CONFIG.clientSecret);
  assert.equal(form.get('client_id'), CONFIG.clientId);
  assert.equal(form.get('code'), 'github-code');
  assert.equal(form.get('code_verifier'), verifier);
  assert.equal(form.get('redirect_uri'), 'https://auth.example.test/auth/callback');
  assert.equal((await f.post('/auth/complete', body)).status, 404);
});

test('two simultaneous complete calls perform exactly one token exchange', async (t) => {
  let finish;
  let entered;
  const called = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { fetch: async () => { entered(); await gate; return Response.json(PAIR); } });
  const tx = await f.start();
  await f.callback(tx);
  const body = { transactionId: tx.transactionId, codeVerifier: verifier };
  const first = f.post('/auth/complete', body);
  await called;
  const second = await f.post('/auth/complete', body);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'transaction_consumed');
  assert.equal((await f.post('/auth/cancel', body)).status, 409);
  finish();
  assert.equal((await first).status, 200);
  assert.equal(f.calls.length, 1);
});

test('token exchange failure consumes the transaction and never reflects upstream secrets', async (t) => {
  const f = await fixture(t, { fetch: () => Response.json({ error: 'bad_verification_code', error_description: CONFIG.clientSecret }) });
  const tx = await f.start();
  await f.callback(tx);
  const body = { transactionId: tx.transactionId, codeVerifier: verifier };
  const response = await f.post('/auth/complete', body);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(CONFIG.clientSecret));
  assert.equal((await f.post('/auth/complete', body)).status, 404);
  assert.equal(f.calls.length, 1);
});

test('GitHub denial requires valid server state and becomes a sanitized user_denied error', async (t) => {
  const f = await fixture(t);
  const tx = await f.start();
  const wrong = await fetch(`${f.base}/auth/callback?state=${clientState}&error=access_denied`);
  assert.equal(wrong.status, 404);
  const response = await f.callback(tx, 'error=malicious%3Cscript%3E&error_description=server-only-secret');
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes('malicious'));
  const complete = await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: verifier });
  assert.equal(complete.status, 400);
  assert.equal((await complete.json()).error, 'user_denied');
  assert.equal(f.calls.length, 0);
});

test('cancel needs proof and removes the transaction without upstream calls', async (t) => {
  const f = await fixture(t);
  const tx = await f.start();
  assert.equal((await f.post('/auth/cancel', { transactionId: tx.transactionId, codeVerifier: 'b'.repeat(64) })).status, 403);
  assert.equal((await f.post('/auth/cancel', { transactionId: tx.transactionId, codeVerifier: verifier })).status, 204);
  assert.equal((await f.callback(tx)).status, 404);
  assert.equal(f.calls.length, 0);
});

test('transactions expire after ten minutes and pending capacity recovers', async (t) => {
  const f = await fixture(t, { config: { maxTransactions: 1 } });
  const tx = await f.start();
  assert.equal((await f.post('/auth/start', { codeChallenge: challenge, clientState })).status, 429);
  f.advance(600000);
  assert.equal((await f.callback(tx)).status, 404);
  assert.equal((await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: verifier })).status, 404);
  await f.start();
});

test('expiry is checked again after receiving the request body', async (t) => {
  const f = await fixture(t);
  const tx = await f.start();
  await f.callback(tx);
  // The relay handler is already awaiting readJson when this listener runs.
  f.server.once('request', () => f.advance(600000));
  const response = await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: verifier });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'transaction_not_found');
  assert.equal(f.calls.length, 0);
});

test('refresh forwards a form body with only fixed client credentials and returns rotated tokens', async (t) => {
  const f = await fixture(t);
  const response = await f.post('/auth/refresh', { refreshToken: 'ghr_old' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PAIR);
  const form = new URLSearchParams(f.calls[0].body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'ghr_old');
  assert.equal(form.get('client_secret'), CONFIG.clientSecret);
  assert.ok(!f.calls[0].url.includes('ghr_old'));
});

test('non-expiring or malformed token responses are rejected without leaking returned tokens', async (t) => {
  const f = await fixture(t, { fetch: () => Response.json({ access_token: 'sensitive-upstream', token_type: 'bearer' }) });
  const response = await f.post('/auth/refresh', { refreshToken: 'ghr_old' });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('sensitive-upstream'));
});

test('upstream failures, timeouts, invalid JSON, redirects, and large responses are sanitized', async (t) => {
  for (const kind of ['throw', 'timeout', 'invalid', 'redirect', 'large']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t, {
        config: { upstreamTimeoutMs: 10 },
        fetch: async (_url, init) => {
          if (kind === 'throw') throw new Error('server-only-secret');
          if (kind === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
          if (kind === 'invalid') return new Response('<html>server-only-secret</html>');
          if (kind === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.test' } });
          return new Response('x'.repeat(40000));
        },
      });
      const response = await f.post('/auth/refresh', { refreshToken: 'ghr_old' });
      assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes(CONFIG.clientSecret));
      assert.equal(f.calls.length, 1);
    });
  }
});

test('revoke uses fixed application token endpoint and Basic authentication, including already absent token', async (t) => {
  for (const status of [204, 404]) {
    const f = await fixture(t, { fetch: () => new Response(null, { status }) });
    assert.equal((await f.post('/auth/revoke', { accessToken: 'ghu_old' })).status, 204);
    assert.equal(f.calls[0].url, 'https://api.github.com/applications/Iv1.test-client/token');
    assert.equal(f.calls[0].method, 'DELETE');
    assert.equal(f.calls[0].headers.Authorization, `Basic ${Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64')}`);
    assert.deepEqual(JSON.parse(f.calls[0].body), { access_token: 'ghu_old' });
    assert.equal(f.calls[0].redirect, 'error');
  }
});

test('revocation errors remain errors rather than claiming success', async (t) => {
  const f = await fixture(t, { fetch: () => new Response(CONFIG.clientSecret, { status: 403 }) });
  const response = await f.post('/auth/revoke', { accessToken: 'ghu_old' });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(CONFIG.clientSecret));
});

test('upstream concurrency is bounded and recovers after the request finishes', async (t) => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const called = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { config: { maxUpstreamRequests: 1 }, fetch: async () => { entered(); await gate; return Response.json(PAIR); } });
  const pending = f.post('/auth/refresh', { refreshToken: 'ghr_one' });
  await called;
  const blocked = await f.post('/auth/revoke', { accessToken: 'ghu_one' });
  assert.equal(blocked.status, 429);
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await pending).status, 200);
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'ghr_two' })).status, 200);
});

test('rate limiting does not trust forwarded addresses and expires after a minute', async (t) => {
  const f = await fixture(t, { config: { rateLimit: 2 } });
  await f.start();
  await f.start();
  const limited = await f.post('/auth/start', { codeChallenge: challenge, clientState }, { 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  f.advance(60000);
  await f.start();
});

test('arbitrary browser origins are blocked, explicit allowlist never sends wildcard CORS', async (t) => {
  const f = await fixture(t, { config: { allowedOrigins: ['https://trusted.test'] } });
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'ghr_old' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal(f.calls.length, 0);
  const allowed = await f.post('/auth/refresh', { refreshToken: 'ghr_old' }, { Origin: 'https://trusted.test' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://trusted.test');
  const preflight = await fetch(`${f.base}/auth/refresh`, { method: 'OPTIONS', headers: { Origin: 'https://trusted.test' } });
  assert.equal(preflight.status, 204);
});

test('invalid input, extra properties, duplicate callbacks, and oversized bodies do not reach GitHub', async (t) => {
  const f = await fixture(t);
  for (const body of [null, [], {}, { codeChallenge: challenge, clientState, redirectUri: 'https://evil.test' }, { codeChallenge: [challenge], clientState }, { codeChallenge: challenge, clientState: '<script>' }]) {
    assert.equal((await f.post('/auth/start', body)).status, 400);
  }
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'bad\ntoken' })).status, 400);
  const malformed = await fetch(`${f.base}/auth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const big = await f.post('/auth/refresh', { refreshToken: 'x'.repeat(20000) });
  assert.equal(big.status, 413);
  const tx = await f.start();
  assert.equal((await f.callback(tx, 'code=one&code=two')).status, 400);
  assert.equal((await f.callback(tx, 'code=one&error=denied')).status, 400);
  assert.equal((await f.callback(tx)).status, 200);
  assert.equal(f.calls.length, 0);
});

test('chunked oversized bodies receive 413 without contacting GitHub', async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.base}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write('x'.repeat(9000));
    request.end('x'.repeat(9000));
  });
  assert.equal(status, 413);
  assert.equal(f.calls.length, 0);
});

test('configuration requires a server secret and a fixed HTTPS origin or explicit loopback development mode', () => {
  for (const patch of [
    { clientSecret: '' }, { publicBaseUrl: 'http://public.test' }, { publicBaseUrl: 'http://localhost:3000' },
    { publicBaseUrl: 'https://user:password@auth.test' }, { publicBaseUrl: 'https://auth.test/path' },
    { publicBaseUrl: 'https://auth.test?query=1' }, { appSlug: '../other' },
    { allowedOrigins: ['*'] }, { maxTransactions: 0 },
  ]) assert.throws(() => createRelayServer({ ...CONFIG, ...patch }));
  const server = createRelayServer({ ...CONFIG, publicBaseUrl: 'http://127.0.0.1:3000', allowHttpLoopback: true });
  server.emit('close');
  assert.deepEqual(configFromEnvironment({
    GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', GITHUB_APP_SLUG: 'slug', PUBLIC_BASE_URL: 'https://auth.test',
    ALLOWED_ORIGINS: 'https://one.test, https://two.test', ALLOW_HTTP_LOOPBACK: 'true',
  }), { clientId: 'id', clientSecret: 'secret', appSlug: 'slug', publicBaseUrl: 'https://auth.test', allowHttpLoopback: true, allowedOrigins: ['https://one.test', 'https://two.test'] });
});

test('an uncertain store claim commit never starts GitHub exchange or reuses the committed code', async (t) => {
  const store = new MemoryTransactionStore({ now: () => 1700000000000 });
  const claim = store.claim.bind(store);
  store.claim = async (...args) => {
    await claim(...args);
    throw new Error('database response lost with private diagnostic');
  };
  const f = await fixture(t, { store });
  const tx = await f.start();
  await f.callback(tx);
  const body = { transactionId: tx.transactionId, codeVerifier: verifier };
  const uncertain = await f.post('/auth/complete', body);
  assert.equal(uncertain.status, 503);
  assert.ok(!(await uncertain.text()).includes('private diagnostic'));
  assert.equal(store.transactions.get(tx.transactionId).status, 'consuming');
  assert.equal(store.transactions.get(tx.transactionId).code, undefined);
  assert.equal((await f.post('/auth/complete', body)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('failed cleanup leaves a consumed record and never turns a successful exchange into a second exchange', async (t) => {
  const store = new MemoryTransactionStore({ now: () => 1700000000000 });
  store.finish = async () => { throw new Error('cleanup unavailable'); };
  const f = await fixture(t, { store });
  const tx = await f.start();
  await f.callback(tx);
  const body = { transactionId: tx.transactionId, codeVerifier: verifier };
  const response = await f.post('/auth/complete', body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PAIR);
  assert.equal((await f.post('/auth/complete', body)).status, 409);
  assert.equal(store.transactions.get(tx.transactionId).status, 'consuming');
  assert.equal(store.transactions.get(tx.transactionId).code, undefined);
  assert.equal(f.calls.length, 1);
});

test('store outages return sanitized 503 responses without falling back to an instance-local login', async (t) => {
  const store = new MemoryTransactionStore();
  store.create = async () => { throw new Error('sensitive database connection metadata'); };
  const f = await fixture(t, { store });
  const response = await f.post('/auth/start', { codeChallenge: challenge, clientState });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'unavailable');
  assert.equal(store.transactions.size, 0);
  assert.equal(f.calls.length, 0);
});

test('a late successful claim after the deadline stays consumed and never starts GitHub exchange', async (t) => {
  const store = new MemoryTransactionStore({ now: () => 1700000000000 });
  const originalClaim = store.claim.bind(store);
  let release;
  let committed;
  const gate = new Promise((resolve) => { release = resolve; });
  const completed = new Promise((resolve) => { committed = resolve; });
  store.claim = async (...args) => {
    await gate;
    const result = await originalClaim(...args);
    committed();
    return result;
  };
  const f = await fixture(t, { store, config: { claimTimeoutMs: 10 } });
  const tx = await f.start();
  await f.callback(tx);
  const response = await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: verifier });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'unavailable');
  release();
  await completed;
  await new Promise(setImmediate);
  assert.equal(store.transactions.get(tx.transactionId).status, 'consuming');
  assert.equal(store.transactions.get(tx.transactionId).code, undefined);
  assert.equal(f.calls.length, 0);
  const retry = await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: verifier });
  assert.equal(retry.status, 409);
  assert.equal(f.calls.length, 0);
});

test('a store rejection after the claim deadline is handled without an unhandled rejection', async (t) => {
  const store = new MemoryTransactionStore({ now: () => 1700000000000 });
  let reject;
  store.claim = () => new Promise((_, no) => { reject = no; });
  const f = await fixture(t, { store, config: { claimTimeoutMs: 10 } });
  const tx = await f.start();
  const response = await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: verifier });
  assert.equal(response.status, 503);
  reject(new Error('late database failure'));
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 0);
});

test('a disconnected client does not start an exchange after the claim commits and the claim is cleaned up', async (t) => {
  const store = new MemoryTransactionStore({ now: () => 1700000000000 });
  const originalClaim = store.claim.bind(store);
  let release;
  let entered;
  let finished;
  const gate = new Promise((resolve) => { release = resolve; });
  const called = new Promise((resolve) => { entered = resolve; });
  const cleanup = new Promise((resolve) => { finished = resolve; });
  store.claim = async (...args) => { entered(); await gate; return originalClaim(...args); };
  const originalFinish = store.finish.bind(store);
  store.finish = async (id) => { await originalFinish(id); finished(); };
  const f = await fixture(t, { store });
  const tx = await f.start();
  await f.callback(tx);
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  f.server.once('request', (_request, response) => response.once('close', disconnected));
  const request = httpRequest(`${f.base}/auth/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ transactionId: tx.transactionId, codeVerifier: verifier }));
  await called;
  request.destroy();
  await closed;
  release();
  await cleanup;
  assert.equal(store.transactions.has(tx.transactionId), false);
  assert.equal(f.calls.length, 0);
});
