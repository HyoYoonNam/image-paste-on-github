import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createWorker } from '../worker.mjs';
import { StoreError } from '../d1-store.mjs';
import { MemoryTransactionStore } from './helpers/memory-store.mjs';

const BASE = 'https://auth.example.test';
const ENV = {
  AUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE,
  GITHUB_CLIENT_ID: 'Iv1.worker-client', GITHUB_CLIENT_SECRET: 'server-only-secret', GITHUB_APP_SLUG: 'image-paste-test',
};
const PAIR = {
  access_token: 'ghu_worker-access', token_type: 'bearer', expires_in: 28800,
  refresh_token: 'ghr_worker-refresh', refresh_token_expires_in: 15897600,
};
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clientState = 'b'.repeat(43);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  let time = 1700000000000;
  const calls = [], background = [];
  const memory = new MemoryTransactionStore({ now: () => time });
  const store = {};
  for (const method of ['create', 'callback', 'claim', 'cancel', 'finish']) {
    store[method] = async (...args) => {
      try { return await memory[method](...args); }
      catch (error) { if (error.code) throw new StoreError(error.status, error.code); throw error; }
    };
  }
  store.cleanup = async () => { memory.prune(); };
  const env = { ...ENV, ...options.env };
  let creations = 0;
  const worker = createWorker({
    ...options.limits,
    now: () => time,
    createStore: () => { creations++; return store; },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      return options.fetch ? options.fetch(url, init) : Response.json(PAIR);
    },
  });
  const context = { waitUntil: (promise) => background.push(promise) };
  const send = (path, init = {}) => worker.fetch(new Request(`${BASE}${path}`, init), env, context);
  const post = (path, body, init = {}) => send(path, { method: 'POST', ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers }, body: JSON.stringify(body) });
  const start = async () => {
    const response = await post('/auth/start', { codeChallenge: challenge, clientState });
    assert.equal(response.status, 200);
    return response.json();
  };
  const callback = (transaction, suffix = 'code=github-secret-code') => send(`/auth/callback?state=${new URL(transaction.authorizationUrl).searchParams.get('state')}&${suffix}`);
  const complete = (transaction, init) => post('/auth/complete', { transactionId: transaction.transactionId, codeVerifier: verifier }, init);
  return { worker, env, store, memory, calls, context, send, post, start, callback, complete,
    creations: () => creations, flush: () => Promise.all(background), advance: (ms) => { time += ms; } };
}

test('auth is disabled by default and health works without any credentials or D1 access', async () => {
  for (const AUTH_ENABLED of [undefined, 'false', 'TRUE', true]) {
    const f = fixture({ env: { AUTH_ENABLED, GITHUB_CLIENT_SECRET: undefined } });
    const health = await f.send('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    for (const path of ['/auth/config', '/auth/callback?code=private-code', '/auth/start', '/auth/refresh']) {
      const response = await f.send(path);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'unavailable', message: 'The authentication service is temporarily unavailable.' });
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(f.creations(), 0);
    assert.equal(f.calls.length, 0);
  }
});

test('public config comes from the fixed deployment origin and never exposes the secret', async () => {
  const f = fixture();
  const response = await f.send('/auth/config', { headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test' } });
  assert.deepEqual(await response.json(), {
    clientId: ENV.GITHUB_CLIENT_ID, appSlug: ENV.GITHUB_APP_SLUG,
    installationUrl: 'https://github.com/apps/image-paste-test/installations/new', callbackUrl: `${BASE}/auth/callback`,
  });
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.equal(f.creations(), 0);
  assert.equal(f.calls.length, 0);
});

test('invalid configuration fails closed without reflecting environment values', async () => {
  for (const env of [{ GITHUB_CLIENT_SECRET: '' }, { PUBLIC_BASE_URL: 'http://remote.test' }, { PUBLIC_BASE_URL: 'https://auth.test/private' }, { GITHUB_APP_SLUG: '../other' }, { ALLOWED_ORIGINS: '*' }]) {
    const f = fixture({ env });
    const response = await f.send('/auth/config');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'unavailable');
    assert.equal(f.creations(), 0);
  }
});

test('PKCE flow, pending retry, callback HTML, one-time exchange and rotating token fields match the plugin API', async () => {
  const f = fixture({ fetch: () => Response.json({ ...PAIR, private_extra: 'not-forwarded' }) });
  const tx = await f.start();
  const authorization = new URL(tx.authorizationUrl);
  assert.equal(authorization.origin, 'https://github.com');
  assert.equal(authorization.pathname, '/login/oauth/authorize');
  assert.equal(authorization.searchParams.get('redirect_uri'), `${BASE}/auth/callback`);
  assert.equal(authorization.searchParams.get('code_challenge'), challenge);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), 'offline_access');
  assert.notEqual(authorization.searchParams.get('state'), clientState);
  assert.notEqual(authorization.searchParams.get('state'), tx.transactionId);
  assert.equal(tx.expiresAt, 1700000600000);
  const pending = await f.complete(tx);
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).error, 'authorization_pending');
  const callback = await f.callback(tx, 'code=github-secret-code&error_description=%3Cscript%3Ebad%3C/script%3E');
  const html = await callback.text();
  assert.equal(callback.status, 200);
  assert.match(html, new RegExp(`obsidian://image-paste-on-github-auth\\?transaction_id=${tx.transactionId}&amp;state=${clientState}`));
  for (const value of ['github-secret-code', 'server-only-secret', '<script>', verifier]) assert.ok(!html.includes(value));
  assert.equal((await f.callback(tx)).status, 409);
  assert.equal((await f.post('/auth/complete', { transactionId: tx.transactionId, codeVerifier: 'z'.repeat(64) })).status, 403);
  assert.equal(f.calls.length, 0);
  const response = await f.complete(tx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PAIR);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, 'https://github.com/login/oauth/access_token');
  assert.equal(call.redirect, 'manual');
  assert.equal(call.method, 'POST');
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('code'), 'github-secret-code');
  assert.equal(form.get('code_verifier'), verifier);
  assert.equal(form.get('client_secret'), ENV.GITHUB_CLIENT_SECRET);
  assert.equal(form.get('redirect_uri'), `${BASE}/auth/callback`);
  await f.flush();
  assert.equal((await f.complete(tx)).status, 404);
});

test('concurrent completion performs one GitHub exchange', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ fetch: async () => { entered.resolve(); await gate.promise; return Response.json(PAIR); } });
  const tx = await f.start();
  await f.callback(tx);
  const first = f.complete(tx);
  await entered.promise;
  assert.equal((await f.complete(tx)).status, 409);
  assert.equal(f.calls.length, 1);
  gate.resolve();
  assert.equal((await first).status, 200);
  await f.flush();
});

test('denial, cancellation, and expiry cannot exchange codes', async () => {
  const f = fixture();
  const denied = await f.start();
  const callback = await f.callback(denied, 'error=unknown%3Cscript%3E&error_description=private-upstream-text');
  assert.ok(!(await callback.text()).includes('private-upstream-text'));
  const response = await f.complete(denied);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'user_denied');
  const cancelled = await f.start();
  assert.equal((await f.post('/auth/cancel', { transactionId: cancelled.transactionId, codeVerifier: verifier })).status, 204);
  assert.equal((await f.callback(cancelled)).status, 404);
  const expired = await f.start();
  f.advance(600000);
  assert.equal((await f.complete(expired)).status, 404);
  assert.equal(f.calls.length, 0);
  await f.flush();
});

test('refresh and revoke use fixed upstreams, body credentials, and treat already absent token as revoked', async () => {
  const f = fixture({ fetch: (url) => url.includes('/applications/') ? new Response(null, { status: 404 }) : Response.json(PAIR) });
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'old-refresh' })).status, 200);
  const form = new URLSearchParams(f.calls[0].body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'old-refresh');
  assert.equal(form.get('client_id'), ENV.GITHUB_CLIENT_ID);
  assert.equal((await f.post('/auth/revoke', { accessToken: 'old-access' })).status, 204);
  assert.equal(f.calls[1].url, 'https://api.github.com/applications/Iv1.worker-client/token');
  assert.equal(f.calls[1].method, 'DELETE');
  assert.equal(f.calls[1].headers.Authorization, `Basic ${btoa(`${ENV.GITHUB_CLIENT_ID}:${ENV.GITHUB_CLIENT_SECRET}`)}`);
  assert.deepEqual(JSON.parse(f.calls[1].body), { access_token: 'old-access' });
  assert.ok(f.calls.every((call) => !call.url.includes('old-')));
});

test('database failures and quota exhaustion become static 503 responses', async () => {
  const f = fixture();
  f.store.create = async () => { throw new Error('D1_ERROR quota exceeded, private SQL and secret'); };
  const response = await f.post('/auth/start', { codeChallenge: challenge, clientState });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), JSON.stringify({ error: 'unavailable', message: 'The authentication service is temporarily unavailable.' }));
  assert.equal(f.calls.length, 0);
});

test('an uncertain claim commit leaves the login consumed without starting GitHub', async () => {
  const f = fixture();
  const original = f.store.claim;
  f.store.claim = async (...args) => { await original(...args); throw new Error('private acknowledgement failure'); };
  const tx = await f.start();
  await f.callback(tx);
  assert.equal((await f.complete(tx)).status, 503);
  assert.equal(f.memory.transactions.get(tx.transactionId).status, 'consuming');
  assert.equal(f.memory.transactions.get(tx.transactionId).code, undefined);
  assert.equal((await f.complete(tx)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('claim timeout never exchanges a later committed code and handles a late rejection', async () => {
  for (const rejects of [false, true]) {
    const gate = deferred(), completed = deferred();
    const f = fixture({ limits: { claimTimeoutMs: 5 } });
    const original = f.store.claim;
    f.store.claim = async (...args) => {
      await gate.promise;
      if (rejects) { completed.resolve(); throw new Error('late private failure'); }
      const result = await original(...args);
      completed.resolve();
      return result;
    };
    const tx = await f.start();
    await f.callback(tx);
    assert.equal((await f.complete(tx)).status, 503);
    gate.resolve();
    await completed.promise;
    await new Promise(setImmediate);
    if (!rejects) assert.equal(f.memory.transactions.get(tx.transactionId).status, 'consuming');
    assert.equal(f.calls.length, 0);
  }
});

test('client abort before claim returns skips GitHub and cleans up the consumed login', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture();
  const original = f.store.claim;
  f.store.claim = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const tx = await f.start();
  await f.callback(tx);
  const controller = new AbortController();
  const response = f.complete(tx, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  assert.equal((await response).status, 503);
  await f.flush();
  assert.equal(f.memory.transactions.has(tx.transactionId), false);
  assert.equal(f.calls.length, 0);
});

test('cleanup failure after success never discards a token response or permits a second exchange', async () => {
  const f = fixture();
  f.store.finish = async () => { throw new Error('private cleanup failure'); };
  const tx = await f.start();
  await f.callback(tx);
  assert.equal((await f.complete(tx)).status, 200);
  await f.flush();
  assert.equal((await f.complete(tx)).status, 409);
  assert.equal(f.calls.length, 1);
});

test('upstream errors, invalid JSON, redirects, oversized responses, malformed tokens, and timeouts are redacted', async () => {
  for (const kind of ['throw', 'invalid', 'redirect', 'large', 'tokens', 'timeout']) {
    const f = fixture({ limits: { upstreamTimeoutMs: 5 }, fetch: async (_url, init) => {
      if (kind === 'throw') throw new Error('private upstream detail');
      if (kind === 'invalid') return new Response('<private-upstream>');
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
      if (kind === 'large') return new Response('x'.repeat(40000));
      if (kind === 'tokens') return Response.json({ access_token: 'private-access', token_type: 'bearer' });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    } });
    const response = await f.post('/auth/refresh', { refreshToken: 'old-refresh' });
    assert.equal(response.status, 502, kind);
    const content = await response.text();
    assert.ok(!content.includes('private'), kind);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].redirect, 'manual');
    assert.equal(f.calls[0].url, 'https://github.com/login/oauth/access_token');
  }
});

test('requests reject unknown fields, missing JSON, repeated callback fields, and bodies above 16 KiB', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { codeChallenge: challenge, clientState, redirectUri: 'https://evil.test' }, { codeChallenge: [challenge], clientState }]) {
    assert.equal((await f.post('/auth/start', body)).status, 400);
  }
  assert.equal((await f.send('/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'token\ninjection' })).status, 400);
  const tx = await f.start();
  assert.equal((await f.callback(tx, 'code=one&code=two')).status, 400);
  assert.equal((await f.callback(tx, 'code=one&error=denied')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('a streamed request is size-limited even without Content-Length', async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(10000)); },
    cancel() { cancelled = true; },
  });
  const response = await f.send('/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 0);
});

test('CORS is opt-in and arbitrary browser origins never reach GitHub', async () => {
  const f = fixture({ env: { ALLOWED_ORIGINS: 'https://trusted.test' } });
  const blocked = await f.post('/auth/refresh', { refreshToken: 'token' }, { headers: { Origin: 'https://evil.test' } });
  assert.equal(blocked.status, 403);
  assert.equal(f.calls.length, 0);
  const allowed = await f.send('/auth/config', { headers: { Origin: 'https://trusted.test' } });
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://trusted.test');
  const preflight = await f.send('/auth/refresh', { method: 'OPTIONS', headers: { Origin: 'https://trusted.test' } });
  assert.equal(preflight.status, 204);
});

test('per-isolate rate limit ignores X-Forwarded-For and expires after a minute', async () => {
  const f = fixture({ limits: { rateLimit: 2 } });
  await f.start();
  await f.start();
  const response = await f.post('/auth/start', { codeChallenge: challenge, clientState }, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  f.advance(60000);
  await f.start();
});

test('upstream concurrency is bounded per isolate', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ limits: { maxUpstreamRequests: 1 }, fetch: async () => { entered.resolve(); await gate.promise; return Response.json(PAIR); } });
  const first = f.post('/auth/refresh', { refreshToken: 'one' });
  await entered.promise;
  assert.equal((await f.post('/auth/refresh', { refreshToken: 'two' })).status, 429);
  gate.resolve();
  assert.equal((await first).status, 200);
  assert.equal(f.calls.length, 1);
});

test('scheduled events only request bounded expired-row cleanup, including when auth is disabled', async () => {
  const f = fixture({ env: { AUTH_ENABLED: 'false' } });
  const cleanupCalls = [];
  f.store.cleanup = async (options) => { cleanupCalls.push(options); throw new Error('quota private diagnostic'); };
  await f.worker.scheduled({}, f.env, f.context);
  await f.flush();
  assert.deepEqual(cleanupCalls, [{ limit: 200 }]);
  assert.equal(f.calls.length, 0);
});
