const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

const compiled = transformSync(
	fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8"),
	{ loader: "ts", format: "cjs", target: "es2018" }
).code;

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function image(type = "image/png") {
	return { type, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
}

class Editor {
	constructor(text = "") { this.text = text; }
	getValue() { return this.text; }
	replaceSelection(value) { this.text += value; }
	replaceRange(value, from, to) {
		const rows = this.text.split("\n");
		const start = rows.slice(0, from.line).reduce((sum, row) => sum + row.length + 1, 0);
		this.text = this.text.slice(0, start + from.ch) + value + this.text.slice(start + to.ch);
	}
}

async function fixture() {
	const events = new Map(), jobs = [], uploads = [];
	class Plugin {
		async loadData() { return { githubToken: "fake", owner: "example", repo: "images" }; }
		registerEvent() {}
		addSettingTab() {}
	}
	class PluginSettingTab {}
	const obsidian = {
		Plugin, PluginSettingTab,
		Notice: class {},
		requestUrl: () => { throw new Error("실제 네트워크 요청은 허용하지 않음"); }
	};
	const sandbox = { module: { exports: {} }, Error, require(name) { assert.equal(name, "obsidian"); return obsidian; }, console: { error() {} } };
	vm.runInNewContext(compiled, sandbox, { filename: "main.cjs" });
	const plugin = new sandbox.module.exports.default();
	plugin.app = { workspace: { on(name, callback) { events.set(name, callback); } } };
	await plugin.onload();
	plugin.uploadToGithub = () => { const upload = deferred(); uploads.push(upload); return upload.promise; };
	const uploadAndInsert = plugin.uploadAndInsert.bind(plugin);
	plugin.uploadAndInsert = (...args) => { const job = uploadAndInsert(...args); jobs.push(job); return job; };
	function addFile(filePath, text = "") { return { path: filePath, text }; }
	function open(file) { return { file, editor: new Editor(file.text) }; }
	function emit(view, fileList = [image()], kind = "editor-paste", alreadyPrevented = false) {
		const event = { defaultPrevented: alreadyPrevented, clipboardData: { files: fileList }, dataTransfer: { files: fileList }, preventDefault() { this.defaultPrevented = true; } };
		events.get(kind)(event, view.editor, view); return event;
	}
	return { plugin, jobs, uploads, addFile, open, emit };
}

for (const kind of ["editor-paste", "editor-drop"]) {
	for (const type of ["application/pdf", ""]) {
		test(`${kind}: 이미지와 ${type || "빈 MIME"} 첨부는 모두 기본 처리에 맡긴다`, async () => {
			const f = await fixture(), view = f.open(f.addFile("A/note.md", "본문"));
			const event = f.emit(view, [image(), { type }], kind);
			assert.equal(event.defaultPrevented, false); assert.equal(f.uploads.length, 0); assert.equal(view.editor.text, "본문");
		});
	}
}

test("이미지 전용 붙여넣기는 각 placeholder를 완료 순서와 무관하게 교체한다", async () => {
	const f = await fixture(), view = f.open(f.addFile("A/note.md", "본문\n"));
	assert.equal(f.emit(view, [image(), image()]).defaultPrevented, true);
	f.uploads[1].resolve("https://example.com/second.png"); await f.jobs[1];
	f.uploads[0].resolve("https://example.com/first.png"); await f.jobs[0];
	assert.equal(view.editor.text, "본문\n![](https://example.com/first.png)\n![](https://example.com/second.png)\n");
});

test("다른 플러그인이 처리한 이벤트와 설정이 없는 경우는 기본 동작을 유지한다", async () => {
	const f = await fixture(), view = f.open(f.addFile("note.md", "본문"));
	f.emit(view, [image()], "editor-paste", true);
	assert.equal(f.uploads.length, 0);
	f.plugin.settings.githubToken = "";
	assert.equal(f.emit(view).defaultPrevented, false); assert.equal(view.editor.text, "본문");
});
