const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { buildSync } = require("esbuild");

const compiled = buildSync({
	entryPoints: [path.join(__dirname, "../src/main.ts")],
	bundle: true, write: false, external: ["obsidian", "./heic"],
	format: "cjs", target: "es2018",
}).outputFiles[0].text;

function supports(version, required) {
	const current = version.split(".").map(Number);
	const minimum = required.split(".").map(Number);
	for (let index = 0; index < minimum.length; index++) {
		if (current[index] !== minimum[index]) return current[index] > minimum[index];
	}
	return true;
}

async function loadPlugin(version, secrets, saved = null) {
	const writes = [], events = [], notices = [];
	const obsidian = {
		Plugin: class {
			async loadData() { return saved; }
			async saveData(data) { writes.push({ ...data }); }
			registerEvent() {}
			registerObsidianProtocolHandler() {}
			addSettingTab() {}
		},
		PluginSettingTab: class {},
		Notice: class { constructor(message) { notices.push(message); } },
		requireApiVersion: required => supports(version, required),
	};
	const context = {
		module: { exports: {} }, URL,
		window: { crypto: webcrypto },
		require(name) {
			if (name === "./heic") return {};
			assert.equal(name, "obsidian");
			return obsidian;
		},
	};
	vm.runInNewContext(compiled, context);
	const plugin = new context.module.exports.default();
	plugin.app = {
		workspace: { on(name) { events.push(name); } },
		get secretStorage() {
			assert.ok(supports(version, "1.11.4"), "구버전에서는 Secret storage에 접근하면 안 된다");
			return secrets;
		},
	};
	await plugin.onload();
	return { plugin, writes, events, notices };
}

const session = {
	relayUrl: "https://auth.example.test", accessToken: "test-access", refreshToken: "test-refresh",
	expiresAt: Date.now() + 120_000, refreshExpiresAt: Date.now() + 86_400_000,
};

for (const version of ["1.5.7", "1.11.3"]) {
	test(`Obsidian ${version}에서는 최신 API 없이 로드하고 로그인 정보를 메모리에만 보관한다`, async () => {
		const { plugin, writes, events, notices } = await loadPlugin(version);
		assert.equal(plugin.oauthStorage.persistent, false);
		assert.deepEqual(events, ["editor-paste", "editor-drop"]);
		assert.deepEqual(notices, []);
		await plugin.oauthStorage.save(session);
		assert.equal(await plugin.oauthStorage.load(), session);
		assert.deepEqual(writes, []);
		const reloaded = await loadPlugin(version);
		assert.equal(await reloaded.plugin.oauthStorage.load(), null);
	});
}

for (const version of ["1.11.4", "1.13.1"]) {
	test(`Obsidian ${version}에서는 Secret storage에서 로그인 정보를 복원한다`, async () => {
		const values = new Map();
		const secrets = { getSecret: key => values.get(key) ?? null, setSecret: (key, value) => values.set(key, value) };
		const { plugin, writes } = await loadPlugin(version, secrets);
		assert.equal(plugin.oauthStorage.persistent, true);
		await plugin.oauthStorage.save(session);
		assert.equal(writes.length, 1);
		assert.match(writes[0].oauthSecretId, /^image-paste-github-[a-f0-9]{32}$/);
		assert.ok(!JSON.stringify(writes).includes(session.accessToken));
		assert.ok(!JSON.stringify(writes).includes(session.refreshToken));
		const reloaded = await loadPlugin(version, secrets, writes[0]);
		assert.equal(reloaded.plugin.auth.connected, true);
		assert.equal(await reloaded.plugin.accessToken(), session.accessToken);
		assert.deepEqual(reloaded.notices, []);
	});
}
