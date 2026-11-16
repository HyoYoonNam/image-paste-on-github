import type { AuthSession } from "./auth";

interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

/** 구버전에서는 OAuth 토큰을 data.json에 쓰지 않고 현재 실행에서만 보관한다. */
export class OAuthStorage {
	private memory: AuthSession | null = null;
	constructor(
		private readonly secrets: SecretStore | undefined,
		private readonly getId: () => string,
		private readonly setId: (id: string) => Promise<void>
	) {}

	get persistent(): boolean { return Boolean(this.secrets); }

	async load(): Promise<AuthSession | null> {
		const id = this.getId();
		if (!this.secrets || !/^image-paste-github-[a-f0-9]{32}$/.test(id)) return this.memory;
		const stored = this.secrets.getSecret(id);
		if (!stored) return null;
		try { return JSON.parse(stored) as AuthSession; } catch { return null; }
	}

	async save(session: AuthSession | null): Promise<void> {
		if (!this.secrets) { this.memory = session; return; }
		let id = this.getId();
		if (!/^image-paste-github-[a-f0-9]{32}$/.test(id)) {
			if (!session) return;
			id = `image-paste-github-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
			await this.setId(id);
		}
		this.secrets.setSecret(id, session ? JSON.stringify(session) : "");
	}
}
