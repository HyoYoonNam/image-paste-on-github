globalThis.module = { exports: {} };

class TestEditor {
	constructor() { this.text = ""; }
	getValue() { return this.text; }
	replaceSelection(value) { this.text += value; }
	replaceRange(value, from, to) {
		const lines = this.text.split("\n");
		const offset = lines.slice(0, from.line).reduce((total, line) => total + line.length + 1, 0);
		this.text = this.text.slice(0, offset + from.ch) + value + this.text.slice(offset + to.ch);
	}
}

class MarkdownView {
	constructor(file) { this.file = file; this.editor = new TestEditor(); }
}

const requests = [], notices = [], saved = [], jobs = [], events = new Map();
const source = { path: "notes/source.md", extension: "md" };
const view = new MarkdownView(source);
const files = new Map([[source.path, source]]);
const state = { uploadFails: false };

globalThis.require = (name) => {
	if (name !== "obsidian") throw new Error(`Unexpected external module: ${name}`);
	return {
		Plugin: class {
			async loadData() { return { githubToken: "fake-test-token", owner: "example", repo: "images" }; }
			registerEvent() {}
			addSettingTab() {}
		},
		PluginSettingTab: class {},
		MarkdownView,
		Notice: class { constructor(message) { notices.push(message); } },
		arrayBufferToBase64(buffer) {
			return btoa(Array.from(new Uint8Array(buffer), byte => String.fromCharCode(byte)).join(""));
		},
		normalizePath: (value) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
		async requestUrl(request) {
			requests.push(request);
			return state.uploadFails ? { status: 503, json: { message: "offline" } } : { status: 201, json: {} };
		},
	};
};

globalThis.startPluginTest = async () => {
	const plugin = new module.exports.default();
	plugin.app = {
		workspace: {
			on(name, callback) { events.set(name, callback); },
			getLeavesOfType() { return [{ view }]; },
		},
		vault: {
			getAbstractFileByPath(filePath) { return files.get(filePath) ?? null; },
			async createBinary(filePath, buffer) {
				const file = { path: filePath, extension: filePath.split(".").pop() };
				files.set(filePath, file); saved.push({ path: filePath, bytes: Array.from(new Uint8Array(buffer)) }); return file;
			},
		},
		fileManager: {
			async getAvailablePathForAttachment(name) { return `notes/attachments/${name}`; },
			generateMarkdownLink(file) { return `[[${file.path}]]`; },
		},
	};
	await plugin.onload();
	const originalUpload = plugin.uploadAndInsert.bind(plugin);
	plugin.uploadAndInsert = (...args) => {
		const job = originalUpload(...args); jobs.push(job); return job;
	};
	globalThis.pluginTest = {
		plugin, state, requests, notices, saved, jobs, view,
		async paste({ corrupt = false, emptyMime = false, type = "image/heic", name = "pattern.heic", cancel = false, unload = false } = {}) {
			let bytes = new Uint8Array(await fetch("/pattern.heic").then(response => response.arrayBuffer()));
			if (corrupt) bytes = bytes.slice(0, 48);
			const file = new File([bytes], name, { type: emptyMime ? "" : type });
			const event = { defaultPrevented: false, clipboardData: { files: [file] }, preventDefault() { this.defaultPrevented = true; } };
			events.get("editor-paste")(event, view.editor, view);
			if (cancel) view.editor.text = "cancelled";
			if (unload) plugin.onunload();
			await Promise.all(jobs);
			return { prevented: event.defaultPrevented, original: Array.from(bytes) };
		},
	};
};
