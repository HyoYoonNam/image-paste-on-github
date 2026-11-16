const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "../..");

function bootstrapSettings() {
	globalThis.module = { exports: {} };
	const copy = value => JSON.parse(JSON.stringify(value));
	const state = { data: null, saved: [], requests: [], opened: [], notices: [], protocols: new Map(), start: null };
	const relay = "https://auth.example.test";
	window.open = url => { state.opened.push(String(url)); return null; };
	HTMLElement.prototype.empty = function () { this.replaceChildren(); };
	HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
	HTMLElement.prototype.createEl = function (tag, options = {}) {
		const element = document.createElement(tag);
		if (options.text) element.textContent = options.text;
		if (options.cls) element.className = options.cls;
		this.append(element); return element;
	};
	HTMLElement.prototype.createDiv = function (options) { return this.createEl("div", options); };

	class Component {
		constructor(element) { this.element = element; this.inputEl = element; this.buttonEl = element; }
		setValue(value) {
			if (this.element.type === "checkbox") this.element.checked = value;
			else this.element.value = value;
			return this;
		}
		setPlaceholder(value) { this.element.placeholder = value; return this; }
		setDisabled(value) { this.element.disabled = value; return this; }
		setButtonText(value) { this.element.textContent = value; return this; }
		addOption(value, label) {
			const option = document.createElement("option"); option.value = value; option.textContent = label;
			this.element.append(option); return this;
		}
		onChange(callback) {
			this.element.addEventListener(this.element.tagName === "INPUT" && this.element.type !== "checkbox" ? "input" : "change", () => {
				void callback(this.element.type === "checkbox" ? this.element.checked : this.element.value);
			}); return this;
		}
		onClick(callback) { this.element.addEventListener("click", () => { void callback(); }); return this; }
	}
	class Setting {
		constructor(container) {
			this.settingEl = container.createDiv({ cls: "setting-item" });
			this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
			this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
			this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
		}
		setName(value) { this.nameEl.textContent = value; return this; }
		setDesc(value) { this.descEl.textContent = value; return this; }
		add(tag, callback, type) {
			const element = this.controlEl.createEl(tag);
			if (type) element.type = type;
			element.setAttribute("aria-label", this.nameEl.textContent);
			callback(new Component(element)); return this;
		}
		addText(callback) { return this.add("input", callback, "text"); }
		addDropdown(callback) { return this.add("select", callback); }
		addButton(callback) { return this.add("button", callback, "button"); }
		addToggle(callback) { return this.add("input", callback, "checkbox"); }
	}
	globalThis.require = name => {
		if (name !== "obsidian") throw new Error(`Unexpected external module: ${name}`);
		return {
			Plugin: class {
				async loadData() { return copy(state.data); }
				async saveData(data) { state.saved.push(copy(data)); state.data = copy(data); }
				registerEvent() {}
				registerObsidianProtocolHandler(name, callback) { state.protocols.set(name, callback); }
				addSettingTab(tab) { state.tab = tab; }
			},
			PluginSettingTab: class { constructor() { this.containerEl = document.body.createDiv(); } },
			Setting,
			MarkdownView: class {},
			Notice: class { constructor(message) { state.notices.push(message); } },
			normalizePath: value => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
			async requestUrl(request) {
				state.requests.push(copy(request));
				const url = new URL(request.url);
				if (url.origin === relay && url.pathname === "/auth/config") return { status: 200, json: {
					clientId: "Iv1.browser-test", appSlug: "image-paste-test", callbackUrl: `${relay}/auth/callback`,
					installationUrl: "https://github.com/apps/image-paste-test/installations/new",
				} };
				if (url.origin === relay && url.pathname === "/auth/start") {
					state.start = JSON.parse(request.body);
					const authorization = new URL("https://github.com/login/oauth/authorize");
					for (const [key, value] of Object.entries({ client_id: "Iv1.browser-test", redirect_uri: `${relay}/auth/callback`,
						code_challenge: state.start.codeChallenge, code_challenge_method: "S256", state: "server-test-state" })) authorization.searchParams.set(key, value);
					return { status: 200, json: { transactionId: "browser-transaction", authorizationUrl: authorization.href, expiresAt: Date.now() + 300_000 } };
				}
				if (url.origin === relay && url.pathname === "/auth/complete") return { status: 200, json: {
					access_token: "mock-browser-access", refresh_token: "mock-browser-refresh", token_type: "bearer",
					expires_in: 28_800, refresh_token_expires_in: 15_897_600,
				} };
				if (url.origin === relay && ["/auth/cancel", "/auth/revoke"].includes(url.pathname)) return { status: 204 };
				if (url.origin === "https://api.github.com" && url.pathname === "/user/installations") return { status: 200, json: {
					installations: [{ id: 17, permissions: { contents: "write" }, suspended_at: null }],
				} };
				if (url.origin === "https://api.github.com" && url.pathname === "/user/installations/17/repositories") return { status: 200, json: {
					repositories: [{ id: 42, name: "demo-images", owner: { login: "example" }, default_branch: "main",
						private: false, permissions: { push: true } }],
				} };
				throw new Error(`Unexpected mock API request: ${url.origin}${url.pathname}`);
			},
		};
	};
	globalThis.startSettingsTest = async data => {
		state.data = copy(data);
		const plugin = new module.exports.default();
		plugin.app = { workspace: { on() {} } };
		await plugin.onload();
		state.plugin = plugin;
		state.tab.display();
		globalThis.settingsTest = state;
	};
}

test("배포 번들의 인증 설정 UI를 외부 요청 없이 검증한다", { timeout: 60_000 }, async t => {
	const assets = new Map([
		["/", ["text/html", Buffer.from('<!doctype html><html><head><script src="/bootstrap.js"></script></head><body><script src="/main.js"></script></body></html>')]],
		["/bootstrap.js", ["text/javascript", Buffer.from(`(${bootstrapSettings.toString()})();`)]],
		["/main.js", ["text/javascript", fs.readFileSync(path.join(root, "main.js"))]],
	]);
	const server = http.createServer((request, response) => {
		response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob:");
		const asset = assets.get(request.url);
		if (!asset) { response.writeHead(404); response.end(); return; }
		response.setHeader("Content-Type", asset[0]); response.end(asset[1]);
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
	const origin = `http://127.0.0.1:${server.address().port}`;
	const options = process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : { channel: "chrome" };
	const browser = await chromium.launch({ ...options, headless: true });
	t.after(() => browser.close());
	const externalRequests = [], pageErrors = [];
	async function openPage(data) {
		const context = await browser.newContext();
		await context.route("**/*", route => {
			const url = route.request().url();
			if (url.startsWith(origin + "/")) return route.continue();
			externalRequests.push(url); return route.abort();
		});
		const page = await context.newPage();
		page.on("pageerror", error => pageErrors.push(error.message));
		await page.goto(origin);
		await page.evaluate(data => startSettingsTest(data), data);
		return page;
	}
	const button = (page, text) => page.locator("button").filter({ hasText: new RegExp(`^${text}$`) });

	await t.test("처음 설치하면 기본 relay로 GitHub 연결 버튼을 활성화한다", async () => {
		const page = await openPage(null);
		assert.equal(await button(page, "Connect with GitHub").isDisabled(), false);
		assert.equal(await page.getByLabel("Image repository", { exact: true }).isVisible(), true);
		assert.equal(await page.locator("details").evaluate(element => element.open), false);
		assert.equal(await page.getByLabel("GitHub token", { exact: true }).isVisible(), false);
		assert.match(await page.locator("body").innerText(), /Sign in through GitHub and select your image repository/);
		assert.match(await page.locator("body").innerText(), /only for this session/);
		const result = await page.evaluate(() => ({ mode: settingsTest.plugin.settings.authMode, relay: settingsTest.plugin.settings.authRelayUrl,
			requests: settingsTest.requests.length, opened: settingsTest.opened.length }));
		assert.equal(result.mode, "github");
		assert.equal(new URL(result.relay).protocol, "https:");
		assert.equal(result.requests, 0); assert.equal(result.opened, 0);
	});

	await t.test("명시적으로 빈 relay를 저장했으면 기본 주소로 바꾸지 않고 연결을 비활성화한다", async () => {
		const page = await openPage({ authRelayUrl: "" });
		assert.equal(await button(page, "Connect with GitHub").isDisabled(), true);
		assert.match(await page.locator("body").innerText(), /Configure a trusted relay in Advanced settings/);
		assert.equal(await page.locator("details").evaluate(element => element.open), false);
		const result = await page.evaluate(() => ({ mode: settingsTest.plugin.settings.authMode, relay: settingsTest.plugin.settings.authRelayUrl,
			requests: settingsTest.requests.length, opened: settingsTest.opened.length }));
		assert.deepEqual(result, { mode: "github", relay: "", requests: 0, opened: 0 });
	});

	await t.test("기존 PAT 설정을 유지하고 비밀번호 입력을 닫힌 Advanced 안에 둔다", async () => {
		const original = { owner: "legacy-owner", repo: "legacy-images", branch: "images", uploadPath: "legacy-assets", githubToken: "mock-legacy-pat" };
		const page = await openPage(original);
		assert.equal(await page.locator("details").evaluate(element => element.open), false);
		assert.equal(await page.getByLabel("GitHub token", { exact: true }).getAttribute("type"), "password");
		assert.equal(await page.getByLabel("GitHub token", { exact: true }).isVisible(), false);
		assert.equal(await page.getByLabel("Image repository", { exact: true }).count(), 0);
		assert.match(await page.locator("body").innerText(), /Using your existing PAT/);
		assert.doesNotMatch(await page.locator("body").innerText(), /mock-legacy-pat/);
		await page.getByText("Advanced settings", { exact: true }).click();
		assert.equal(await page.getByLabel("Authentication method", { exact: true }).inputValue(), "pat");
		assert.equal(await page.getByLabel("GitHub token", { exact: true }).inputValue(), original.githubToken);
		assert.equal(await page.getByLabel("Owner", { exact: true }).inputValue(), original.owner);
		assert.equal(await page.getByLabel("Repository", { exact: true }).inputValue(), original.repo);
		const result = await page.evaluate(() => ({ settings: settingsTest.plugin.settings, saved: settingsTest.saved.length, requests: settingsTest.requests.length }));
		for (const [key, value] of Object.entries(original)) assert.equal(result.settings[key], value);
		assert.equal(result.settings.authMode, "pat"); assert.equal(result.saved, 0); assert.equal(result.requests, 0);
	});

	await t.test("mock 브라우저 승인 뒤 공개 저장소를 선택하며 OAuth 토큰을 data.json에 쓰지 않는다", async () => {
		const page = await openPage({ authRelayUrl: "https://auth.example.test" });
		assert.equal(await button(page, "Connect with GitHub").isDisabled(), false);
		await button(page, "Connect with GitHub").click();
		await button(page, "Complete sign in").waitFor({ state: "visible" });
		const pending = await page.evaluate(() => ({ pending: settingsTest.plugin.auth.pending, opened: settingsTest.opened }));
		assert.equal(pending.pending, true); assert.equal(pending.opened.length, 1);
		const authorization = new URL(pending.opened[0]);
		assert.equal(authorization.origin, "https://github.com");
		assert.equal(authorization.pathname, "/login/oauth/authorize");
		assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
		assert.equal(authorization.searchParams.has("code_verifier"), false);
		await page.evaluate(() => settingsTest.protocols.get("image-paste-on-github-auth")({ transaction_id: "browser-transaction", state: settingsTest.start.clientState }));
		await button(page, "Disconnect").waitFor({ state: "visible" });
		await page.waitForFunction(() => [...document.querySelectorAll("option")].some(option => option.textContent === "example/demo-images"));
		await page.getByLabel("Image repository", { exact: true }).selectOption("42");
		await page.waitForFunction(() => settingsTest.plugin.settings.oauthRepositoryId === 42 && settingsTest.saved.at(-1).oauthRepositoryId === 42);
		const result = await page.evaluate(() => ({ connected: settingsTest.plugin.auth.connected, configured: settingsTest.plugin.isConfigured(),
			settings: settingsTest.plugin.settings, saved: settingsTest.saved, requests: settingsTest.requests }));
		assert.equal(result.connected, true); assert.equal(result.configured, true);
		assert.equal(result.settings.owner, "example"); assert.equal(result.settings.repo, "demo-images");
		assert.equal(result.settings.branch, "main");
		assert.doesNotMatch(JSON.stringify(result.saved), /mock-browser-access|mock-browser-refresh/);
		const githubRequests = result.requests.filter(request => new URL(request.url).origin === "https://api.github.com");
		assert.equal(githubRequests.length, 2);
		assert.ok(githubRequests.every(request => request.headers.Authorization === "Bearer mock-browser-access"));
		assert.equal(await page.locator("details").evaluate(element => element.open), false);
	});
	assert.deepEqual(externalRequests, []);
	assert.deepEqual(pageErrors, []);
});
