const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { webcrypto } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

const compiled = transformSync(fs.readFileSync(path.join(__dirname, "../src/auth.ts"), "utf8"), {
	loader: "ts", format: "cjs", target: "es2018",
}).code;
const sandbox = {
	module: { exports: {} }, URL, TextEncoder, Date, setTimeout, clearTimeout,
	crypto: webcrypto,
	btoa: value => Buffer.from(value, "binary").toString("base64"),
};
vm.runInNewContext(compiled, sandbox, { filename: "auth-relay-client.cjs" });
const { GitHubAuth, AuthError } = sandbox.module.exports;
const initialTime = 1_800_000_000_000;
const copy = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => error instanceof AuthError && error.code === code;

function credentials(index) {
	return {
		access_token: `ghu_integration_${index}`, refresh_token: `ghr_integration_${index}`,
		token_type: "bearer", expires_in: 28_800, refresh_token_expires_in: 15_897_600,
	};
}

async function fixture(t) {
	const { createRelayServer } = await import(pathToFileURL(path.join(__dirname, "../relay/server.mjs")).href);
	// Public callback metadata needs the port before the relay factory is created.
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const relayUrl = `http://127.0.0.1:${port}`;
	const state = { now: initialTime, stored: null, issued: 0 };
	const upstream = [], requests = [], opened = [], writes = [];
	const server = createRelayServer({
		clientId: "Iv1.integration-client", clientSecret: "integration-server-only-secret",
		appSlug: "integration-image-paste", publicBaseUrl: relayUrl, allowHttpLoopback: true,
	}, {
		now: () => state.now,
		fetch: async (url, init) => {
			upstream.push({ url, ...init });
			if (url === "https://github.com/login/oauth/access_token" && init.method === "POST") {
				return Response.json(credentials(++state.issued));
			}
			assert.equal(url, "https://api.github.com/applications/Iv1.integration-client/token");
			assert.equal(init.method, "DELETE");
			return new Response(null, { status: 204 });
		},
	});
	server.listen(port, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	});
	const localFetch = async (url, options) => {
		assert.equal(new URL(url).origin, relayUrl, "Only the test's local relay may receive real network requests");
		return globalThis.fetch(url, { ...options, redirect: "error" });
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
			return { status: response.status, ...(response.status === 204 ? {} : { json: await response.json() }) };
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
	return { auth, state, relayUrl, upstream, requests, opened, writes, callback, callbackRequest };
}

test("실제 로컬 relay를 통해 로그인, PKCE 교환, 갱신, 연결 해제를 완료한다", async t => {
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
		expiresAt: initialTime + 28_800_000, refreshExpiresAt: initialTime + 15_897_600_000,
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
	assert.equal(f.upstream[2].headers.Authorization, `Basic ${Buffer.from("Iv1.integration-client:integration-server-only-secret").toString("base64")}`);
	await assert.rejects(f.auth.getAccessToken(), errorCode("not_connected"));
	assert.equal(f.requests.filter(request => request.pathname === "/auth/refresh").length, 1);
	assert.equal(f.requests.filter(request => request.pathname === "/auth/revoke").length, 1);
	assert.ok(f.requests.every(request => !JSON.stringify(request).includes("integration-server-only-secret")));
});

test("승인 뒤 취소하면 실제 relay 거래가 삭제되고 늦은 콜백은 토큰을 만들지 않는다", async t => {
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

test("GitHub의 거절을 실제 relay와 클라이언트가 user_denied로 처리하고 재로그인한다", async t => {
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

test("로그인 만료 후 실제 relay에서 교환하지 않고 클라이언트가 재로그인을 요구한다", async t => {
	const f = await fixture(t);
	await f.auth.begin(f.relayUrl);
	const callback = await f.callback();
	f.state.now += 600_000;
	await assert.rejects(f.auth.complete(callback), errorCode("expired"));
	assert.equal(f.auth.pending, false);
	assert.equal(f.auth.connected, false);
	assert.equal(f.state.stored, null);
	assert.equal(f.upstream.length, 0);
	assert.equal(f.requests.filter(request => request.pathname === "/auth/complete").length, 0);
});
