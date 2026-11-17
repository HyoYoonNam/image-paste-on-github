import {
	App,
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	arrayBufferToBase64,
	normalizePath,
	requestUrl,
	requireApiVersion,
} from "obsidian";
import { convertHeicToJpeg } from "./heic";
import { AuthError, GitHubAuth, normalizeRelayUrl } from "./auth";
import { OAuthStorage } from "./auth-storage";
import { ImageRepository, listImageRepositories } from "./github-repositories";

declare const AUTH_RELAY_URL: string;
const DEFAULT_RELAY_URL = typeof AUTH_RELAY_URL === "string" ? AUTH_RELAY_URL : "";

interface GithubErrorResponse {
	message?: string;
}

interface GithubRepoResponse {
	name?: string;
	full_name?: string;
	owner?: { login?: string };
	private?: boolean;
	permissions?: { push?: boolean };
	message?: string;
}

interface ImagePasteSettings {
	githubToken: string;
	authMode: "github" | "pat";
	authRelayUrl: string;
	oauthSecretId: string;
	oauthRepositoryId: number;
	owner: string;
	repo: string;
	branch: string;
	uploadPath: string;
	fallbackToLocal: boolean;
}

interface UploadTarget {
	file: TFile;
	editor: Editor;
}

const DEFAULT_SETTINGS: ImagePasteSettings = {
	githubToken: "",
	authMode: "github",
	authRelayUrl: DEFAULT_RELAY_URL,
	oauthSecretId: "",
	oauthRepositoryId: 0,
	owner: "",
	repo: "",
	branch: "main",
	uploadPath: "assets",
	fallbackToLocal: true,
};

const MIME_EXTENSIONS = new Map<string, string>([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/svg+xml", "svg"],
	["image/bmp", "bmp"],
	["image/avif", "avif"],
]);

const HEIC_EXTENSIONS = new Map<string, string>([
	["image/heic", "heic"],
	["image/heif", "heif"],
]);
const UPLOAD_CANCELLED = new Error("Image upload cancelled.");

function heicExtension(image: File): string | undefined {
	const namedExtension = /\.(heic|heif)$/i.exec(image.name)?.[1].toLowerCase();
	const extension = HEIC_EXTENSIONS.get(image.type);
	if (extension) return namedExtension ?? extension;
	if (image.type !== "") return undefined;
	return namedExtension;
}

function imageExtension(type: string): string {
	const extension = MIME_EXTENSIONS.get(type);
	if (!extension) throw new Error(`Unsupported image type: ${type || "unknown"}`);
	return extension;
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

export default class ImagePasteOnGithubPlugin extends Plugin {
	settings!: ImagePasteSettings;
	auth!: GitHubAuth;
	oauthStorage!: OAuthStorage;
	repositories: ImageRepository[] = [];
	private settingsTab!: ImagePasteSettingTab;
	private settingsWrites: Promise<void> = Promise.resolve();
	private active = false;
	private conversionQueue: Promise<void> = Promise.resolve();

	async onload() {
		this.active = true;
		await this.loadSettings();
		if (!this.active) return;
		this.oauthStorage = new OAuthStorage(requireApiVersion("1.11.4") ? this.app.secretStorage : undefined,
			() => this.settings.oauthSecretId,
			async (id) => { this.settings.oauthSecretId = id; await this.saveSettings(); });
		this.auth = new GitHubAuth({
			request: async (request) => {
				const response = await requestUrl({ ...request, throw: false });
				return { status: response.status, json: response.status === 204 ? undefined : response.json };
			},
			storage: this.oauthStorage,
			openUrl: (url) => { window.open(url, "_blank"); },
		});
		try { await this.auth.initialize(); }
		catch { new Notice("Could not read the saved GitHub connection. Connect again in the plugin settings."); }
		if (!this.active) { this.auth.dispose(); return; }
		this.registerObsidianProtocolHandler("image-paste-on-github-auth", (params) => {
			if (this.settings.authMode !== "github") return;
			void this.completeSignIn({ transaction_id: params.transaction_id ?? "", state: params.state ?? "" });
		});

		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor, info) => {
				if (evt.defaultPrevented) return;
				if (this.handleImages(editor, info, evt.clipboardData?.files)) {
					evt.preventDefault();
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-drop", (evt, editor, info) => {
				if (evt.defaultPrevented) return;
				if (this.handleImages(editor, info, evt.dataTransfer?.files)) {
					evt.preventDefault();
				}
			})
		);

		this.settingsTab = new ImagePasteSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
	}

	onunload() {
		this.active = false;
		this.auth?.dispose();
	}

	// Returns true when we take over the paste/drop so the caller can call
	// evt.preventDefault() and suppress the default local-save behaviour.
	private handleImages(
		editor: Editor,
		info: MarkdownFileInfo,
		fileList: FileList | null | undefined
	): boolean {
		if (!this.active) return false;
		if (!fileList || fileList.length === 0) return false;

		const images = Array.from(fileList);
		// 이벤트 전체를 가로채므로 지원하지 않는 첨부가 섞이면 기본 처리에 맡긴다.
		if (!images.every((file) => MIME_EXTENSIONS.has(file.type) || heicExtension(file))) return false;
		const file = info.file;
		if (!file || file.extension.toLowerCase() !== "md") return false;
		const target: UploadTarget = { file, editor };
		if (this.sourceEditor(target) !== editor) return false;

		// Missing config: let Obsidian's default handler save locally.
		if (!this.isConfigured()) {
			new Notice(
				"Image Paste on GitHub: connect to GitHub and select an image repository, or configure a PAT in Advanced settings."
			);
			return false;
		}

		for (const image of images) {
			void this.uploadAndInsert(target, image);
		}
		return true;
	}

	private async uploadAndInsert(target: UploadTarget, image: File) {
		const authRevision = this.auth.revision;
		const authMode = this.settings.authMode;
		const pat = this.settings.githubToken;
		const token = `image-paste-uploading-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const placeholder = `![${token}]()`;

		target.editor.replaceSelection(placeholder + "\n");
		let uploadImage = image;
		const originalExtension = heicExtension(image);
		if (originalExtension) {
			try {
				const converted = await this.prepareHeic(target, image, placeholder);
				if (!converted) return;
				uploadImage = converted;
			} catch (err) {
				await this.handleConversionFailure(target, image, placeholder, originalExtension, err);
				return;
			}
		}

		let url: string;
		try {
			if (this.settings.authMode !== authMode || this.auth.revision !== authRevision || (authMode === "pat" && this.settings.githubToken !== pat)) {
				throw new Error("GitHub connection changed while preparing the image. Paste it again after connecting.");
			}
			url = await this.uploadToGithub(uploadImage, () => this.hasPlaceholder(target, placeholder));
		} catch (err) {
			if (err === UPLOAD_CANCELLED || !this.active) return;
			await this.handleUploadFailure(target, uploadImage, placeholder, err);
			return;
		}

		// 업로드가 끝난 뒤 노트 수정에 실패해도 로컬 복사본을 추가로 만들지 않는다.
		try {
			await this.replaceToken(target, placeholder, `![](${url})`);
		} catch (err) {
			if (!this.targetExists(target)) return;
			console.error("Image Paste on GitHub note update failed:", err);
			new Notice(`Image uploaded, but the original note could not be updated: ${url}`);
		}
	}

	private async prepareHeic(target: UploadTarget, image: File, placeholder: string): Promise<File | null> {
		if (!(await this.hasPlaceholder(target, placeholder)) || !this.active) return null;
		const conversion = this.conversionQueue.then(async () => {
			if (!(await this.hasPlaceholder(target, placeholder)) || !this.active) return null;
			const converted = await convertHeicToJpeg(image);
			if (!(await this.hasPlaceholder(target, placeholder)) || !this.active) return null;
			return converted;
		});
		// 앞선 변환이 실패해도 다음 이미지는 처리한다.
		this.conversionQueue = conversion.then(() => undefined, () => undefined);
		return conversion;
	}

	private async handleConversionFailure(
		target: UploadTarget,
		image: File,
		placeholder: string,
		extension: string,
		err: unknown
	) {
		const detail = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
		const nextStep = "Export the original as JPEG and try again.";
		try {
			if (!(await this.hasPlaceholder(target, placeholder)) || !this.active) return;
			console.error("Image Paste on GitHub HEIC conversion failed:", err);
			let message = `HEIC conversion failed (${detail}); no file was uploaded.`;
			if (this.settings.fallbackToLocal) {
				let saved: TFile | null = null;
				try {
					saved = await this.saveAttachment(target, image, placeholder, extension);
					if (!saved) return;
				} catch (saveErr) {
					console.error("Image Paste on GitHub original file save failed:", saveErr);
					message = `HEIC conversion failed (${detail}); the original file could not be saved.`;
				}
				if (saved) {
					const file = saved;
					try {
						if (await this.replaceToken(target, placeholder, () =>
							this.app.fileManager.generateMarkdownLink(file, target.file.path).replace(/^!/, "")
						)) {
							new Notice(`HEIC conversion failed (${detail}); original file saved to the vault. ${nextStep}`);
						}
					} catch (updateErr) {
						if (!this.targetExists(target)) return;
						console.error("Image Paste on GitHub note update failed:", updateErr);
						new Notice(`HEIC conversion failed; original file saved to ${file.path}, but the note could not be updated. ${nextStep}`);
					}
					return;
				}
			}
			if (await this.replaceToken(target, placeholder, "")) new Notice(`${message} ${nextStep}`);
		} catch (updateErr) {
			if (!this.targetExists(target)) return;
			console.error("Image Paste on GitHub conversion failure handling failed:", updateErr);
			new Notice(`HEIC conversion failed (${detail}); the original note could not be updated. ${nextStep}`);
		}
	}

	private async handleUploadFailure(
		target: UploadTarget,
		image: File,
		placeholder: string,
		err: unknown
	) {
		if (!this.targetExists(target)) return;
		console.error("Image Paste on GitHub upload failed:", err);
		const message = err instanceof Error ? err.message : "Unknown error";

		if (this.settings.fallbackToLocal) {
			let file: TFile | null = null;
			try {
				file = await this.saveLocally(target, image, placeholder);
				if (!file) return;
			} catch (saveErr) {
				console.error("Image Paste on GitHub local fallback failed:", saveErr);
			}

			if (file) {
				try {
					const savedFile = file;
					if (await this.replaceToken(target, placeholder, () => {
						const link = this.app.fileManager.generateMarkdownLink(savedFile, target.file.path);
						return link.startsWith("!") ? link : `!${link}`;
					})) {
						new Notice(`Image upload failed (${message}); saved to the vault instead.`);
					}
				} catch (updateErr) {
					if (!this.targetExists(target)) return;
					console.error("Image Paste on GitHub note update failed:", updateErr);
					new Notice(`Image saved to ${file.path}, but the original note could not be updated.`);
				}
				return;
			}
		}

		try {
			if (await this.replaceToken(target, placeholder, "")) {
				new Notice(`Image upload failed: ${message}`);
			}
		} catch (updateErr) {
			if (!this.targetExists(target)) return;
			console.error("Image Paste on GitHub note update failed:", updateErr);
			new Notice(`Image upload failed: ${message}. The original note could not be updated.`);
		}
	}

	private async saveLocally(target: UploadTarget, image: File, placeholder: string): Promise<TFile | null> {
		const ext = imageExtension(image.type);
		return this.saveAttachment(target, image, placeholder, ext);
	}

	private async saveAttachment(
		target: UploadTarget,
		image: File,
		placeholder: string,
		extension: string
	): Promise<TFile | null> {
		if (!(await this.hasPlaceholder(target, placeholder))) return null;
		const filename = `pasted-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}.${extension}`;
		const buffer = await image.arrayBuffer();
		const targetPath =
			await this.app.fileManager.getAvailablePathForAttachment(
				filename,
				target.file.path
			);
		if (!(await this.hasPlaceholder(target, placeholder)) || !this.targetExists(target)) return null;
		return this.app.vault.createBinary(targetPath, buffer);
	}

	private targetExists(target: UploadTarget): boolean {
		return this.active && this.app.vault.getAbstractFileByPath(target.file.path) === target.file;
	}

	private sourceEditor(target: UploadTarget): Editor | undefined {
		const views = this.app.workspace.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view): view is MarkdownView =>
				view instanceof MarkdownView && view.file === target.file
			);
		const original = views.find((view) => view.editor === target.editor);
		return (original ?? views[0])?.editor;
	}

	private async hasPlaceholder(target: UploadTarget, placeholder: string): Promise<boolean> {
		if (!this.targetExists(target)) return false;
		const editor = this.sourceEditor(target);
		if (editor) return editor.getValue().includes(placeholder);
		let content: string;
		try {
			content = await this.app.vault.read(target.file);
		} catch (err) {
			if (this.targetExists(target)) {
				console.error("Image Paste on GitHub source note read failed:", err);
				new Notice("Could not read the original note. The operation was stopped.");
			}
			return false;
		}
		if (!this.targetExists(target)) return false;
		return (this.sourceEditor(target)?.getValue() ?? content).includes(placeholder);
	}

	private async replaceToken(target: UploadTarget, from: string, to: string | (() => string)): Promise<boolean> {
		const editorOpened = new Error("The source note was opened in an editor.");
		const cancelled = new Error("The source note or upload placeholder no longer exists.");
		while (this.targetExists(target)) {
			const editor = this.sourceEditor(target);
			if (editor) return this.replaceEditorToken(editor, from, to);

			try {
				await this.app.vault.process(target.file, (content) => {
					// 반환하면 파일에 쓰므로 취소와 편집기 재열기는 예외로 쓰기 전에 중단한다.
					if (!this.targetExists(target)) throw cancelled;
					if (this.sourceEditor(target)) throw editorOpened;
					if (!content.includes(from)) throw cancelled;
					return content.replace(from, () => typeof to === "function" ? to() : to);
				});
				return true;
			} catch (err) {
				if (err === cancelled) return false;
				if (err !== editorOpened) throw err;
			}
		}
		return false;
	}

	private replaceEditorToken(editor: Editor, from: string, to: string | (() => string)): boolean {
		const content = editor.getValue();
		const idx = content.indexOf(from);
		if (idx === -1) return false;

		const before = content.slice(0, idx);
		const lines = before.split("\n");
		const line = lines.length - 1;
		const ch = lines[lines.length - 1].length;
		editor.replaceRange(
			typeof to === "function" ? to() : to,
			{ line, ch },
			{ line, ch: ch + from.length }
		);
		return true;
	}

	private async uploadToGithub(image: File, canUpload?: () => Promise<boolean>): Promise<string> {
		const { owner, repo, branch, uploadPath, authMode } = this.settings;
		const authRevision = this.auth.revision;
		const pat = this.settings.githubToken;
		const ext = imageExtension(image.type);
		if (!this.active) throw UPLOAD_CANCELLED;

		const buffer = await image.arrayBuffer();
		const base64 = arrayBufferToBase64(buffer);

		const filename = `pasted-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}.${ext}`;

		// normalizePath for cross-platform safety, then strip any leading
		// slash because the GitHub Contents API path must be relative.
		const repoPath = normalizePath(`${uploadPath}/${filename}`).replace(
			/^\/+/,
			""
		);
		const encodedPath = repoPath.split("/").map(encodePathSegment).join("/");
		const repository = `${encodePathSegment(owner)}/${encodePathSegment(repo)}`;

		const apiUrl = `https://api.github.com/repos/${repository}/contents/${encodedPath}`;
		if (!this.active || (canUpload && !(await canUpload())) || !this.active) {
			throw UPLOAD_CANCELLED;
		}
		const githubToken = await this.accessToken();
		if (!this.active || (canUpload && !(await canUpload()))) throw UPLOAD_CANCELLED;
		if (this.settings.authMode !== authMode || this.auth.revision !== authRevision ||
			(authMode === "github" ? !this.auth.connected : this.settings.githubToken !== pat)) {
			throw new Error("GitHub connection changed before the upload started. Paste the image again after connecting.");
		}

		const response = await requestUrl({
			url: apiUrl,
			method: "PUT",
			headers: {
				Authorization: `Bearer ${githubToken}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				message: `Add ${filename} via Image Paste on GitHub`,
				content: base64,
				branch: branch || "main",
			}),
			throw: false,
		});

		if (response.status !== 201 && response.status !== 200) {
			const error = response.json as GithubErrorResponse | null;
			const detail = error?.message ?? `HTTP ${response.status}`;
			throw new Error(detail);
		}

		return `https://raw.githubusercontent.com/${repository}/${
			encodePathSegment(branch || "main")
		}/${encodedPath}`;
	}

	isConfigured(): boolean {
		const { githubToken, owner, repo } = this.settings;
		return Boolean(owner && repo && (this.settings.authMode === "pat" ? githubToken : this.auth?.connected && this.settings.oauthRepositoryId));
	}

	async accessToken(): Promise<string> {
		if (this.settings.authMode === "github") return this.auth.getAccessToken();
		if (!this.settings.githubToken) throw new Error("Enter a PAT in Advanced settings or connect to GitHub.");
		return this.settings.githubToken;
	}

	async completeSignIn(callback?: { transaction_id: string; state: string }): Promise<void> {
		try {
			if (!(await this.auth.complete(callback)) || !this.active) return;
			this.settings.oauthRepositoryId = 0;
			this.repositories = [];
			await this.saveSettings();
			new Notice("Connected to GitHub. Select a public image repository in the plugin settings.");
			this.settingsTab?.display();
			await this.refreshRepositories();
		} catch (error) { this.authNotice(error); }
	}

	async refreshRepositories(): Promise<void> {
		const revision = this.auth.revision;
		const token = await this.accessToken();
		const repositories = await listImageRepositories(async (path) => {
			if (!this.active || this.settings.authMode !== "github" || !this.auth.connected || this.auth.revision !== revision) {
				throw new AuthError("cancelled", "GitHub connection changed while reading repositories.");
			}
			const response = await requestUrl({ url: `https://api.github.com${path}`, headers: {
				Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
			}, throw: false });
			if (response.status !== 200) throw new Error("Could not list GitHub repositories. Check the App installation and reconnect if access was revoked.");
			return response.json as unknown;
		});
		if (!this.active || this.settings.authMode !== "github" || !this.auth.connected || this.auth.revision !== revision) return;
		this.repositories = repositories;
		this.settingsTab?.display();
		if (!this.repositories.length) new Notice("No writable public image repositories were found. Install the GitHub App on your image repository, then refresh the list.");
	}

	async openInstallation(): Promise<void> {
		const relay = normalizeRelayUrl(this.auth.relayUrl ?? this.settings.authRelayUrl);
		const response = await requestUrl({ url: `${relay}/auth/config`, throw: false });
		const config = response.json as { appSlug?: string; installationUrl?: string };
		if (response.status !== 200 || !config.appSlug || !/^[a-z0-9-]+$/.test(config.appSlug) ||
			config.installationUrl !== `https://github.com/apps/${config.appSlug}/installations/new`) {
			throw new Error("The authentication relay returned an invalid GitHub App installation address.");
		}
		window.open(config.installationUrl, "_blank");
	}

	authNotice(error: unknown): void {
		new Notice(error instanceof AuthError ? error.message : "Could not finish the GitHub connection action. Check your connection and plugin settings.");
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ImagePasteSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		if (data?.authMode !== "github" && data?.authMode !== "pat") this.settings.authMode = data?.githubToken ? "pat" : "github";
	}

	async saveSettings() {
		const settings = { ...this.settings };
		const write = this.settingsWrites.catch(() => {}).then(() => this.saveData(settings));
		this.settingsWrites = write;
		await write;
	}
}

class ImagePasteSettingTab extends PluginSettingTab {
	plugin: ImagePasteOnGithubPlugin;

	constructor(app: App, plugin: ImagePasteOnGithubPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const warning = containerEl.createDiv({
			cls: "image-paste-github-warning",
		});
		warning.createEl("strong", { text: "Heads up: " });
		warning.appendText(
			"the target repository must be public, so every pasted image becomes publicly accessible."
		);

		this.renderConnection(containerEl);

		if (this.plugin.settings.authMode === "github") {
			new Setting(containerEl)
				.setName("Image repository")
				.setDesc("Select a public repository allowed by the GitHub App. Install the App on only your image repository.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Choose a repository");
					for (const repo of this.plugin.repositories) dropdown.addOption(String(repo.id), `${repo.owner}/${repo.name}`);
					const selected = this.plugin.settings.oauthRepositoryId;
					if (selected && !this.plugin.repositories.some(repo => repo.id === selected)) {
						dropdown.addOption(String(selected), `${this.plugin.settings.owner}/${this.plugin.settings.repo}`);
					}
					dropdown.setValue(selected ? String(selected) : "").onChange(async (value) => {
						const repo = this.plugin.repositories.find(item => String(item.id) === value);
						if (!repo) return;
						this.plugin.settings.owner = repo.owner;
						this.plugin.settings.repo = repo.name;
						this.plugin.settings.branch = repo.defaultBranch;
						this.plugin.settings.oauthRepositoryId = repo.id;
						await this.plugin.saveSettings();
						this.display();
					});
				});
		}

		new Setting(containerEl).setName("Create repository")
			.setDesc("Create a public image repository, then grant the GitHub App access to it.")
			.addButton(button => button.setButtonText("Create").onClick(() => {
				if (this.plugin.settings.authMode === "pat") void this.createRepository();
				else window.open("https://github.com/new?name=obsidian-image-cdn", "_blank");
			}));

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Branch to commit to.")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Upload path")
			.setDesc("Folder prefix inside the repo for uploaded images.")
			.addText((text) =>
				text
					.setPlaceholder("assets")
					.setValue(this.plugin.settings.uploadPath)
					.onChange(async (value) => {
						this.plugin.settings.uploadPath =
							value.trim() || "assets";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Save locally on failure")
			.setDesc(
				"If an upload fails, save the image into your vault. If HEIC conversion fails, preserve the original as a file link."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fallbackToLocal)
					.onChange(async (value) => {
						this.plugin.settings.fallbackToLocal = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check repository visibility and reported access. This does not upload a file.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await this.testConnection();
				})
			);
		this.renderAdvanced(containerEl);

	}


	private renderConnection(containerEl: HTMLElement): void {
		const { auth, settings } = this.plugin;
		const connected = settings.authMode === "github" && auth.connected;
		const description = connected ? "Connected. Images upload directly from Obsidian to GitHub." :
			settings.authMode === "pat" ? "Using your existing PAT. You can switch to browser sign-in here." :
			auth.pending ? "Approve access in your browser, then return to this vault." :
			settings.authRelayUrl ? "Sign in through GitHub and select your image repository." :
			"Browser sign-in needs an authentication relay. Configure a trusted relay in Advanced settings, or use a PAT.";
		new Setting(containerEl).setName("GitHub connection").setDesc(description)
			.addButton(button => button.setButtonText(connected ? "Disconnect" : "Connect with GitHub")
				.setDisabled(!connected && !settings.authRelayUrl)
				.onClick(async () => {
					button.setDisabled(true);
					try {
						if (connected) {
							const revoked = await auth.disconnect();
							this.plugin.repositories = [];
							this.plugin.settings.oauthRepositoryId = 0;
							await this.plugin.saveSettings();
							new Notice(revoked ? "GitHub disconnected on this device." : "Local GitHub credentials cleared. Remote token revocation could not be confirmed; review Authorized GitHub Apps on GitHub.");
						} else {
							settings.authMode = "github";
							settings.oauthRepositoryId = 0;
							await this.plugin.saveSettings();
							await auth.begin(settings.authRelayUrl);
						}
					} catch (error) { this.plugin.authNotice(error); }
					finally { this.display(); }
				}));
		if (auth.pending) {
			new Setting(containerEl).setName("Finish browser sign-in")
				.setDesc("If GitHub returned to another vault, open this vault and complete sign-in here. Restart sign-in if Obsidian was closed.")
				.addButton(button => button.setButtonText("Complete sign in").onClick(() => { void this.plugin.completeSignIn(); }))
				.addButton(button => button.setButtonText("Cancel").onClick(async () => { await auth.cancel(); this.display(); }));
		}
		if (settings.authMode === "github" && (connected || settings.authRelayUrl)) {
			new Setting(containerEl).setName("GitHub App access")
				.setDesc("Choose only your public image repository when installing the App, then refresh the repository list.")
				.addButton(button => button.setButtonText("Choose repositories on GitHub").onClick(async () => {
					try { await this.plugin.openInstallation(); } catch (error) { this.plugin.authNotice(error); }
				}))
				.addButton(button => button.setButtonText("Refresh repositories").setDisabled(!connected).onClick(async () => {
					button.setDisabled(true);
					try { await this.plugin.refreshRepositories(); } catch (error) { this.plugin.authNotice(error); }
					finally { button.setDisabled(false); }
				}));
		}
		if (settings.authMode === "github") containerEl.createEl("p", { text: this.plugin.oauthStorage.persistent
			? "GitHub login credentials use Obsidian Secret storage, outside this plugin's data.json. Other plugins can access Secret storage."
			: "This Obsidian version keeps browser login only for this session. Obsidian 1.11.4 or later can save it in Secret storage." });
	}

	private renderAdvanced(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details");
		details.createEl("summary", { text: "Advanced settings" });
		const advanced = details.createDiv();
		new Setting(advanced).setName("Authentication method")
			.setDesc("PAT mode is kept for existing users and self-managed access. A failed browser login never switches to PAT automatically.")
			.addDropdown(dropdown => dropdown.addOption("github", "GitHub browser sign-in").addOption("pat", "Personal access token")
				.setValue(this.plugin.settings.authMode).onChange(async (mode) => {
					try {
						if (mode === "pat") {
							const revoked = await this.plugin.auth.disconnect();
							if (!revoked) new Notice("Browser credentials cleared locally. Review Authorized GitHub Apps on GitHub to revoke remote access.");
						}
						this.plugin.settings.authMode = mode === "pat" ? "pat" : "github";
						this.plugin.settings.oauthRepositoryId = 0;
						this.plugin.repositories = [];
						await this.plugin.saveSettings();
						this.display();
					} catch (error) { this.plugin.authNotice(error); }
				}));
		new Setting(advanced).setName("Authentication relay")
			.setDesc("Use only a relay you trust: it handles GitHub login and refresh credentials. Disconnect and cancel sign-in before changing it. Images do not pass through it.")
			.addText(text => text.setPlaceholder("https://auth.example.com").setValue(this.plugin.settings.authRelayUrl)
				.setDisabled(this.plugin.auth.connected || this.plugin.auth.pending)
				.onChange(async value => { this.plugin.settings.authRelayUrl = value.trim(); await this.plugin.saveSettings(); }));
		advanced.createEl("p", { text: "Your PAT token is preserved independently of browser credentials. PATs are stored unencrypted in this vault's plugin data.json. Do not sync, commit, or share that file." });
		for (const [key, label, placeholder] of [["owner", "Owner", "your-username"], ["repo", "Repository", "my-image-cdn"]] as const) {
			new Setting(advanced).setName(label).setDesc("Used for PAT uploads.")
				.addText(text => text.setPlaceholder(placeholder).setValue(this.plugin.settings[key])
					.setDisabled(this.plugin.settings.authMode !== "pat")
					.onChange(async value => { this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings(); }));
		}
		new Setting(advanced).setName("GitHub token").setDesc("Fine-grained PAT limited to one image repository, with Contents: read and write and an expiration date.")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("github_pat_...").setValue(this.plugin.settings.githubToken)
					.onChange(async value => { this.plugin.settings.githubToken = value.trim(); await this.plugin.saveSettings(); });
			});
		new Setting(advanced).setName("Create a token")
			.addButton(button => button.setButtonText("Open GitHub").onClick(() => { window.open("https://github.com/settings/personal-access-tokens/new", "_blank"); }));
		new Setting(advanced).setName("Review GitHub authorizations")
			.setDesc("Disconnect removes this device's credentials. Manage the GitHub App installation or revoke authorization on GitHub to remove remaining access.")
			.addButton(button => button.setButtonText("Open GitHub").onClick(() => { window.open("https://github.com/settings/apps/authorizations", "_blank"); }));
	}

	private async testConnection() {
		const { owner, repo } = this.plugin.settings;
		if (!this.plugin.isConfigured()) {
			new Notice("Connect to GitHub and choose a repository, or fill in the PAT settings first.");
			return;
		}

		try {
			const githubToken = await this.plugin.accessToken();
			const response = await requestUrl({
				url: `https://api.github.com/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}`,
				method: "GET",
				headers: {
					Authorization: `Bearer ${githubToken}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				throw: false,
			});

			if (response.status !== 200) {
				const error = response.json as GithubErrorResponse | null;
				const detail = error?.message ?? `HTTP ${response.status}`;
				new Notice(`Connection failed: ${detail}`);
				return;
			}

			const repoInfo = response.json as GithubRepoResponse;
			const canPush = repoInfo.permissions?.push === true;
			const isPrivate = repoInfo.private === true;

			if (!canPush) {
				new Notice(
					"Connected, but GitHub did not report push access. Check repository and App or PAT permissions."
				);
				return;
			}
			if (isPrivate) {
				new Notice(
					"Connected with push access, but the repo is private — raw links will not render. Make it public."
				);
				return;
			}
			new Notice("Connection OK: public repository with reported push access. Upload permission and the selected branch have not been tested.");
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			new Notice(`Connection failed: ${message}`);
		}
	}

	private async createRepository() {
		const { githubToken } = this.plugin.settings;
		const repoName = this.plugin.settings.repo || "obsidian-image-cdn";
		const newRepoUrl = `https://github.com/new?name=${encodeURIComponent(
			repoName
		)}`;

		// Without a token we cannot use the API, so just open GitHub.
		if (!githubToken) {
			new Notice("No token set. Opening GitHub to create the repo.");
			window.open(newRepoUrl, "_blank");
			return;
		}

		try {
			const response = await requestUrl({
				url: "https://api.github.com/user/repos",
				method: "POST",
				headers: {
					Authorization: `Bearer ${githubToken}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: repoName,
					private: false,
					auto_init: true,
					description:
						"Image storage for the Image Paste on GitHub Obsidian plugin.",
				}),
				throw: false,
			});

			if (response.status === 201) {
				const repo = response.json as GithubRepoResponse;
				this.plugin.settings.owner = repo.owner?.login ?? "";
				this.plugin.settings.repo = repo.name ?? repoName;
				await this.plugin.saveSettings();
				new Notice(`Created ${repo.full_name ?? repoName}.`);
				this.display();
				return;
			}

			if (response.status === 422) {
				new Notice(
					`"${repoName}" may already exist. Fill in owner and repository manually.`
				);
				return;
			}

			// 403 and friends: the token cannot create repos. Fall back to GitHub.
			const error = response.json as GithubErrorResponse | null;
			const detail = error?.message ?? `HTTP ${response.status}`;
			new Notice(`Token cannot create repo (${detail}). Opening GitHub.`);
			window.open(newRepoUrl, "_blank");
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			new Notice(`Could not create repo: ${message}`);
		}
	}
}
