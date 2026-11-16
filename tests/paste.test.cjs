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
	const events = new Map(), files = new Map(), contents = new Map();
	const notices = [], jobs = [], uploads = [], localFiles = [], attachmentSources = [], linkSources = [];
	const processCalls = [], processWrites = [], leaves = [];
	const localWrites = [];
	class MarkdownView {
		constructor(file, editor) { this.file = file; this.editor = editor; }
	}
	class Plugin {
		async loadData() { return { githubToken: "fake", owner: "example", repo: "images" }; }
		registerEvent() {}
		addSettingTab() {}
	}
	class PluginSettingTab {}
	const obsidian = {
		Plugin, PluginSettingTab, MarkdownView,
		Notice: class { constructor(message) { notices.push(message); } },
		requestUrl: () => { throw new Error("실제 네트워크 요청은 허용하지 않음"); }
	};
	const sandbox = { module: { exports: {} }, Error, require(name) { assert.equal(name, "obsidian"); return obsidian; }, console: { error() {} } };
	vm.runInNewContext(compiled, sandbox, { filename: "main.cjs" });
	const plugin = new sandbox.module.exports.default();
	const state = { processBefore: null };
	function addFile(filePath, text = "") {
		const file = { path: filePath, extension: filePath.split(".").pop() };
		files.set(filePath, file); contents.set(file, text); return file;
	}
	function rename(file, newPath) { files.delete(file.path); file.path = newPath; files.set(newPath, file); }
	function open(file, text = contents.get(file)) {
		const view = new MarkdownView(file, new Editor(text)); leaves.push({ view }); return view;
	}
	function close(view) {
		contents.set(view.file, view.editor.getValue());
		leaves.splice(leaves.findIndex(leaf => leaf.view === view), 1);
	}
	function switchTo(view, file) {
		contents.set(view.file, view.editor.getValue());
		view.file = file; view.editor.text = contents.get(file);
	}
	plugin.app = {
		workspace: {
			on(name, callback) { events.set(name, callback); },
			getLeavesOfType() { return leaves; },
			getActiveFile() { throw new Error("활성 파일에 의존하면 안 됨"); }
		},
		vault: {
			getAbstractFileByPath(filePath) { return files.get(filePath) ?? null; },
			async read(file) { return contents.get(file); },
			async process(file, update) {
				processCalls.push(file);
				if (state.processBefore) await state.processBefore(file);
				const result = update(contents.get(files.get(file.path)));
				processWrites.push(file.path); contents.set(files.get(file.path), result); return result;
			},
			async createBinary(filePath, buffer) {
				localWrites.push({ filePath, bytes: [...new Uint8Array(buffer)] });
				const file = addFile(filePath); localFiles.push(file); return file;
			}
		},
		fileManager: {
			async getAvailablePathForAttachment(filename, source) {
				attachmentSources.push(source); return path.posix.join(path.posix.dirname(source), "attachments", filename);
			},
			generateMarkdownLink(file, source) {
				linkSources.push(source); return `[[${path.posix.relative(path.posix.dirname(source), file.path)}]]`;
			}
		}
	};
	await plugin.onload();
	plugin.uploadToGithub = () => { const upload = deferred(); uploads.push(upload); return upload.promise; };
	const uploadAndInsert = plugin.uploadAndInsert.bind(plugin);
	plugin.uploadAndInsert = (...args) => { const job = uploadAndInsert(...args); jobs.push(job); return job; };
	function emit(view, fileList = [image()], kind = "editor-paste", alreadyPrevented = false) {
		const event = { defaultPrevented: alreadyPrevented, clipboardData: { files: fileList }, dataTransfer: { files: fileList }, preventDefault() { this.defaultPrevented = true; } };
		events.get(kind)(event, view.editor, view); return event;
	}
	return { plugin, state, files, contents, notices, jobs, uploads, localFiles, localWrites, attachmentSources, linkSources, processCalls, processWrites, addFile, rename, open, close, switchTo, emit };
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

test("파일 없는 편집기와 Canvas 파일은 기본 처리에 맡긴다", async () => {
	const f = await fixture();
	for (const file of [null, f.addFile("board.canvas", "{}")]) {
		const view = f.open(file, "원문");
		assert.equal(f.emit(view).defaultPrevented, false); assert.equal(view.editor.text, "원문");
	}
	assert.equal(f.uploads.length, 0);
});

test("열린 MarkdownView에 속하지 않는 임베드 편집기는 기본 처리에 맡긴다", async () => {
	const f = await fixture(), file = f.addFile("note.md", "원문");
	const info = { file, editor: new Editor("미저장 원문") };
	assert.equal(f.emit(info).defaultPrevented, false);
	assert.equal(info.editor.text, "미저장 원문"); assert.equal(f.uploads.length, 0);
});

test("같은 편집기가 B로 전환돼도 성공한 링크는 닫힌 A에만 반영한다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), b = f.addFile("B/note.md", "B");
	const view = f.open(a); f.emit(view); f.switchTo(view, b);
	f.uploads[0].resolve("https://example.com/image.png"); await f.jobs[0];
	assert.equal(view.editor.text, "B"); assert.equal(f.contents.get(a), "A\n![](https://example.com/image.png)\n");
	assert.deepEqual(f.processCalls, [a]);
});

test("실패 후 로컬 저장 경로와 상대 링크도 원본 A를 기준으로 만든다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), b = f.addFile("B/note.md", "B");
	const view = f.open(a); f.emit(view); f.switchTo(view, b);
	f.uploads[0].reject(new Error("offline")); await f.jobs[0];
	assert.deepEqual(f.attachmentSources, ["A/note.md"]); assert.deepEqual(f.linkSources, ["A/note.md"]);
	assert.match(f.contents.get(a), /!\[\[attachments\/pasted-.*\.png\]\]/); assert.equal(view.editor.text, "B");
	assert.equal(f.localFiles.length, 1);
});

test("다른 view에서 다시 연 원본은 최신 편집 내용을 보존한다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
	f.emit(view); f.close(view);
	const reopened = f.open(a); reopened.editor.text += "추가한 문장";
	f.uploads[0].resolve("https://example.com/image.png"); await f.jobs[0];
	assert.equal(reopened.editor.text, "A\n![](https://example.com/image.png)\n추가한 문장"); assert.equal(f.processCalls.length, 0);
});

test("원본 이름과 폴더가 바뀌면 이동한 파일을 기준으로 로컬 저장한다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
	f.emit(view); f.rename(a, "Moved/renamed.md");
	f.uploads[0].reject(new Error("offline")); await f.jobs[0];
	assert.deepEqual(f.attachmentSources, ["Moved/renamed.md"]); assert.deepEqual(f.linkSources, ["Moved/renamed.md"]);
	assert.match(view.editor.text, /!\[\[attachments\/pasted-/);
});

for (const succeeds of [true, false]) {
	test(`원본 삭제 후 같은 경로에 생긴 새 파일은 ${succeeds ? "성공" : "실패"} 결과로 수정하지 않는다`, async () => {
		const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
		f.emit(view); f.close(view); f.files.delete(a.path);
		const replacement = f.addFile(a.path, "새 파일");
		if (succeeds) f.uploads[0].resolve("https://example.com/image.png"); else f.uploads[0].reject(new Error("offline"));
		await f.jobs[0]; assert.equal(f.contents.get(replacement), "새 파일"); assert.equal(f.processCalls.length, 0); assert.equal(f.localFiles.length, 0);
	});
}

for (const succeeds of [true, false]) {
	test(`사용자가 placeholder를 지웠으면 ${succeeds ? "업로드 성공" : "로컬 fallback"}으로 다시 삽입하지 않는다`, async () => {
		const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
		f.emit(view); f.contents.set(a, view.editor.text); view.editor.text = "취소한 본문";
		if (succeeds) f.uploads[0].resolve("https://example.com/image.png"); else f.uploads[0].reject(new Error("offline"));
		await f.jobs[0]; assert.equal(view.editor.text, "취소한 본문"); assert.equal(f.localFiles.length, 0); assert.equal(f.processCalls.length, 0);
	});
}

test("로컬 파일 생성 준비 중 취소되어도 첨부를 생성하지 않는다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a), bytes = deferred();
	f.emit(view, [{ type: "image/png", arrayBuffer: () => bytes.promise }]);
	f.uploads[0].reject(new Error("offline")); await new Promise(resolve => setImmediate(resolve));
	view.editor.text = "취소"; bytes.resolve(new Uint8Array([1]).buffer); await f.jobs[0];
	assert.equal(f.localFiles.length, 0); assert.equal(view.editor.text, "취소");
});

for (const closed of [true, false]) {
	test(`업로드 성공 후 ${closed ? "파일" : "편집기"} 수정 실패는 로컬 복사본을 만들지 않는다`, async () => {
		const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
		f.emit(view);
		if (closed) { f.close(view); f.plugin.app.vault.process = async () => { throw new Error("write failed"); }; }
		else view.editor.replaceRange = () => { throw new Error("editor failed"); };
		f.uploads[0].resolve("https://example.com/image.png"); await f.jobs[0];
		assert.equal(f.localFiles.length, 0); assert.equal(f.notices.length, 1); assert.match(f.notices[0], /Image uploaded/);
	});
}

test("파일 처리 대기 중 다시 열린 편집기의 미저장 내용과 취소를 보존한다", async () => {
	for (const cancel of [false, true]) {
		const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a); let reopened;
		f.emit(view); f.close(view);
		f.state.processBefore = () => { reopened = f.open(a); reopened.editor.text = cancel ? "취소한 본문" : reopened.editor.text + "미저장 문장"; };
		f.uploads[0].resolve("https://example.com/image.png"); await f.jobs[0];
		const expected = cancel ? "취소한 본문" : "A\n![](https://example.com/image.png)\n미저장 문장";
		assert.equal(reopened.editor.text, expected); assert.equal(f.processWrites.length, 0); assert.equal(f.notices.length, 0);
	}
});

test("파일 처리 대기 중 원본이 이동하면 최신 경로 기준의 상대 링크를 만든다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
	f.emit(view); f.close(view); f.state.processBefore = () => f.rename(a, "B/note.md");
	f.uploads[0].reject(new Error("offline")); await f.jobs[0];
	assert.deepEqual(f.attachmentSources, ["A/note.md"]); assert.deepEqual(f.linkSources, ["B/note.md"]);
	assert.match(f.contents.get(a), /!\[\[\.\.\/A\/attachments\/pasted-/);
});

test("파일 처리 callback 직전 삭제된 원본에는 결과를 반영하지 않는다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
	f.emit(view); f.close(view); const before = f.contents.get(a); let replacement;
	f.state.processBefore = () => { f.files.delete(a.path); replacement = f.addFile(a.path, "새로 만든 다른 본문"); };
	f.uploads[0].resolve("https://example.com/image.png"); await f.jobs[0];
	assert.equal(f.contents.get(replacement), "새로 만든 다른 본문"); assert.equal(f.contents.get(a), before);
	assert.equal(f.processWrites.length, 0); assert.equal(f.notices.length, 0);
});

test("닫힌 노트에서 placeholder가 지워졌으면 파일 쓰기를 수행하지 않는다", async () => {
	const f = await fixture(), a = f.addFile("A/note.md", "A\n"), view = f.open(a);
	f.emit(view); f.close(view); f.contents.set(a, "취소된 본문");
	f.uploads[0].resolve("https://example.com/image.png"); await f.jobs[0];
	assert.equal(f.contents.get(a), "취소된 본문"); assert.equal(f.processWrites.length, 0); assert.equal(f.notices.length, 0);
});

for (const kind of ["editor-paste", "editor-drop"]) {
	test(`${kind}: 미지원 MIME가 단독 또는 혼합되어 있으면 전체 기본 처리에 맡긴다`, async () => {
		for (const type of ["image/heic", "image/jpg", "", "constructor", "toString"]) {
			for (const attachments of [[image(type)], [image(), image(type)]]) {
				const f = await fixture(), view = f.open(f.addFile("A/note.md", "원문"));
				const event = f.emit(view, attachments, kind);
				assert.equal(event.defaultPrevented, false, type);
				assert.equal(view.editor.text, "원문", type);
				assert.equal(f.uploads.length, 0, type);
				assert.equal(f.localFiles.length, 0, type);
			}
		}
	});
}

for (const [type, extension] of [
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/svg+xml", "svg"],
	["image/bmp", "bmp"],
	["image/avif", "avif"],
]) {
	test(`${type} 로컬 fallback은 .${extension} 확장자와 원본 바이트를 사용한다`, async () => {
		const f = await fixture(), view = f.open(f.addFile("A/note.md", "본문\n"));
		assert.equal(f.emit(view, [image(type)]).defaultPrevented, true);
		f.uploads[0].reject(new Error("offline"));
		await f.jobs[0];
		assert.equal(f.localWrites.length, 1);
		assert.ok(f.localWrites[0].filePath.endsWith(`.${extension}`));
		assert.deepEqual(f.localWrites[0].bytes, [1, 2, 3]);
		assert.ok(view.editor.text.includes(`.${extension}]]`));
	});
}

test("미지원 MIME의 직접 로컬 저장은 바이트 읽기와 파일 생성 전에 거절한다", async () => {
	for (const type of ["image/heic", "image/jpg", "", "constructor", "toString"]) {
		const f = await fixture(), placeholder = "![image-paste-uploading-test]()";
		const file = f.addFile("A/note.md", placeholder), view = f.open(file);
		let reads = 0;
		await assert.rejects(
			f.plugin.saveLocally({ file, editor: view.editor }, {
				type,
				arrayBuffer: async () => { reads++; return new Uint8Array([1]).buffer; },
			}, placeholder),
			/Unsupported image type/
		);
		assert.equal(reads, 0, type);
		assert.equal(f.attachmentSources.length, 0, type);
		assert.equal(f.localWrites.length, 0, type);
		assert.equal(view.editor.text, placeholder, type);
	}
});
