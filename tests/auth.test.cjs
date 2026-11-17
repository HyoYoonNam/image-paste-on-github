const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

const compiled = transformSync(
	fs.readFileSync(path.join(__dirname, "../src/auth.ts"), "utf8"),
	{ loader: "ts", format: "cjs", target: "es2018" }
).code;
const sandbox = {
	module: { exports: {} }, URL, TextEncoder, Date,
	window: { crypto: webcrypto, setTimeout, clearTimeout },
	btoa: value => Buffer.from(value, "binary").toString("base64"),
	atob: value => Buffer.from(value, "base64").toString("binary"),
};
vm.runInNewContext(compiled, sandbox, { filename: "auth.cjs" });
const { GitHubAuth, AuthError, normalizeRelayUrl } = sandbox.module.exports;

const relay = "https://auth.example.test";
const initialTime = 1_800_000_000_000;
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function credentials(accessToken = "access-initial", refreshToken = "refresh-initial") {
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: "bearer",
		expires_in: 28_800,
		refresh_token_expires_in: 15_897_600,
	};
}

function savedSession(overrides = {}) {
	return {
		relayUrl: relay,
		accessToken: "access-stored",
		refreshToken: "refresh-stored",
		expiresAt: initialTime + 120_000,
		refreshExpiresAt: initialTime + 86_400_000,
		...overrides,
	};
}

function fixture({ stored = null } = {}) {
	const requests = [], opened = [], saveCalls = [], writes = [];
	const handlers = new Map();
	const state = { now: initialTime, stored: copy(stored), onSave: null, starts: 0 };
	const config = {
		clientId: "Iv1.test-client",
		appSlug: "image-paste-test",
		installationUrl: "https://github.com/apps/image-paste-test/installations/new",
		callbackUrl: `${relay}/auth/callback`,
	};
	function started(body, changes = {}) {
		const authorization = new URL("https://github.com/login/oauth/authorize");
		authorization.searchParams.set("client_id", config.clientId);
		authorization.searchParams.set("redirect_uri", config.callbackUrl);
		authorization.searchParams.set("code_challenge", body.codeChallenge);
		authorization.searchParams.set("code_challenge_method", "S256");
		authorization.searchParams.set("state", "github-server-state");
		return {
			transactionId: `transaction-${++state.starts}`,
			authorizationUrl: authorization.href,
			expiresAt: state.now + 5 * 60_000,
			...changes,
		};
	}
	const auth = new GitHubAuth({
		crypto: webcrypto,
		now: () => state.now,
		openUrl: url => opened.push(url),
		storage: {
			async load() { return copy(state.stored); },
			async save(session) {
				const snapshot = copy(session);
				saveCalls.push(snapshot);
				if (state.onSave) await state.onSave(snapshot);
				state.stored = snapshot;
				writes.push(snapshot);
			},
		},
		async request(request) {
			const entry = { ...copy(request), pathname: new URL(request.url).pathname,
				json: request.body === undefined ? undefined : JSON.parse(request.body) };
			requests.push(entry);
			const handler = handlers.get(entry.pathname);
			if (handler) return handler(entry);
			switch (entry.pathname) {
				case "/auth/config": return { status: 200, json: copy(config) };
				case "/auth/start": return { status: 200, json: started(entry.json) };
				case "/auth/complete": return { status: 200, json: credentials() };
				case "/auth/refresh": return { status: 200, json: credentials("access-renewed", "refresh-renewed") };
				case "/auth/cancel":
				case "/auth/revoke": return { status: 204 };
				default: throw new Error(`Unexpected authentication endpoint: ${entry.pathname}`);
			}
		},
	});
	function calls(pathname) { return requests.filter(request => request.pathname === pathname); }
	function callback() {
		const start = calls("/auth/start").at(-1);
		return { transaction_id: `transaction-${state.starts}`, state: start.json.clientState };
	}
	return { auth, config, state, requests, opened, saveCalls, writes, handlers, started, calls, callback };
}

function errorCode(code) {
	return error => error instanceof AuthError && error.code === code;
}

test("HTTPS relay와 로컬 개발 origin을 정규화한다", () => {
	assert.equal(normalizeRelayUrl(`${relay}/`), relay);
	assert.equal(normalizeRelayUrl("http://127.0.0.1:4567/"), "http://127.0.0.1:4567");
	assert.equal(normalizeRelayUrl("http://localhost:4567"), "http://localhost:4567");
	assert.equal(normalizeRelayUrl("http://[::1]:4567"), "http://[::1]:4567");
});

test("원격 HTTP, 사용자정보, 경로, query, fragment relay는 요청 전에 거절한다", async () => {
	for (const address of ["http://auth.example.test", "javascript:alert(1)", "https://user:pass@auth.example.test", `${relay}/proxy`, `${relay}?token=secret`, `${relay}#fragment`]) {
		const f = fixture();
		await assert.rejects(f.auth.begin(address), errorCode("relay_url"));
		assert.equal(f.requests.length, 0, address);
		assert.equal(f.opened.length, 0, address);
	}
});

test("저장된 유효 세션을 불러오면 네트워크 없이 기존 토큰을 사용한다", async () => {
	const session = savedSession(), f = fixture({ stored: session });
	await f.auth.initialize();
	assert.equal(f.auth.connected, true);
	assert.equal(f.auth.relayUrl, relay);
	assert.equal(await f.auth.getAccessToken(), session.accessToken);
	assert.equal(f.requests.length, 0);
	assert.equal(f.writes.length, 0);
});

test("만료되거나 신뢰할 수 없는 저장 세션은 지우고 연결하지 않는다", async () => {
	for (const stored of [savedSession({ refreshExpiresAt: initialTime }), savedSession({ relayUrl: "http://remote.example.test" }), savedSession({ accessToken: "" }), savedSession({ refreshToken: "" })]) {
		const f = fixture({ stored });
		await f.auth.initialize();
		assert.equal(f.auth.connected, false);
		assert.equal(f.state.stored, null);
		await assert.rejects(f.auth.getAccessToken(), errorCode("not_connected"));
		assert.equal(f.requests.length, 0);
	}
});

test("PKCE S256 증명과 클라이언트 state를 사용하는 로그인만 세션으로 저장한다", async () => {
	const f = fixture();
	await f.auth.initialize();
	await f.auth.begin(`${relay}/`);
	const start = f.calls("/auth/start")[0];
	assert.equal(start.method, "POST");
	assert.match(start.json.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
	assert.match(start.json.clientState, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(f.auth.pending, true);
	assert.equal(f.auth.connected, false);
	assert.equal(f.writes.length, 0);
	assert.equal(await f.auth.complete(f.callback()), true);
	const exchange = f.calls("/auth/complete")[0];
	const challenge = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.json.codeVerifier))).toString("base64url");
	assert.equal(challenge, start.json.codeChallenge);
	assert.match(exchange.json.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
	assert.notEqual(exchange.json.codeVerifier, start.json.clientState);
	assert.equal(start.json.codeVerifier, undefined);
	assert.ok(!f.opened[0].includes(exchange.json.codeVerifier));
	assert.equal(f.auth.connected, true);
	assert.equal(f.auth.pending, false);
	assert.deepEqual(f.state.stored, savedSession({ accessToken: "access-initial", refreshToken: "refresh-initial",
		expiresAt: initialTime + 28_800_000, refreshExpiresAt: initialTime + 15_897_600_000 }));
	assert.equal(await f.auth.getAccessToken(), "access-initial");
	assert.equal(f.writes.length, 1);
});

test("callback의 transaction 또는 state가 다르면 교환 요청을 하지 않는다", async () => {
	const f = fixture(); await f.auth.begin(relay);
	const callback = f.callback(), count = f.requests.length;
	assert.equal(await f.auth.complete({ ...callback, state: "another-client" }), false);
	assert.equal(await f.auth.complete({ ...callback, transaction_id: "another-transaction" }), false);
	assert.equal(f.requests.length, count);
	assert.equal(f.auth.pending, true);
	assert.equal(f.state.stored, null);
	assert.equal(await f.auth.complete(callback), true);
	const finished = f.requests.length;
	assert.equal(await f.auth.complete(callback), false);
	assert.equal(f.requests.length, finished);
});

test("브라우저 승인이 아직 안 끝났으면 수동 완료를 다시 시도할 수 있다", async () => {
	const f = fixture(); await f.auth.begin(relay);
	f.handlers.set("/auth/complete", () => ({ status: 409, json: { error: "authorization_pending" } }));
	await assert.rejects(f.auth.complete(), errorCode("authorization_pending"));
	assert.equal(f.auth.pending, true);
	assert.equal(f.auth.connected, false);
	assert.equal(f.state.stored, null);
	f.handlers.delete("/auth/complete");
	assert.equal(await f.auth.complete(), true);
	assert.equal(f.calls("/auth/complete").length, 2);
});

test("동시에 도착한 완료 요청은 한 번만 토큰을 교환한다", async () => {
	const f = fixture(), response = deferred(); await f.auth.begin(relay);
	f.handlers.set("/auth/complete", () => response.promise);
	const first = f.auth.complete(f.callback()), second = f.auth.complete(f.callback());
	await nextTurn(); assert.equal(f.calls("/auth/complete").length, 1);
	response.resolve({ status: 200, json: credentials() });
	assert.deepEqual(await Promise.all([first, second]), [true, true]);
	assert.equal(f.writes.length, 1);
});

test("만료된 로그인은 교환하지 않고 서버 거래를 취소한다", async () => {
	const f = fixture(); await f.auth.begin(relay);
	f.state.now += 5 * 60_000;
	assert.equal(f.auth.pending, false);
	await assert.rejects(f.auth.complete(), errorCode("expired"));
	assert.equal(f.calls("/auth/complete").length, 0);
	assert.equal(f.calls("/auth/cancel").length, 1);
	assert.equal(f.state.stored, null);
});

test("GitHub 승인 URL의 앱, redirect, PKCE, state 또는 origin이 바뀌면 브라우저를 열지 않는다", async () => {
	const changes = [
		url => { url.hostname = "phishing.example.test"; },
		url => { url.pathname = "/login"; },
		url => { url.searchParams.set("client_id", "different-app"); },
		url => { url.searchParams.set("redirect_uri", "https://other.example.test/callback"); },
		url => { url.searchParams.set("code_challenge", "other-challenge"); },
		url => { url.searchParams.set("code_challenge_method", "plain"); },
		url => { url.searchParams.delete("state"); },
		url => { url.username = "user"; },
		url => { url.hash = "unexpected"; },
	];
	for (const change of changes) {
		const f = fixture();
		f.handlers.set("/auth/start", request => {
			const result = f.started(request.json), url = new URL(result.authorizationUrl);
			change(url); result.authorizationUrl = url.href;
			return { status: 200, json: result };
		});
		await assert.rejects(f.auth.begin(relay), errorCode("authorization_url"));
		assert.equal(f.opened.length, 0);
		assert.equal(f.auth.pending, false);
		assert.equal(f.calls("/auth/cancel").length, 1);
	}
});

test("relay 설정의 callback origin이 다르면 로그인 거래를 생성하지 않는다", async () => {
	const f = fixture();
	f.config.callbackUrl = "https://other.example.test/auth/callback";
	await assert.rejects(f.auth.begin(relay), errorCode("relay_config"));
	assert.equal(f.calls("/auth/start").length, 0);
	assert.equal(f.opened.length, 0);
});

test("사용자가 승인을 거절하면 대기 상태를 지우고 다시 시작하도록 알린다", async () => {
	const f = fixture(); await f.auth.begin(relay);
	f.handlers.set("/auth/complete", () => ({ status: 400, json: { error: "user_denied" } }));
	await assert.rejects(f.auth.complete(), errorCode("user_denied"));
	assert.equal(f.auth.pending, false);
	assert.equal(f.auth.connected, false);
	assert.equal(f.state.stored, null);
});

test("잘못된 토큰 형식과 유효기간은 세션으로 저장하지 않는다", async () => {
	for (const changes of [{ access_token: "" }, { refresh_token: "" }, { token_type: "mac" }, { expires_in: 0 }, { expires_in: "28800" }, { expires_in: Infinity }, { refresh_token_expires_in: -1 }]) {
		const f = fixture(); await f.auth.begin(relay);
		f.handlers.set("/auth/complete", () => ({ status: 200, json: { ...credentials(), ...changes } }));
		await assert.rejects(f.auth.complete(), errorCode("token_response"));
		assert.equal(f.auth.connected, false);
		assert.equal(f.state.stored, null);
		assert.equal(f.writes.length, 0);
	}
});

test("네트워크 오류의 내부 응답이나 비밀 값을 사용자 오류에 노출하지 않는다", async () => {
	const f = fixture();
	f.handlers.set("/auth/config", () => { throw new Error("access_token=do-not-display client_secret=do-not-display"); });
	await assert.rejects(f.auth.begin(relay), error => {
		assert.equal(error.code, "network");
		assert.doesNotMatch(error.message, /do-not-display|client_secret|access_token/);
		return true;
	});
	assert.equal(f.opened.length, 0);
});

test("start 응답을 기다리는 동안 취소하면 브라우저를 열지 않는다", async () => {
	const f = fixture(), response = deferred(), started = deferred();
	f.handlers.set("/auth/start", request => { started.resolve(request); return response.promise; });
	const begin = f.auth.begin(relay);
	const request = await started.promise;
	await f.auth.cancel();
	response.resolve({ status: 200, json: f.started(request.json) });
	await begin;
	assert.equal(f.opened.length, 0);
	assert.equal(f.auth.pending, false);
	assert.equal(f.calls("/auth/cancel").length, 1);
	assert.equal(f.state.stored, null);
});

test("로그인 시작을 동시에 누르면 최신 흐름만 브라우저를 연다", async () => {
	const f = fixture();
	await Promise.all([f.auth.begin(relay), f.auth.begin(relay)]);
	assert.equal(f.opened.length, 1);
	assert.equal(f.auth.pending, true);
	assert.equal(await f.auth.complete(f.callback()), true);
});

test("세션 저장 실패를 안내하고 저장소가 복구되면 다시 연결할 수 있다", async () => {
	const f = fixture(); await f.auth.begin(relay);
	f.state.onSave = async () => { throw new Error("private-storage-detail"); };
	await assert.rejects(f.auth.complete(), error => {
		assert.equal(error.code, "storage");
		assert.doesNotMatch(error.message, /private-storage-detail/);
		return true;
	});
	assert.equal(f.auth.connected, false);
	assert.equal(f.auth.pending, false);
	assert.equal(f.state.stored, null);
	assert.equal(f.calls("/auth/revoke").at(-1).json.accessToken, "access-initial");
	f.state.onSave = null;
	await f.auth.begin(relay);
	assert.equal(await f.auth.complete(), true);
	assert.equal(f.auth.connected, true);
});

for (const action of ["cancel", "disconnect", "dispose"]) {
	test(`토큰 교환 중 ${action} 뒤 도착한 세션을 저장하지 않는다`, async () => {
		const f = fixture(), response = deferred(); await f.auth.begin(relay);
		f.handlers.set("/auth/complete", () => response.promise);
		const completion = f.auth.complete(); await nextTurn();
		await f.auth[action]();
		response.resolve({ status: 200, json: credentials("access-late", "refresh-late") });
		assert.equal(await completion, false);
		assert.equal(f.auth.connected, false);
		assert.equal(f.auth.pending, false);
		assert.equal(f.state.stored, null);
		assert.ok(f.writes.every(session => session === null));
		assert.equal(f.calls("/auth/revoke").at(-1).json.accessToken, "access-late");
	});
}

test("연결한 relay에서만 한 번 갱신하고 회전된 refresh token을 저장한다", async () => {
	const f = fixture({ stored: savedSession() }), response = deferred(); await f.auth.initialize();
	f.state.now += 90_000;
	f.handlers.set("/auth/refresh", () => response.promise);
	const first = f.auth.getAccessToken(), second = f.auth.getAccessToken();
	await nextTurn();
	assert.equal(f.calls("/auth/refresh").length, 1);
	assert.equal(f.calls("/auth/refresh")[0].url, `${relay}/auth/refresh`);
	assert.equal(f.calls("/auth/refresh")[0].json.refreshToken, "refresh-stored");
	response.resolve({ status: 200, json: credentials("access-renewed", "refresh-renewed") });
	assert.deepEqual(await Promise.all([first, second]), ["access-renewed", "access-renewed"]);
	assert.equal(f.state.stored.refreshToken, "refresh-renewed");
	assert.equal(f.state.stored.expiresAt, f.state.now + 28_800_000);
	assert.equal(f.writes.length, 1);
	await assert.rejects(f.auth.begin("https://other.example.test"), errorCode("connected"));
	assert.ok(f.requests.every(request => new URL(request.url).origin === relay));
});

test("갱신에 실패하면 만료 토큰을 반환하지 않고 재연결을 요구한다", async () => {
	const f = fixture({ stored: savedSession() }); await f.auth.initialize();
	f.state.now += 120_000;
	f.handlers.set("/auth/refresh", () => ({ status: 401, json: { error: "invalid_grant" } }));
	await assert.rejects(f.auth.getAccessToken(), errorCode("reauthenticate"));
	assert.equal(f.auth.connected, false);
	assert.equal(f.state.stored, null);
	await assert.rejects(f.auth.getAccessToken(), errorCode("not_connected"));
	assert.equal(f.calls("/auth/refresh").length, 1);
});

test("갱신한 토큰 쌍을 저장하지 못하면 새 토큰을 회수하고 연결을 지운다", async () => {
	const f = fixture({ stored: savedSession() }); await f.auth.initialize();
	f.state.now += 120_000;
	f.state.onSave = async session => { if (session) throw new Error("storage unavailable"); };
	await assert.rejects(f.auth.getAccessToken(), errorCode("reauthenticate"));
	assert.equal(f.auth.connected, false);
	assert.equal(f.state.stored, null);
	assert.equal(f.calls("/auth/revoke").length, 1);
	assert.equal(f.calls("/auth/revoke")[0].json.accessToken, "access-renewed");
});

test("응답을 잃은 갱신은 제한 시간 뒤 종료하고 같은 refresh token을 재전송하지 않는다", async () => {
	const timers = [], requests = [], writes = [];
	const context = { ...sandbox, module: { exports: {} }, window: {
		setTimeout: (callback, ms) => { assert.equal(ms, 20_000); timers.push(callback); return timers.length; }, clearTimeout() {},
	} };
	vm.runInNewContext(compiled, context);
	const auth = new context.module.exports.GitHubAuth({
		now: () => initialTime, openUrl() {},
		storage: { load: async () => savedSession({ expiresAt: initialTime - 1 }), save: async value => writes.push(value) },
		request: request => { requests.push(request); return new Promise(() => {}); },
	});
	await auth.initialize();
	const result = assert.rejects(auth.getAccessToken(), error => error.code === "reauthenticate");
	timers[0](); await result;
	assert.equal(auth.connected, false);
	assert.equal(requests.length, 1);
	assert.equal(writes.at(-1), null);
	await assert.rejects(auth.getAccessToken(), error => error.code === "not_connected");
	assert.equal(requests.length, 1);
});

test("refresh token도 만료되면 서버 요청 없이 재연결을 요구한다", async () => {
	const f = fixture({ stored: savedSession({ refreshExpiresAt: initialTime + 130_000 }) });
	await f.auth.initialize(); f.state.now += 140_000;
	await assert.rejects(f.auth.getAccessToken(), errorCode("reauthenticate"));
	assert.equal(f.calls("/auth/refresh").length, 0);
	assert.equal(f.state.stored, null);
});

test("갱신 중 연결을 끊으면 늦은 응답이 계정을 되살리지 않는다", async () => {
	const f = fixture({ stored: savedSession() }), response = deferred(); await f.auth.initialize();
	f.state.now += 90_000;
	f.handlers.set("/auth/refresh", () => response.promise);
	const token = f.auth.getAccessToken();
	const rejected = assert.rejects(token, errorCode("cancelled"));
	await nextTurn();
	assert.equal(await f.auth.disconnect(), true);
	response.resolve({ status: 200, json: credentials("access-late", "refresh-late") });
	await rejected;
	assert.equal(f.auth.connected, false);
	assert.equal(f.state.stored, null);
	assert.ok(f.writes.every(session => session === null));
	assert.equal(f.calls("/auth/revoke").at(-1).json.accessToken, "access-late");
});

test("원격 revoke 실패 여부와 무관하게 로컬 연결은 끊는다", async () => {
	for (const revoked of [true, false]) {
		const f = fixture({ stored: savedSession() }); await f.auth.initialize();
		f.handlers.set("/auth/revoke", () => revoked ? { status: 204 } : { status: 503 });
		assert.equal(await f.auth.disconnect(), revoked);
		assert.equal(f.auth.connected, false);
		assert.equal(f.auth.relayUrl, null);
		assert.equal(f.state.stored, null);
		assert.equal(f.calls("/auth/revoke")[0].json.accessToken, "access-stored");
	}
});

for (const action of ["cancel", "dispose"]) {
	test(`세션 저장을 기다리는 동안 ${action}해도 자격 증명을 남기지 않는다`, async () => {
		const f = fixture(), entered = deferred(), finish = deferred(); await f.auth.begin(relay);
		f.state.onSave = async session => {
			if (session) { entered.resolve(); await finish.promise; }
		};
		const completion = f.auth.complete();
		await entered.promise;
		await f.auth[action]();
		finish.resolve();
		assert.equal(await completion, false);
		assert.equal(f.auth.connected, false);
		assert.equal(f.state.stored, null);
	});
}
