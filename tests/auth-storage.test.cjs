const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const source = buildSync({ entryPoints: [path.join(__dirname, "../src/auth-storage.ts")], bundle: true, write: false, format: "cjs" }).outputFiles[0].text;
const context = { module: { exports: {} }, window: { crypto: webcrypto } };
vm.runInNewContext(source, context);
const { OAuthStorage } = context.module.exports;
const session = { relayUrl: "https://auth.example.com", accessToken: "access", refreshToken: "refresh", expiresAt: 1000, refreshExpiresAt: 2000 };

test("OAuth 자격 증명은 Secret storage에 두고 설정에는 무작위 참조 ID만 저장한다", async () => {
	const secrets = new Map(); let id = ""; const settings = [];
	const storage = new OAuthStorage({ getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) }, () => id, async value => { id = value; settings.push(value); });
	assert.equal(storage.persistent, true);
	assert.equal(await storage.load(), null);
	await storage.save(session);
	assert.match(id, /^image-paste-github-[a-f0-9]{32}$/);
	assert.equal(settings.length, 1);
	assert.ok(!settings[0].includes("refresh"));
	assert.deepEqual(JSON.parse(secrets.get(id)), session);
	assert.deepEqual(JSON.parse(JSON.stringify(await storage.load())), session);
	await storage.save({ ...session, refreshToken: "rotated" });
	assert.equal(settings.length, 1);
	await storage.save(null);
	assert.equal(await storage.load(), null);
});

test("Secret storage가 없는 구버전은 현재 실행 중에만 로그인 정보를 보관한다", async () => {
	const storage = new OAuthStorage(undefined, () => "", async () => { throw new Error("설정 파일에 토큰을 쓰면 안 됨"); });
	assert.equal(storage.persistent, false);
	await storage.save(session);
	assert.equal(await storage.load(), session);
	const nextRun = new OAuthStorage(undefined, () => "", async () => {});
	assert.equal(await nextRun.load(), null);
	await storage.save(null);
	assert.equal(await storage.load(), null);
});

test("변조된 참조 ID로 다른 플러그인의 Secret storage 항목을 읽거나 지우지 않는다", async () => {
	const storage = new OAuthStorage({ getSecret() { throw new Error("다른 secret 읽기 금지"); }, setSecret() { throw new Error("다른 secret 쓰기 금지"); } }, () => "another-plugin", async () => {});
	assert.equal(await storage.load(), null);
	await storage.save(null);
});

test("참조 ID 저장 실패 시 자격 증명을 Secret storage에 남기지 않는다", async () => {
	let writes = 0;
	const storage = new OAuthStorage({ getSecret: () => null, setSecret() { writes++; } }, () => "", async () => { throw new Error("disk full"); });
	await assert.rejects(storage.save(session), /disk full/);
	assert.equal(writes, 0);
});
