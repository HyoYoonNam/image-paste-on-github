const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { buildSync } = require("esbuild");

const compiled = buildSync({
 entryPoints: [path.join(__dirname, "../src/main.ts")],
 bundle: true, write: false, external: ["obsidian", "./heic"],
 format: "cjs", target: "es2018"
}).outputFiles[0].text;

async function fixture(settings = {}) {
	const requests = [];
	let settingTab;
	class Plugin {
		async loadData() {
			return { githubToken: "fake", owner: "example", repo: "images", ...settings };
		}
		registerEvent() {}
		registerObsidianProtocolHandler() {}
		async saveData() {}
		addSettingTab(tab) { settingTab = tab; }
	}
	class PluginSettingTab {}
	const obsidian = {
		Plugin,
		PluginSettingTab,
		Notice: class {},
		arrayBufferToBase64: (buffer) => Buffer.from(buffer).toString("base64"),
		normalizePath: (value) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
		requestUrl: async (request) => {
			requests.push(request);
			return request.method === "GET"
				? { status: 200, json: { private: false, permissions: { push: true } } }
				: { status: 201, json: {} };
		},
	};
	const sandbox = {
		module: { exports: {} },
		require(name) {
			if (name === "./heic") return { convertHeicToJpeg() { throw new Error("Unexpected conversion"); } };
			assert.equal(name, "obsidian");
			return obsidian;
		},
	};
	vm.runInNewContext(compiled, sandbox, { filename: "main.cjs" });
	const plugin = new sandbox.module.exports.default();
	plugin.app = { workspace: { on() {} } };
	await plugin.onload();
	return { plugin, requests, settingTab };
}

function image(type = "image/png") {
	return {
		type,
		arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
	};
}

test("기본 경로 업로드는 요청 본문과 raw 이미지 경로를 유지한다", async () => {
	const f = await fixture();
	const raw = new URL(await f.plugin.uploadToGithub(image()));
	const request = f.requests[0];
	const api = new URL(request.url);
	const filename = api.pathname.split("/").pop();
	assert.match(filename, /^pasted-\d+-[a-z0-9]+\.png$/);
	assert.equal(api.pathname, `/repos/example/images/contents/assets/${filename}`);
	assert.equal(raw.pathname, `/example/images/main/assets/${filename}`);
	assert.deepEqual(JSON.parse(request.body), {
		message: `Add ${filename} via Image Paste on GitHub`,
		content: "AQID",
		branch: "main",
	});
	assert.equal(request.method, "PUT");
});

test("업로드 경로 특수문자를 인코딩하고 디렉터리 구분을 유지한다", async () => {
	const uploadPath = "assets/한글 #?% (draft)/a!b'c*d";
	const f = await fixture({ uploadPath });
	const raw = new URL(await f.plugin.uploadToGithub(image()));
	const api = new URL(f.requests[0].url);
	const encodedFolders = "assets/%ED%95%9C%EA%B8%80%20%23%3F%25%20%28draft%29/a%21b%27c%2Ad";
	const filename = api.pathname.split("/").pop();
	assert.equal(api.pathname, `/repos/example/images/contents/${encodedFolders}/${filename}`);
	assert.equal(raw.pathname, `/example/images/main/${encodedFolders}/${filename}`);
	for (const url of [api, raw]) {
		assert.equal(url.search, "");
		assert.equal(url.hash, "");
		assert.doesNotMatch(url.href, /[\s!'()*]/);
	}
});

test("퍼센트로 시작하는 경로 이름을 미리 디코딩하지 않는다", async () => {
	const f = await fixture({ uploadPath: "assets/literal%2Ffolder/100%" });
	const raw = new URL(await f.plugin.uploadToGithub(image()));
	const api = new URL(f.requests[0].url);
	assert.match(api.pathname, /\/assets\/literal%252Ffolder\/100%25\//);
	assert.match(raw.pathname, /\/assets\/literal%252Ffolder\/100%25\//);
	assert.equal(decodeURIComponent(raw.pathname.split("/")[5]), "literal%2Ffolder");
});

test("슬래시가 있는 브랜치는 raw URL 한 구간으로 인코딩하고 요청 본문은 원문을 사용한다", async () => {
	const branch = "feature/screens#2026(1)%";
	const f = await fixture({ branch });
	const raw = new URL(await f.plugin.uploadToGithub(image()));
	assert.match(raw.pathname, /^\/example\/images\/feature%2Fscreens%232026%281%29%25\/assets\//);
	assert.equal(raw.hash, "");
	assert.equal(JSON.parse(f.requests[0].body).branch, branch);
});

test("빈 브랜치 설정은 기존 main 기본값을 유지한다", async () => {
	const f = await fixture({ branch: "" });
	const raw = new URL(await f.plugin.uploadToGithub(image()));
	assert.match(raw.pathname, /^\/example\/images\/main\/assets\//);
	assert.equal(JSON.parse(f.requests[0].body).branch, "main");
});

test("owner와 repo 설정의 예약 문자가 업로드 URL 구조를 바꾸지 않는다", async () => {
	const f = await fixture({ owner: "owner/#?", repo: "repo% (draft)" });
	const raw = new URL(await f.plugin.uploadToGithub(image()));
	const api = new URL(f.requests[0].url);
	assert.match(api.pathname, /^\/repos\/owner%2F%23%3F\/repo%25%20%28draft%29\/contents\/assets\//);
	assert.match(raw.pathname, /^\/owner%2F%23%3F\/repo%25%20%28draft%29\/main\/assets\//);
	assert.equal(api.origin, "https://api.github.com");
	assert.equal(raw.origin, "https://raw.githubusercontent.com");
	assert.equal(api.search + api.hash + raw.search + raw.hash, "");
});

test("연결 테스트도 owner와 repo를 각각 URL 구간으로 인코딩한다", async () => {
	const f = await fixture({ owner: "owner/#?", repo: "repo% (draft)" });
	await f.settingTab.testConnection();
	assert.equal(f.requests.length, 1);
	assert.equal(f.requests[0].method, "GET");
	assert.equal(f.requests[0].url, "https://api.github.com/repos/owner%2F%23%3F/repo%25%20%28draft%29");
});

for (const [type, extension] of [
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/svg+xml", "svg"],
	["image/bmp", "bmp"],
	["image/avif", "avif"],
]) {
	test(`${type} 업로드는 .${extension} 확장자와 원본 바이트를 사용한다`, async () => {
		const f = await fixture();
		const raw = new URL(await f.plugin.uploadToGithub(image(type)));
		assert.equal(f.requests.length, 1);
		assert.ok(new URL(f.requests[0].url).pathname.endsWith(`.${extension}`));
		assert.ok(raw.pathname.endsWith(`.${extension}`));
		assert.equal(JSON.parse(f.requests[0].body).content, "AQID");
	});
}

test("미지원 MIME의 직접 업로드는 바이트 읽기와 요청 전에 거절한다", async () => {
	for (const type of ["image/heic", "image/jpg", "", "constructor", "toString"]) {
		const f = await fixture();
		let reads = 0;
		await assert.rejects(
			f.plugin.uploadToGithub({
				type,
				arrayBuffer: async () => { reads++; return new Uint8Array([1]).buffer; },
			}),
			/Unsupported image type/
		);
		assert.equal(reads, 0, type);
		assert.equal(f.requests.length, 0, type);
	}
});

test("바이트를 읽는 동안 플러그인이 종료되면 GitHub 요청을 보내지 않는다", async () => {
	const f = await fixture(); let finishReading;
	const upload = f.plugin.uploadToGithub({ type: "image/jpeg", arrayBuffer: () => new Promise(resolve => { finishReading = resolve; }) });
	f.plugin.onunload(); finishReading(new Uint8Array([255, 216, 255, 217]).buffer);
	await assert.rejects(upload, () => true); assert.equal(f.requests.length, 0);
});

test("요청 직전 원본 placeholder가 취소되면 GitHub 요청을 보내지 않는다", async () => {
	const f = await fixture();
	await assert.rejects(f.plugin.uploadToGithub(image("image/jpeg"), async () => false), () => true);
	assert.equal(f.requests.length, 0);
});

test("기존 PAT 설정은 PAT 모드를 유지하고 기존 토큰으로 업로드한다", async () => {
	const f = await fixture();
	assert.equal(f.plugin.settings.authMode, "pat");
	await f.plugin.uploadToGithub(image());
	assert.equal(f.requests[0].headers.Authorization, "Bearer fake");
});

test("브라우저 로그인 업로드는 PAT 대신 OAuth 토큰을 사용하고 선택 전에는 준비되지 않는다", async () => {
	const f = await fixture({ authMode: "github", oauthRepositoryId: 0 });
	f.plugin.auth = { revision: 1, connected: true, getAccessToken: async () => "browser-token" };
	assert.equal(f.plugin.isConfigured(), false);
	f.plugin.settings.oauthRepositoryId = 123;
	assert.equal(f.plugin.isConfigured(), true);
	await f.plugin.uploadToGithub(image());
	assert.equal(f.requests[0].headers.Authorization, "Bearer browser-token");
	assert.equal(f.plugin.settings.githubToken, "fake");
});

test("OAuth 연결이 만료되어도 저장된 PAT로 자동 업로드하지 않는다", async () => {
	const f = await fixture({ authMode: "github", oauthRepositoryId: 123 });
	f.plugin.auth = { revision: 1, connected: true, getAccessToken: async () => { throw new Error("Reconnect"); } };
	await assert.rejects(f.plugin.uploadToGithub(image()), /Reconnect/);
	assert.equal(f.requests.length, 0);
});

test("마지막 노트 확인을 기다리는 중 로그아웃하면 확보한 OAuth 토큰으로 PUT을 보내지 않는다", async () => {
	const f = await fixture({ authMode: "github", oauthRepositoryId: 123 });
	f.plugin.auth = { revision: 1, connected: true, getAccessToken: async () => "browser-token" };
	let checks = 0;
	await assert.rejects(f.plugin.uploadToGithub(image(), async () => {
		checks++;
		if (checks === 2) { f.plugin.auth.revision++; f.plugin.auth.connected = false; }
		return true;
	}), /connection changed/);
	assert.equal(f.requests.length, 0);
});
