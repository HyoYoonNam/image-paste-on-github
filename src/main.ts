import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	arrayBufferToBase64,
	normalizePath,
	requestUrl,
} from "obsidian";

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
	owner: string;
	repo: string;
	branch: string;
	uploadPath: string;
	fallbackToLocal: boolean;
}

const DEFAULT_SETTINGS: ImagePasteSettings = {
	githubToken: "",
	owner: "",
	repo: "",
	branch: "main",
	uploadPath: "assets",
	fallbackToLocal: true,
};

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/bmp": "bmp",
	"image/avif": "avif",
};

export default class ImagePasteOnGithubPlugin extends Plugin {
	settings!: ImagePasteSettings;

	async onload() {
		await this.loadSettings();

		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor) => {
				if (evt.defaultPrevented) return;
				if (this.handleImages(editor, evt.clipboardData?.files)) {
					evt.preventDefault();
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-drop", (evt, editor) => {
				if (evt.defaultPrevented) return;
				if (this.handleImages(editor, evt.dataTransfer?.files)) {
					evt.preventDefault();
				}
			})
		);

		this.addSettingTab(new ImagePasteSettingTab(this.app, this));
	}

	onunload() {}

	// Returns true when we take over the paste/drop so the caller can call
	// evt.preventDefault() and suppress the default local-save behaviour.
	private handleImages(
		editor: Editor,
		fileList: FileList | null | undefined
	): boolean {
		if (!fileList || fileList.length === 0) return false;

		const images = Array.from(fileList).filter((f) =>
			f.type.startsWith("image/")
		);
		if (images.length === 0) return false;

		// Missing config: let Obsidian's default handler save locally.
		if (!this.isConfigured()) {
			new Notice(
				"Image Paste on GitHub: configure your token, owner, and repo in settings."
			);
			return false;
		}

		for (const image of images) {
			void this.uploadAndInsert(editor, image);
		}
		return true;
	}

	private async uploadAndInsert(editor: Editor, image: File) {
		const token = `image-paste-uploading-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const placeholder = `![${token}]()`;

		editor.replaceSelection(placeholder + "\n");

		try {
			const url = await this.uploadToGithub(image);
			this.replaceToken(editor, placeholder, `![](${url})`);
		} catch (err) {
			console.error("Image Paste on GitHub upload failed:", err);
			const message =
				err instanceof Error ? err.message : "Unknown error";
			new Notice(`Image upload failed: ${message}`);
			// Remove the placeholder; user can retry or paste locally.
			this.replaceToken(editor, placeholder, "");
			if (this.settings.fallbackToLocal) {
				new Notice(
					"Tip: disable the plugin or fix settings to save images locally instead."
				);
			}
		}
	}

	private replaceToken(editor: Editor, from: string, to: string) {
		const content = editor.getValue();
		const idx = content.indexOf(from);
		if (idx === -1) return;

		const before = content.slice(0, idx);
		const lines = before.split("\n");
		const line = lines.length - 1;
		const ch = lines[lines.length - 1].length;
		editor.replaceRange(
			to,
			{ line, ch },
			{ line, ch: ch + from.length }
		);
	}

	private async uploadToGithub(image: File): Promise<string> {
		const { owner, repo, branch, uploadPath, githubToken } = this.settings;

		const buffer = await image.arrayBuffer();
		const base64 = arrayBufferToBase64(buffer);

		const ext = MIME_EXTENSIONS[image.type] ?? "png";
		const filename = `pasted-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}.${ext}`;

		// normalizePath for cross-platform safety, then strip any leading
		// slash because the GitHub Contents API path must be relative.
		const repoPath = normalizePath(`${uploadPath}/${filename}`).replace(
			/^\/+/,
			""
		);

		const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`;

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

		return `https://raw.githubusercontent.com/${owner}/${repo}/${
			branch || "main"
		}/${repoPath}`;
	}

	isConfigured(): boolean {
		const { githubToken, owner, repo } = this.settings;
		return Boolean(githubToken && owner && repo);
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ImagePasteSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

		const warning = containerEl.createEl("div", {
			cls: "image-paste-github-warning",
		});
		warning.createEl("strong", { text: "Heads up: " });
		warning.appendText(
			"the target repository must be public, so every pasted image becomes publicly accessible."
		);
		warning.createEl("br");
		warning.createEl("br");
		warning.createEl("strong", { text: "Token safety: " });
		warning.appendText(
			"the token is stored unencrypted in this vault's data.json. Scope it to only this " +
				"repository with Contents: read and write, give it an expiration date, and never " +
				"sync, commit, or share data.json. A leaked token can push to your image repository."
		);

		new Setting(containerEl)
			.setName("Owner")
			.setDesc("GitHub username or organization that owns the repo.")
			.addText((text) =>
				text
					.setPlaceholder("your-username")
					.setValue(this.plugin.settings.owner)
					.onChange(async (value) => {
						this.plugin.settings.owner = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Repository")
			.setDesc("Public repository name where images are committed.")
			.addText((text) =>
				text
					.setPlaceholder("my-image-cdn")
					.setValue(this.plugin.settings.repo)
					.onChange(async (value) => {
						this.plugin.settings.repo = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Create repository")
			.setDesc(
				"Create a new public repo to store images. Falls back to GitHub if your token cannot create one."
			)
			.addButton((button) =>
				button.setButtonText("Create").onClick(async () => {
					await this.createRepository();
				})
			);

		new Setting(containerEl)
			.setName("GitHub token")
			.setDesc(
				"Fine-grained, single-repository token with Contents: read and write. Stored unencrypted (see the note above)."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("github_pat_...")
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Create a token")
			.setDesc(
				"Opens GitHub to generate a fine-grained token scoped to the repository above, with Contents: read and write."
			)
			.addButton((button) =>
				button.setButtonText("Open GitHub").onClick(() => {
					window.open(
						"https://github.com/settings/personal-access-tokens/new",
						"_blank"
					);
				})
			);

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
			.setName("Notify on fallback")
			.setDesc(
				"Show a tip when an upload fails so you can fix settings or save locally."
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
			.setDesc("Verify the token can access and push to the repository.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await this.testConnection();
				})
			);
	}

	private async testConnection() {
		const { owner, repo, githubToken } = this.plugin.settings;
		if (!githubToken || !owner || !repo) {
			new Notice("Fill in token, owner, and repo first.");
			return;
		}

		try {
			const response = await requestUrl({
				url: `https://api.github.com/repos/${owner}/${repo}`,
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
					"Connected, but the token lacks push (Contents: write) permission."
				);
				return;
			}
			if (isPrivate) {
				new Notice(
					"Connected with push access, but the repo is private — raw links will not render. Make it public."
				);
				return;
			}
			new Notice("Connection OK: public repo with push access.");
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
