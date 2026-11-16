import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TTL_MS = 10 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;
const UPSTREAM_LIMIT = 32 * 1024;
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEEP_LINK = 'obsidian://image-paste-on-github-auth';
const BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
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
  constructor(status, code) {
    super(MESSAGES[code]);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code = 'invalid_request') {
  throw new HttpError(status, code);
}

function text(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x20\x7f]/.test(value);
}

function exactKeys(body, keys) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) fail(400);
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) fail(400);
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail(400);
  const length = Number(request.headers['content-length']);
  if (length > BODY_LIMIT) {
    request.resume();
    fail(413, 'body_too_large');
  }
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onError = () => { cleanup(); reject(new HttpError(400, 'invalid_request')); };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        cleanup();
        request.resume();
        reject(new HttpError(413, 'body_too_large'));
      } else chunks.push(chunk);
    };
    function cleanup() {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onError);
    }
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onError);
  });
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    fail(400);
  }
}

async function upstreamJson(response) {
  if (!response.ok || !response.body) fail(502, 'github_error');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > UPSTREAM_LIMIT) fail(502, 'github_error');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function tokenPair(body) {
  if (!body || body.error || !text(body.access_token) || !text(body.refresh_token) || body.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0 ||
      !Number.isSafeInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= 0) fail(502, 'github_error');
  return {
    access_token: body.access_token,
    token_type: 'bearer',
    expires_in: body.expires_in,
    refresh_token: body.refresh_token,
    refresh_token_expires_in: body.refresh_token_expires_in,
  };
}

function validateConfig(config) {
  if (!text(config.clientId, 128) || !text(config.clientSecret, 1024) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(config.appSlug ?? '')) throw new Error('Configure a GitHub App client ID, client secret, and app slug.');
  const base = new URL(config.publicBaseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(config.allowHttpLoopback === true && loopback && base.protocol === 'http:'))) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (or explicitly enabled HTTP loopback for development).');
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:', 'app:'].includes(url.protocol)) throw new Error('ALLOWED_ORIGINS must contain exact origins.');
  }
  return { ...config, publicBaseUrl: base.origin, allowedOrigins };
}

export function createRelayServer(configuration, { fetch: fetchUpstream = globalThis.fetch, now = Date.now } = {}) {
  const config = validateConfig(configuration);
  const callbackUrl = `${config.publicBaseUrl}/auth/callback`;
  const installationUrl = `https://github.com/apps/${config.appSlug}/installations/new`;
  const transactions = new Map();
  const oauthStates = new Map();
  const rates = new Map();
  const maxTransactions = config.maxTransactions ?? 1000;
  const maxUpstreamRequests = config.maxUpstreamRequests ?? 32;
  const rateLimit = config.rateLimit ?? 120;
  const maxRateClients = config.maxRateClients ?? 10000;
  const timeoutMs = config.upstreamTimeoutMs ?? 10000;
  let upstreamRequests = 0;
  for (const value of [maxTransactions, maxUpstreamRequests, rateLimit, maxRateClients, timeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Server limits must be positive integers.');
  }

  function discard(id) {
    const transaction = transactions.get(id);
    if (transaction) oauthStates.delete(transaction.oauthState);
    transactions.delete(id);
  }

  function prune() {
    const time = now();
    for (const [id, transaction] of transactions) if (transaction.expiresAt <= time) discard(id);
    for (const [key, rate] of rates) if (rate.until <= time) rates.delete(key);
  }

  function limit(request) {
    // Forwarded headers are deliberately ignored. Configure the ingress limiter separately.
    const key = request.socket.remoteAddress ?? 'unknown';
    const previous = rates.get(key);
    if (!previous && rates.size >= maxRateClients) fail(429, 'rate_limited');
    const rate = previous ?? { count: 0, until: now() + 60000 };
    rate.count += 1;
    rates.set(key, rate);
    if (rate.count > rateLimit) fail(429, 'rate_limited');
  }

  function proof(body) {
    exactKeys(body, ['transactionId', 'codeVerifier']);
    if (typeof body.transactionId !== 'string' || !BASE64URL.test(body.transactionId) || typeof body.codeVerifier !== 'string' || !VERIFIER.test(body.codeVerifier)) fail(400);
    const transaction = transactions.get(body.transactionId);
    if (!transaction) fail(404, 'transaction_not_found');
    if (transaction.expiresAt <= now()) {
      discard(body.transactionId);
      fail(404, 'transaction_not_found');
    }
    const challenge = createHash('sha256').update(body.codeVerifier).digest('base64url');
    if (!equal(challenge, transaction.codeChallenge)) fail(403, 'invalid_proof');
    return transaction;
  }

  async function exchange(fields) {
    if (upstreamRequests >= maxUpstreamRequests) fail(429, 'rate_limited');
    upstreamRequests += 1;
    try {
      const response = await fetchUpstream(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }).toString(),
      });
      return tokenPair(await upstreamJson(response));
    } catch {
      fail(502, 'github_error');
    } finally {
      upstreamRequests -= 1;
    }
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      prune();
      const url = new URL(request.url, config.publicBaseUrl);
      if (request.method === 'GET' && url.pathname === '/health' && !url.search) {
        json(response, 200, { status: 'ok' });
        return;
      }
      limit(request);
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.has(origin)) fail(403, 'origin_not_allowed');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS' && origin) {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/auth/config' && !url.search) {
        json(response, 200, { clientId: config.clientId, appSlug: config.appSlug, installationUrl, callbackUrl });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state');
        if (!BASE64URL.test(state ?? '') || url.searchParams.getAll('state').length !== 1) fail(400);
        const id = oauthStates.get(state);
        const transaction = transactions.get(id);
        if (!transaction) fail(404, 'transaction_not_found');
        if (transaction.status !== 'pending') fail(409, 'transaction_consumed');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if ((code && error) || (!code && !error) || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1 || (code && !text(code, 1024))) fail(400);
        transaction.status = error ? 'denied' : 'authorized';
        if (code) transaction.code = code;
        const link = new URL(DEEP_LINK);
        link.searchParams.set('transaction_id', id);
        link.searchParams.set('state', transaction.clientState);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Return to Obsidian</title><h1>Return to Obsidian</h1><p>Continue in Image Paste on GitHub to finish signing in.</p><p><a href="${escapeHtml(link.toString())}">Return to Obsidian</a></p></html>`);
        return;
      }
      if (request.method !== 'POST' || url.search) fail(404, 'not_found');
      const body = await readJson(request);
      if (url.pathname === '/auth/start') {
        exactKeys(body, ['codeChallenge', 'clientState']);
        if (typeof body.codeChallenge !== 'string' || !BASE64URL.test(body.codeChallenge) || typeof body.clientState !== 'string' || !BASE64URL.test(body.clientState)) fail(400);
        if (transactions.size >= maxTransactions) fail(429, 'rate_limited');
        const id = randomBytes(32).toString('base64url');
        const oauthState = randomBytes(32).toString('base64url');
        const expiresAt = now() + TTL_MS;
        transactions.set(id, { ...body, oauthState, expiresAt, status: 'pending' });
        oauthStates.set(oauthState, id);
        const authorization = new URL('https://github.com/login/oauth/authorize');
        authorization.search = new URLSearchParams({
          client_id: config.clientId, redirect_uri: callbackUrl, state: oauthState,
          code_challenge: body.codeChallenge, code_challenge_method: 'S256', scope: 'offline_access',
        }).toString();
        json(response, 200, { transactionId: id, authorizationUrl: authorization.toString(), expiresAt });
      } else if (url.pathname === '/auth/cancel') {
        const transaction = proof(body);
        if (transaction.status === 'consuming') fail(409, 'transaction_consumed');
        discard(body.transactionId);
        response.writeHead(204).end();
      } else if (url.pathname === '/auth/complete') {
        const transaction = proof(body);
        if (transaction.status === 'pending') fail(409, 'authorization_pending');
        if (transaction.status === 'consuming') fail(409, 'transaction_consumed');
        if (transaction.status === 'denied') {
          discard(body.transactionId);
          fail(400, 'user_denied');
        }
        transaction.status = 'consuming';
        const code = transaction.code;
        delete transaction.code;
        try {
          const pair = await exchange({ code, code_verifier: body.codeVerifier, redirect_uri: callbackUrl });
          json(response, 200, pair);
        } finally {
          discard(body.transactionId);
        }
      } else if (url.pathname === '/auth/refresh') {
        exactKeys(body, ['refreshToken']);
        if (!text(body.refreshToken)) fail(400);
        json(response, 200, await exchange({ grant_type: 'refresh_token', refresh_token: body.refreshToken }));
      } else if (url.pathname === '/auth/revoke') {
        exactKeys(body, ['accessToken']);
        if (!text(body.accessToken)) fail(400);
        if (upstreamRequests >= maxUpstreamRequests) fail(429, 'rate_limited');
        upstreamRequests += 1;
        try {
          const upstream = await fetchUpstream(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
            method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            headers: {
              Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
              Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({ access_token: body.accessToken }),
          });
          await upstream.body?.cancel();
          if (upstream.status !== 204 && upstream.status !== 404) fail(502, 'github_error');
          response.writeHead(204).end();
        } catch {
          fail(502, 'github_error');
        } finally {
          upstreamRequests -= 1;
        }
      } else {
        fail(404, 'not_found');
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const known = error instanceof HttpError;
      const status = known ? error.status : 503;
      const code = known ? error.code : 'unavailable';
      if (status === 429) response.setHeader('Retry-After', '60');
      json(response, status, { error: code, message: MESSAGES[code] });
    }
  }

  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, handle);
  server.maxHeadersCount = 40;
  server.keepAliveTimeout = 5000;
  const cleanup = setInterval(prune, 60000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); transactions.clear(); oauthStates.clear(); rates.clear(); });
  return server;
}

export function configFromEnvironment(environment = process.env) {
  return {
    clientId: environment.GITHUB_CLIENT_ID,
    clientSecret: environment.GITHUB_CLIENT_SECRET,
    appSlug: environment.GITHUB_APP_SLUG,
    publicBaseUrl: environment.PUBLIC_BASE_URL,
    allowHttpLoopback: environment.ALLOW_HTTP_LOOPBACK === 'true',
    allowedOrigins: environment.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
    const server = createRelayServer(configFromEnvironment());
    server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Authentication relay listening on port ${port}.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch {
    console.error('Authentication relay configuration is invalid. Check the documented environment variables.');
    process.exitCode = 1;
  }
}
