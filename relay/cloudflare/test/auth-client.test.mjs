import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from 'miniflare';

const compiled = transformSync(readFileSync(new URL("../../../src/auth.ts", import.meta.url), "utf8"), {
  loader: "ts", format: "cjs", target: "es2018",
}).code;
const sandbox = {
  module: { exports: {} }, URL, TextEncoder, Date, setTimeout, clearTimeout,
  crypto: webcrypto,
  btoa: value => Buffer.from(value, "binary").toString("base64"),
};
vm.runInNewContext(compiled, sandbox, { filename: "auth-relay-client.cjs" });
const { GitHubAuth, AuthError } = sandbox.module.exports;
const copy = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => error instanceof AuthError && error.code === code;

function credentials(index) {
  return {
    access_token: `ghu_integration_${index}`, refresh_token: `ghr_integration_${index}`,
    token_type: "bearer", expires_in: 28_800, refresh_token_expires_in: 15_897_600,
  };
}

async function fixture(t) {
  const relayUrl = "https://auth.example.test";
  const state = { now: 0, stored: null, issued: 0, loginExpiresAt: null };
  const upstream = [], requests = [], opened = [], writes = [];
  const modules = await Promise.all(["worker.mjs", "d1-store.mjs"].map(async name => ({
    type: "ESModule", path: fileURLToPath(new URL(`../${name}`, import.meta.url)),
    contents: await readFile(new URL(`../${name}`, import.meta.url), "utf8"),
  })));
  const runtime = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: ["client", "callback"].map(name => ({
      name, modules, scriptPath: fileURLToPath(new URL("../worker.mjs", import.meta.url)),
      compatibilityDate: "2026-11-13",
      bindings: {
        AUTH_ENABLED: "true", APP_NAMESPACE: "auth_client_test", PUBLIC_BASE_URL: relayUrl,
        GITHUB_CLIENT_ID: "Iv1.integration-client", GITHUB_CLIENT_SECRET: "integration-server-only-secret",
        GITHUB_APP_SLUG: "integration-image-paste",
      },
      d1Databases: { DB: "local-auth-client-integration" },
      outboundService: async request => {
        upstream.push({ url: request.url, method: request.method, body: await request.text(), headers: Object.fromEntries(request.headers) });
        if (request.url === "https://github.com/login/oauth/access_token" && request.method === "POST") {
          return RuntimeResponse.json(credentials(++state.issued));
        }
        assert.equal(request.url, "https://api.github.com/applications/Iv1.integration-client/token");
        assert.equal(request.method, "DELETE");
        return new RuntimeResponse(null, { status: 204 });
      },
    })),
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB", "client");
  const migration = await readFile(new URL("../migrations/0001_auth_transactions.sql", import.meta.url), "utf8");
  await db.batch(migration.split(";").map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const [clientWorker, callbackWorker] = await Promise.all(["client", "callback"].map(name => runtime.getWorker(name)));
  const initialTime = Date.now();
  state.now = initialTime;
  const localFetch = (url, options) => {
    assert.equal(new URL(url).origin, relayUrl, "테스트 요청은 로컬 Worker로만 전달한다.");
    const worker = new URL(url).pathname === "/auth/callback" ? callbackWorker : clientWorker;
    return worker.fetch(url, { ...options, redirect: "error" });
  };
  const auth = new GitHubAuth({
    crypto: webcrypto,
    now: () => state.now,
    openUrl: url => {
      assert.equal(new URL(url).origin, "https://github.com");
      opened.push(url);
    },
    storage: {
      async load() { return copy(state.stored); },
      async save(session) { state.stored = copy(session); writes.push(copy(session)); },
    },
    async request(request) {
      requests.push({ ...request, pathname: new URL(request.url).pathname });
      const response = await localFetch(request.url, {
        method: request.method, headers: request.headers, body: request.body,
      });
      const json = response.status === 204 ? undefined : await response.json();
      if (new URL(request.url).pathname === "/auth/start" && response.status === 200) state.loginExpiresAt = json.expiresAt;
      return { status: response.status, ...(json === undefined ? {} : { json }) };
    },
  });
  const callbackRequest = (suffix = "code=integration-authorization-code") => {
    const authorization = new URL(opened.at(-1));
    assert.equal(authorization.searchParams.get("redirect_uri"), `${relayUrl}/auth/callback`);
    return localFetch(`${relayUrl}/auth/callback?state=${authorization.searchParams.get("state")}&${suffix}`);
  };
  const callback = async (suffix) => {
    const response = await callbackRequest(suffix);
    assert.equal(response.status, 200);
    const html = await response.text();
    const href = /href="([^"]+)"/.exec(html)?.[1].replace(/&amp;/g, "&");
    assert.ok(href, "The real callback HTML must offer a return link");
    const link = new URL(href);
    assert.equal(link.protocol, "obsidian:");
    assert.equal(link.hostname, "image-paste-on-github-auth");
    assert.deepEqual([...link.searchParams.keys()], ["transaction_id", "state"]);
    assert.ok(!html.includes("integration-authorization-code"));
    assert.ok(!html.includes("integration-server-only-secret"));
    assert.ok(!html.includes("ghu_integration"));
    return { transaction_id: link.searchParams.get("transaction_id"), state: link.searchParams.get("state") };
  };
  return { auth, state, initialTime, relayUrl, upstream, requests, opened, writes, callback, callbackRequest };
}

test("실제 로컬 Worker와 D1을 통해 로그인, PKCE 교환, 갱신, 연결 해제를 완료한다", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.auth.initialize();
  await f.auth.begin(f.relayUrl);
  assert.equal(f.auth.pending, true);
  assert.equal(f.auth.connected, false);
  assert.equal(f.opened.length, 1);
  assert.equal(f.upstream.length, 0);
  await assert.rejects(f.auth.complete(), errorCode("authorization_pending"));
  assert.equal(f.auth.pending, true);
  const callback = await f.callback();
  const count = f.requests.length;
  assert.equal(await f.auth.complete({ ...callback, state: "wrong-client-state" }), false);
  assert.equal(f.requests.length, count);
  assert.equal(await f.auth.complete(callback), true);
  assert.equal(f.auth.connected, true);
  assert.equal(f.auth.pending, false);
  assert.deepEqual(f.state.stored, {
    relayUrl: f.relayUrl, accessToken: "ghu_integration_1", refreshToken: "ghr_integration_1",
    expiresAt: f.initialTime + 28_800_000, refreshExpiresAt: f.initialTime + 15_897_600_000,
  });
  assert.equal(await f.auth.getAccessToken(), "ghu_integration_1");
  assert.equal(f.upstream.length, 1);
  const exchange = new URLSearchParams(f.upstream[0].body);
  assert.equal(exchange.get("code"), "integration-authorization-code");
  assert.equal(exchange.get("client_secret"), "integration-server-only-secret");
  const start = JSON.parse(f.requests.find(request => request.pathname === "/auth/start").body);
  assert.equal(Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier")))).toString("base64url"), start.codeChallenge);
  assert.notEqual(start.clientState, new URL(f.opened[0]).searchParams.get("state"));
  assert.equal(await f.auth.complete(callback), false);

  f.state.now += 28_800_000;
  assert.deepEqual(await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken()]), ["ghu_integration_2", "ghu_integration_2"]);
  assert.equal(f.upstream.length, 2);
  const refresh = new URLSearchParams(f.upstream[1].body);
  assert.equal(refresh.get("grant_type"), "refresh_token");
  assert.equal(refresh.get("refresh_token"), "ghr_integration_1");
  assert.equal(f.state.stored.accessToken, "ghu_integration_2");
  assert.equal(f.state.stored.refreshToken, "ghr_integration_2");
  assert.equal(f.state.stored.expiresAt, f.state.now + 28_800_000);
  assert.equal(f.writes.length, 2);

  assert.equal(await f.auth.disconnect(), true);
  assert.equal(f.auth.connected, false);
  assert.equal(f.state.stored, null);
  assert.equal(f.upstream.length, 3);
  assert.deepEqual(JSON.parse(f.upstream[2].body), { access_token: "ghu_integration_2" });
  assert.equal(f.upstream[2].headers.authorization, `Basic ${Buffer.from("Iv1.integration-client:integration-server-only-secret").toString("base64")}`);
  await assert.rejects(f.auth.getAccessToken(), errorCode("not_connected"));
  assert.equal(f.requests.filter(request => request.pathname === "/auth/refresh").length, 1);
  assert.equal(f.requests.filter(request => request.pathname === "/auth/revoke").length, 1);
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes("integration-server-only-secret")));
});

test("승인 뒤 취소하면 D1의 로그인 거래가 삭제되고 늦은 콜백은 토큰을 만들지 않는다", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.auth.begin(f.relayUrl);
  const callback = await f.callback();
  await f.auth.cancel();
  assert.equal(f.auth.pending, false);
  assert.equal(await f.auth.complete(callback), false);
  assert.equal((await f.callbackRequest()).status, 404);
  assert.equal(f.upstream.length, 0);
  assert.equal(f.state.stored, null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests.filter(request => request.pathname === "/auth/cancel").length, 1);
});

test("GitHub의 거절을 Worker와 클라이언트가 user_denied로 처리하고 재로그인한다", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.auth.begin(f.relayUrl);
  const callback = await f.callback("error=access_denied&error_description=do-not-reflect-this");
  await assert.rejects(f.auth.complete(callback), errorCode("user_denied"));
  assert.equal(f.auth.connected, false);
  assert.equal(f.auth.pending, false);
  assert.equal(f.upstream.length, 0);
  assert.equal(f.writes.length, 0);
  await f.auth.begin(f.relayUrl);
  const next = await f.callback();
  assert.notEqual(next.transaction_id, callback.transaction_id);
  assert.notEqual(next.state, callback.state);
  assert.equal(await f.auth.complete(next), true);
  assert.equal(f.upstream.length, 1);
  await f.auth.disconnect();
});

test("로그인 만료 후 Worker에서 교환하지 않고 클라이언트가 재로그인을 요구한다", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.auth.begin(f.relayUrl);
  const callback = await f.callback();
  f.state.now = f.state.loginExpiresAt;
  await assert.rejects(f.auth.complete(callback), errorCode("expired"));
  assert.equal(f.auth.pending, false);
  assert.equal(f.auth.connected, false);
  assert.equal(f.state.stored, null);
  assert.equal(f.upstream.length, 0);
  assert.equal(f.requests.filter(request => request.pathname === "/auth/complete").length, 0);
});
