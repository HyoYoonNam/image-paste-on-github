const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const source = buildSync({ entryPoints: [path.join(__dirname, "../src/github-repositories.ts")], bundle: true, write: false, format: "cjs" }).outputFiles[0].text;
const context = { module: { exports: {} } };
vm.runInNewContext(source, context);
const { listImageRepositories } = context.module.exports;
const installation = { id: 10, permissions: { contents: "write" }, suspended_at: null };
const repo = { id: 20, name: "images", owner: { login: "example" }, default_branch: "photos", private: false, permissions: { push: true } };

test("App과 사용자 모두 쓸 수 있는 공개 저장소만 선택 목록에 표시한다", async () => {
	const calls = [];
	const repositories = await listImageRepositories(async path => {
		calls.push(path);
		if (path.startsWith("/user/installations?")) return { installations: [installation, { ...installation, id: 11, permissions: { contents: "read" } }, { ...installation, id: 12, suspended_at: "today" }] };
		return { repositories: [repo, { ...repo, id: 21, private: true }, { ...repo, id: 22, permissions: { push: false } }, { ...repo, id: 23, permissions: undefined }, { ...repo, id: 24, archived: true }] };
	});
	assert.deepEqual(JSON.parse(JSON.stringify(repositories)), [{ id: 20, owner: "example", name: "images", defaultBranch: "photos" }]);
	assert.equal(calls.length, 2);
	assert.equal(calls[1], "/user/installations/10/repositories?per_page=100&page=1");
});

test("저장소 페이지를 끝까지 읽고 중복 ID를 제거한다", async () => {
	const calls = [];
	const repositories = await listImageRepositories(async path => {
		calls.push(path);
		if (path.startsWith("/user/installations?")) return { installations: [installation] };
		return { repositories: path.endsWith("page=1") ? Array(100).fill(repo) : [{ ...repo, id: 21, name: "another" }, repo] };
	});
	assert.equal(repositories.length, 2);
	assert.ok(calls.some(path => path.endsWith("repositories?per_page=100&page=2")));
});

test("설치가 없으면 빈 목록을 반환하고 알 수 없는 응답은 성공으로 취급하지 않는다", async () => {
	assert.equal((await listImageRepositories(async () => ({ installations: [] }))).length, 0);
	await assert.rejects(listImageRepositories(async () => ({ message: "forbidden" })), /invalid installation list/);
	await assert.rejects(listImageRepositories(async path => path.startsWith("/user/installations?") ? { installations: [installation] } : { message: "forbidden" }), /invalid repository list/);
});

test("설치 ID가 URL 구조를 바꾸거나 정수 범위를 벗어나면 요청하지 않는다", async () => {
	let calls = 0;
	assert.equal((await listImageRepositories(async () => {
		calls++;
		return { installations: [{ ...installation, id: "../other" }, { ...installation, id: Number.MAX_SAFE_INTEGER + 1 }] };
	})).length, 0);
	assert.equal(calls, 1);
});
