export interface AuthSession {
	relayUrl: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	refreshExpiresAt: number;
}

export interface AuthRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
}

interface AuthDependencies {
	request(request: AuthRequest): Promise<{ status: number; json?: unknown }>;
	storage: {
		load(): Promise<AuthSession | null>;
		save(session: AuthSession | null): Promise<void>;
	};
	openUrl(url: string): void;
	now?: () => number;
	crypto?: Crypto;
}

interface PendingLogin {
	relayUrl: string;
	transactionId: string;
	state: string;
	verifier: string;
	expiresAt: number;
}

export class AuthError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
		this.name = "AuthError";
	}
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

export function normalizeRelayUrl(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new AuthError("relay_url", "Enter the HTTPS address of your trusted authentication relay."); }
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
		throw new AuthError("relay_url", "Use an HTTPS relay origin without a path, query, or credentials. HTTP is allowed only on localhost for development.");
	}
	return url.origin;
}

function validSession(value: unknown): value is AuthSession {
	const data = object(value);
	try {
		return typeof data.relayUrl === "string" && normalizeRelayUrl(data.relayUrl) === data.relayUrl &&
			typeof data.accessToken === "string" && data.accessToken.length > 0 &&
			typeof data.refreshToken === "string" && data.refreshToken.length > 0 &&
			typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) &&
			typeof data.refreshExpiresAt === "number" && Number.isFinite(data.refreshExpiresAt);
	} catch { return false; }
}

function base64url(bytes: Uint8Array): string {
	return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 인증 토큰은 발급한 relay에만 보내며, PAT로 자동 전환하지 않는다. */
export class GitHubAuth {
	private session: AuthSession | null = null;
	private login: PendingLogin | null = null;
	private generation = 0;
	private disposed = false;
	private refreshing: Promise<string> | null = null;
	private completing: Promise<boolean> | null = null;
	private writes: Promise<void> = Promise.resolve();
	private readonly now: () => number;

	constructor(private readonly dependencies: AuthDependencies) {
		this.now = dependencies.now ?? Date.now;
	}

	get connected(): boolean { return this.session !== null; }
	get pending(): boolean { return this.login !== null && this.login.expiresAt > this.now(); }
	get relayUrl(): string | null { return this.session?.relayUrl ?? this.login?.relayUrl ?? null; }
	get revision(): number { return this.generation; }

	async initialize(): Promise<void> {
		const generation = this.generation;
		const stored = await this.dependencies.storage.load();
		if (!this.current(generation)) return;
		if (validSession(stored) && stored.refreshExpiresAt > this.now()) this.session = { ...stored };
		else if (stored) await this.persist(null, generation);
	}

	async begin(relayAddress: string): Promise<void> {
		if (this.disposed) throw new AuthError("cancelled", "Sign-in was cancelled.");
		if (this.session) throw new AuthError("connected", "Disconnect the current GitHub account before signing in again.");
		await this.cancel();
		const generation = ++this.generation;
		const relayUrl = normalizeRelayUrl(relayAddress);
		const crypto = this.dependencies.crypto ?? window.crypto;
		if (!crypto?.subtle) throw new AuthError("crypto_unavailable", "This version of Obsidian cannot start secure browser sign-in. Update Obsidian or use a PAT in Advanced settings.");
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		const config = object(await this.call(relayUrl, "/auth/config"));
		if (!this.current(generation)) return;
		if (typeof config.clientId !== "string" || !config.clientId || config.callbackUrl !== `${relayUrl}/auth/callback`) {
			throw new AuthError("relay_config", "The relay returned an invalid GitHub App configuration.");
		}
		const started = object(await this.call(relayUrl, "/auth/start", { codeChallenge: challenge, clientState: state }));
		if (!this.current(generation)) {
			if (typeof started.transactionId === "string") await this.bestEffortCancel({ relayUrl, transactionId: started.transactionId, verifier, state, expiresAt: 0 });
			return;
		}
		if (typeof started.transactionId !== "string" || !started.transactionId ||
			typeof started.expiresAt !== "number" || !Number.isSafeInteger(started.expiresAt) || started.expiresAt <= this.now() ||
			started.expiresAt > this.now() + 11 * 60_000 || typeof started.authorizationUrl !== "string") {
			throw new AuthError("relay_response", "The relay returned an invalid sign-in request.");
		}
		const login = { relayUrl, transactionId: started.transactionId, verifier, state, expiresAt: started.expiresAt };
		this.login = login;
		try {
			const url = new URL(started.authorizationUrl);
			if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize" || url.username || url.password || url.hash ||
				url.searchParams.get("client_id") !== config.clientId || url.searchParams.get("redirect_uri") !== config.callbackUrl ||
				url.searchParams.get("code_challenge") !== challenge || url.searchParams.get("code_challenge_method") !== "S256" ||
				!url.searchParams.get("state")) {
				throw new Error("Invalid authorization URL");
			}
			this.dependencies.openUrl(url.href);
		} catch {
			this.login = null;
			await this.bestEffortCancel(login);
			throw new AuthError("authorization_url", "Could not open a valid GitHub sign-in page. Check the relay configuration.");
		}
	}

	async complete(callback?: { transaction_id: string; state: string }): Promise<boolean> {
		const login = this.login;
		if (!login || this.disposed) return false;
		if (callback && (callback.transaction_id !== login.transactionId || callback.state !== login.state)) return false;
		if (login.expiresAt <= this.now()) {
			await this.cancel();
			throw new AuthError("expired", "Sign-in expired. Connect to GitHub again.");
		}
		if (this.completing) return this.completing;
		const generation = this.generation;
		const operation = (async () => {
			let acquired: AuthSession | null = null;
			try {
				const response = await this.call(login.relayUrl, "/auth/complete", { transactionId: login.transactionId, codeVerifier: login.verifier });
				const session = this.parseTokens(response, login.relayUrl);
				acquired = session;
				if (!this.current(generation) || this.login !== login) {
					await this.revoke(session);
					return false;
				}
				await this.persist(session, generation);
				if (!this.current(generation)) { await this.revoke(session); return false; }
				this.session = session;
				this.login = null;
				return true;
			} catch (error) {
				if (acquired) await this.revoke(acquired);
				if (!this.current(generation)) return false;
				if (error instanceof AuthError && error.code === "authorization_pending") throw error;
				this.login = null;
				await this.bestEffortCancel(login);
				throw error;
			}
		})();
		this.completing = operation;
		try { return await operation; } finally { if (this.completing === operation) this.completing = null; }
	}

	async cancel(): Promise<void> {
		const login = this.login;
		this.generation++;
		this.login = null;
		this.completing = null;
		if (login) await this.bestEffortCancel(login);
	}

	async getAccessToken(): Promise<string> {
		const session = this.session;
		if (!session || this.disposed) throw new AuthError("not_connected", "Connect to GitHub in the plugin settings.");
		if (session.expiresAt > this.now() + 60_000) return session.accessToken;
		if (this.refreshing) return this.refreshing;
		const generation = this.generation;
		const operation = (async () => {
			let acquired: AuthSession | null = null;
			try {
				if (session.refreshExpiresAt <= this.now()) throw new AuthError("expired", "GitHub sign-in expired. Connect again.");
				const response = await this.call(session.relayUrl, "/auth/refresh", { refreshToken: session.refreshToken });
				const next = this.parseTokens(response, session.relayUrl);
				acquired = next;
				if (!this.current(generation) || this.session !== session) {
					throw new AuthError("cancelled", "GitHub connection changed before the upload started.");
				}
				await this.persist(next, generation);
				if (!this.current(generation)) throw new AuthError("cancelled", "GitHub connection changed before the upload started.");
				this.session = next;
				return next.accessToken;
			} catch (error) {
				if (acquired) await this.revoke(acquired);
				if (this.current(generation)) {
					this.session = null;
					await this.persist(null, generation);
				}
				if (error instanceof AuthError && error.code === "cancelled") throw error;
				throw new AuthError("reauthenticate", "GitHub sign-in could not be renewed. Connect again before uploading.");
			}
		})();
		this.refreshing = operation;
		try { return await operation; } finally { if (this.refreshing === operation) this.refreshing = null; }
	}

	async disconnect(): Promise<boolean> {
		const session = this.session;
		const login = this.login;
		this.generation++;
		this.session = null;
		this.login = null;
		this.refreshing = null;
		this.completing = null;
		await this.persist(null, this.generation);
		if (login) await this.bestEffortCancel(login);
		return session ? this.revoke(session) : true;
	}

	dispose(): void {
		const login = this.login;
		this.generation++;
		this.disposed = true;
		this.login = null;
		this.session = null;
		if (login) void this.bestEffortCancel(login);
	}

	private current(generation: number): boolean { return !this.disposed && this.generation === generation; }

	private persist(session: AuthSession | null, generation: number): Promise<void> {
		const write = this.writes.catch(() => {}).then(async () => {
			if (!this.current(generation)) return;
			try {
				await this.dependencies.storage.save(session);
				if (session && !this.current(generation)) await this.dependencies.storage.save(null);
			} catch { throw new AuthError("storage", "Could not update stored GitHub credentials. Check Obsidian Secret storage before reconnecting."); }
		});
		this.writes = write;
		return write;
	}

	private parseTokens(value: unknown, relayUrl: string): AuthSession {
		const token = object(value);
		if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 4096 ||
			typeof token.refresh_token !== "string" || !token.refresh_token || token.refresh_token.length > 4096 ||
			token.token_type !== "bearer" || typeof token.expires_in !== "number" || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 86400 ||
			typeof token.refresh_token_expires_in !== "number" || !Number.isSafeInteger(token.refresh_token_expires_in) || token.refresh_token_expires_in <= 0 || token.refresh_token_expires_in > 366 * 86400) {
			throw new AuthError("token_response", "The relay did not return expiring GitHub credentials. Connect again after checking its configuration.");
		}
		return { relayUrl, accessToken: token.access_token, refreshToken: token.refresh_token,
			expiresAt: this.now() + token.expires_in * 1000, refreshExpiresAt: this.now() + token.refresh_token_expires_in * 1000 };
	}

	private async revoke(session: AuthSession): Promise<boolean> {
		try { await this.call(session.relayUrl, "/auth/revoke", { accessToken: session.accessToken }); return true; }
		catch { return false; }
	}

	private async bestEffortCancel(login: PendingLogin): Promise<void> {
		try { await this.call(login.relayUrl, "/auth/cancel", { transactionId: login.transactionId, codeVerifier: login.verifier }); } catch { /* 서버에서도 짧은 TTL로 정리한다. */ }
	}

	private async call(relay: string, path: string, body?: object): Promise<unknown> {
		let response: { status: number; json?: unknown };
		let timer: number | undefined;
		try {
			const request = this.dependencies.request({ url: `${relay}${path}`, method: body ? "POST" : "GET",
				headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}) });
			response = await Promise.race([request, new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error("Authentication request timed out")), 20_000);
			})]);
		} catch { throw new AuthError("network", "Could not reach the authentication relay. Check the connection and try again."); }
		finally { if (timer !== undefined) window.clearTimeout(timer); }
		if (response.status >= 200 && response.status < 300) return response.json;
		const code = object(response.json).error;
		if (response.status === 409 && code === "authorization_pending") throw new AuthError("authorization_pending", "Finish approval in your browser, then choose Complete sign in.");
		if (code === "user_denied") throw new AuthError("user_denied", "GitHub sign-in was declined. Connect again when ready.");
		if (response.status === 429) throw new AuthError("rate_limited", "Too many sign-in requests. Wait before trying again.");
		throw new AuthError("relay_error", "GitHub sign-in could not be completed. Connect again or check the relay configuration.");
	}
}
