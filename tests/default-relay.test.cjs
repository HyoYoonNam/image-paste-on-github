const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const defaultRelay = "https://image-paste-auth.dev-rudevico.workers.dev";

function productionBundle(t, override) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-paste-default-relay-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.symlinkSync(path.join(root, "src"), path.join(directory, "src"), "junction");
	const env = { ...process.env };
	if (override === undefined) delete env.IMAGE_PASTE_AUTH_RELAY_URL;
	else env.IMAGE_PASTE_AUTH_RELAY_URL = override;
	// Run the real production build configuration without changing the workspace bundle.
	execFileSync(process.execPath, [path.join(root, "esbuild.config.mjs"), "production"], {
		cwd: directory, env, stdio: "pipe",
	});
	return fs.readFileSync(path.join(directory, "main.js"), "utf8");
}

async function loadSettings(bundle, stored = null) {
	class Plugin {
		async loadData() { return stored; }
	}
	const obsidian = {
		Plugin, PluginSettingTab: class {}, MarkdownView: class {},
		requestUrl() { throw new Error("No network request is allowed while loading settings."); },
	};
	const sandbox = {
		module: { exports: {} },
		require(name) { assert.equal(name, "obsidian"); return obsidian; },
	};
	vm.runInNewContext(bundle, sandbox, { filename: "production-default-relay.cjs" });
	const plugin = new sandbox.module.exports.default();
	await plugin.loadSettings();
	return plugin;
}

test("환경변수가 없으면 실제 production bundle의 새 설정에 배포된 relay를 사용한다", async t => {
	const bundle = productionBundle(t);
	for (const stored of [null, {}]) {
		const plugin = await loadSettings(bundle, stored);
		assert.equal(plugin.settings.authRelayUrl, defaultRelay);
		assert.equal(plugin.settings.authMode, "github");
		assert.equal(plugin.settings.githubToken, "");
		assert.equal(plugin.settings.oauthSecretId, "");
	}
});

test("빌드 환경변수로 relay를 바꾸면 production bundle과 새 설정에 그 주소만 사용한다", async t => {
	const customRelay = "https://custom-auth.example.test";
	const bundle = productionBundle(t, customRelay);
	const plugin = await loadSettings(bundle);
	assert.equal(plugin.settings.authRelayUrl, customRelay);
	assert.ok(!bundle.includes(defaultRelay));
});

test("명시적으로 빈 빌드 환경변수는 기본 relay를 넣지 않는다", async t => {
	const bundle = productionBundle(t, "");
	const plugin = await loadSettings(bundle);
	assert.equal(plugin.settings.authRelayUrl, "");
	assert.ok(!bundle.includes(defaultRelay));
});

test("새 기본 주소가 기존 사용자 지정 주소, 저장된 빈 주소, PAT 설정을 덮어쓰지 않는다", async t => {
	const bundle = productionBundle(t);
	for (const stored of [
		{ authMode: "github", authRelayUrl: "https://saved-auth.example.test", oauthRepositoryId: 123 },
		{ authMode: "github", authRelayUrl: "" },
		{ authMode: "pat", authRelayUrl: "https://saved-auth.example.test", githubToken: "existing-pat", owner: "example", repo: "images", branch: "photos", uploadPath: "pictures" },
		{ githubToken: "legacy-pat", owner: "legacy", repo: "images" },
	]) {
		const before = JSON.parse(JSON.stringify(stored));
		const plugin = await loadSettings(bundle, stored);
		for (const [key, value] of Object.entries(stored)) assert.equal(plugin.settings[key], value, key);
		assert.deepEqual(stored, before);
		if (stored.githubToken) {
			assert.equal(plugin.settings.authMode, "pat");
			assert.equal(await plugin.accessToken(), stored.githubToken);
			assert.equal(plugin.isConfigured(), true);
		}
	}
});
