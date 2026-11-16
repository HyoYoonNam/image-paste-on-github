import { D1TransactionStore, StoreError } from './d1-store.mjs';

const TTL_MS = 600000;
const BODY_LIMIT = 16 * 1024;
const UPSTREAM_LIMIT = 32 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const MESSAGES = {
  invalid_request: 'The request is invalid.',
  invalid_proof: 'The authentication proof is invalid.',
  transaction_not_found: 'This login has expired or was cancelled. Start a new login.',
  transaction_consumed: 'This login was already used. Start a new login.',
  authorization_pending: 'Finish authorizing the app in your browser.',
  user_denied: 'GitHub authorization was not completed. Start a new login.',
  github_error: 'GitHub could not complete this request. Start a new login if needed.',
  rate_limited: 'Too many authentication requests. Try again later.',
  body_too_large: 'The request is too large.',
  origin_not_allowed: 'This browser origin is not allowed.',
  not_found: 'This endpoint does not exist.',
  unavailable: 'The authentication service is temporarily unavailable.',
};

class HttpError extends Error {
  constructor(status, code = 'invalid_request') {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code) => { throw new HttpError(status, code); };
const text = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x20\x7f]/.test(value);
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function exactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) fail(400);
}

function securityHeaders() {
  return new Headers({
    'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
}

function json(status, body, headers) {
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

async function boundedJson(body, maximum, status, code) {
  if (!body) fail(status === 413 ? 400 : status, status === 413 ? 'invalid_request' : code);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) fail(status, code);
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    try { return JSON.parse(content); } catch { fail(status === 413 ? 400 : status, status === 413 ? 'invalid_request' : code); }
  } finally {
    // Do not wait for an untrusted stream's cancellation implementation.
    void reader.cancel().catch(() => {});
  }
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) fail(400);
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding !== 'identity') fail(400);
  if (Number(request.headers.get('Content-Length')) > BODY_LIMIT) fail(413, 'body_too_large');
  return boundedJson(request.body, BODY_LIMIT, 413, 'body_too_large');
}

function tokenPair(body) {
  if (!body || body.error || !text(body.access_token) || !text(body.refresh_token) || body.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0 || !Number.isSafeInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= 0) fail(502, 'github_error');
  return { access_token: body.access_token, token_type: 'bearer', expires_in: body.expires_in,
    refresh_token: body.refresh_token, refresh_token_expires_in: body.refresh_token_expires_in };
}

function configuration(env) {
  if (!text(env.GITHUB_CLIENT_ID, 128) || !text(env.GITHUB_CLIENT_SECRET, 1024) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(env.GITHUB_APP_SLUG ?? '')) fail(503, 'unavailable');
  const base = new URL(env.PUBLIC_BASE_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(env.ALLOW_HTTP_LOOPBACK === 'true' && loopback && base.protocol === 'http:'))) fail(503, 'unavailable');
  const origins = new Set((env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) fail(503, 'unavailable');
  }
  return {
    clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, appSlug: env.GITHUB_APP_SLUG,
    callbackUrl: `${base.origin}/auth/callback`, origins,
  };
}

async function proof(body) {
  exactKeys(body, ['transactionId', 'codeVerifier']);
  if (typeof body.transactionId !== 'string' || !BASE64URL.test(body.transactionId) || typeof body.codeVerifier !== 'string' || !VERIFIER.test(body.codeVerifier)) fail(400);
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.codeVerifier))));
}

export function createWorker({
  fetch: fetchUpstream = (...args) => globalThis.fetch(...args), now = Date.now,
  createStore = (env) => new D1TransactionStore({ db: env.DB, namespace: env.APP_NAMESPACE || 'image_paste_auth', now }),
  claimTimeoutMs = 10000, upstreamTimeoutMs = 10000, rateLimit = 120, maxRateClients = 10000, maxUpstreamRequests = 32,
} = {}) {
  for (const value of [claimTimeoutMs, upstreamTimeoutMs, rateLimit, maxRateClients, maxUpstreamRequests]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Limits must be positive integers.');
  }
  const rates = new Map();
  let upstreamRequests = 0;

  function limit(request) {
    const time = now();
    // Bounded work per request respects Workers Free's small CPU budget.
    let pruned = 0;
    for (const [key, value] of rates) {
      if (value.until > time || pruned++ >= 32) break;
      rates.delete(key);
    }
    const address = request.headers.get('CF-Connecting-IP') ?? '';
    const key = /^[0-9a-fA-F:.]{1,64}$/.test(address) ? address : 'unknown';
    let rate = rates.get(key);
    if (rate && rate.until <= time) { rates.delete(key); rate = undefined; }
    if (!rate && rates.size >= maxRateClients) fail(429, 'rate_limited');
    rate ??= { count: 0, until: time + 60000 };
    rate.count += 1;
    rates.set(key, rate);
    if (rate.count > rateLimit) fail(429, 'rate_limited');
  }

  async function claim(store, id, challenge) {
    let timer;
    try {
      return await Promise.race([
        store.claim(id, challenge),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, 'unavailable')), claimTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function upstream(url, init, read) {
    if (upstreamRequests >= maxUpstreamRequests) fail(429, 'rate_limited');
    upstreamRequests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
      // Workers supports manual redirects; readers below reject every 3xx response.
      const response = await fetchUpstream(url, { ...init,
        headers: { ...init.headers, 'User-Agent': 'image-paste-on-github' },
        redirect: 'manual', signal: controller.signal });
      return await read(response);
    } catch { fail(502, 'github_error'); }
    finally { clearTimeout(timer); upstreamRequests -= 1; }
  }

  async function exchange(config, fields) {
    return upstream(TOKEN_URL, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }).toString(),
    }, async (response) => {
      if (!response.ok) { void response.body?.cancel().catch(() => {}); fail(502, 'github_error'); }
      return tokenPair(await boundedJson(response.body, UPSTREAM_LIMIT, 502, 'github_error'));
    });
  }

  function cleanup(context, operation) {
    const promise = operation.catch(() => {});
    if (context?.waitUntil) context.waitUntil(promise);
    return promise;
  }

  return {
    async fetch(request, env, context) {
      const headers = securityHeaders();
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/health' && !url.search) return json(200, { status: 'ok' }, headers);
        if (!url.pathname.startsWith('/auth/')) fail(404, 'not_found');
        if (env.AUTH_ENABLED !== 'true') fail(503, 'unavailable');
        const config = configuration(env);
        limit(request);
        const origin = request.headers.get('Origin');
        if (origin && !config.origins.has(origin)) fail(403, 'origin_not_allowed');
        if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
        if (request.method === 'OPTIONS' && origin) {
          headers.set('Access-Control-Allow-Methods', 'GET, POST');
          headers.set('Access-Control-Allow-Headers', 'Content-Type');
          return new Response(null, { status: 204, headers });
        }
        if (request.method === 'GET' && url.pathname === '/auth/config' && !url.search) return json(200, {
          clientId: config.clientId, appSlug: config.appSlug,
          installationUrl: `https://github.com/apps/${config.appSlug}/installations/new`, callbackUrl: config.callbackUrl,
        }, headers);
        const store = createStore(env);
        if (request.method === 'GET' && url.pathname === '/auth/callback') {
          const state = url.searchParams.get('state');
          if (!BASE64URL.test(state ?? '') || url.searchParams.getAll('state').length !== 1) fail(400);
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');
          if ((code && error) || (!code && !error) || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1 || (code && !text(code, 1024))) fail(400);
          const transaction = await store.callback(state, { code, denied: Boolean(error) });
          const link = new URL('obsidian://image-paste-on-github-auth');
          link.searchParams.set('transaction_id', transaction.transactionId);
          link.searchParams.set('state', transaction.clientState);
          headers.set('Content-Type', 'text/html; charset=utf-8');
          return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Return to Obsidian</title><h1>Return to Obsidian</h1><p>Continue in Image Paste on GitHub to finish signing in.</p><p><a href="${escapeHtml(link.href)}">Return to Obsidian</a></p></html>`, { headers });
        }
        if (request.method !== 'POST' || url.search) fail(404, 'not_found');
        const body = await readJson(request);
        if (url.pathname === '/auth/start') {
          exactKeys(body, ['codeChallenge', 'clientState']);
          if (typeof body.codeChallenge !== 'string' || !BASE64URL.test(body.codeChallenge) || typeof body.clientState !== 'string' || !BASE64URL.test(body.clientState)) fail(400);
          const id = randomId();
          const oauthState = randomId();
          const expiresAt = now() + TTL_MS;
          await store.create({ ...body, transactionId: id, oauthState, expiresAt });
          const authorization = new URL('https://github.com/login/oauth/authorize');
          authorization.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl,
            state: oauthState, code_challenge: body.codeChallenge, code_challenge_method: 'S256', scope: 'offline_access' }).toString();
          return json(200, { transactionId: id, authorizationUrl: authorization.href, expiresAt }, headers);
        }
        if (url.pathname === '/auth/cancel') {
          const challenge = await proof(body);
          await store.cancel(body.transactionId, challenge);
          return new Response(null, { status: 204, headers });
        }
        if (url.pathname === '/auth/complete') {
          const challenge = await proof(body);
          const transaction = await claim(store, body.transactionId, challenge);
          try {
            if (request.signal?.aborted) fail(503, 'unavailable');
            if (transaction.denied) fail(400, 'user_denied');
            const pair = await exchange(config, { code: transaction.code, code_verifier: body.codeVerifier, redirect_uri: config.callbackUrl });
            return json(200, pair, headers);
          } finally { cleanup(context, Promise.resolve().then(() => store.finish(body.transactionId))); }
        }
        if (url.pathname === '/auth/refresh') {
          exactKeys(body, ['refreshToken']);
          if (!text(body.refreshToken)) fail(400);
          return json(200, await exchange(config, { grant_type: 'refresh_token', refresh_token: body.refreshToken }), headers);
        }
        if (url.pathname === '/auth/revoke') {
          exactKeys(body, ['accessToken']);
          if (!text(body.accessToken)) fail(400);
          await upstream(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
            method: 'DELETE', headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
              Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`, 'X-GitHub-Api-Version': '2022-11-28' },
            body: JSON.stringify({ access_token: body.accessToken }),
          }, async (response) => {
            void response.body?.cancel().catch(() => {});
            if (response.status !== 204 && response.status !== 404) fail(502, 'github_error');
          });
          return new Response(null, { status: 204, headers });
        }
        fail(404, 'not_found');
      } catch (error) {
        const known = (error instanceof HttpError || error instanceof StoreError) && Object.hasOwn(MESSAGES, error.code);
        const status = known ? error.status : 503;
        const code = known ? error.code : 'unavailable';
        if (status === 429) headers.set('Retry-After', '60');
        return json(status, { error: code, message: MESSAGES[code] }, headers);
      }
    },

    async scheduled(_event, env, context) {
      // This handler only deletes expired login rows, including while auth is disabled.
      try { await cleanup(context, createStore(env).cleanup({ limit: 200 })); } catch { /* No database diagnostics or request data are logged. */ }
    },
  };
}

export default createWorker();
