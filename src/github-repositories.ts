export interface ImageRepository {
	id: number;
	owner: string;
	name: string;
	defaultBranch: string;
}

type GitHubGet = (path: string) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** 사용자와 App이 함께 접근할 수 있는 공개 저장소만 선택 목록에 넣는다. */
export async function listImageRepositories(get: GitHubGet): Promise<ImageRepository[]> {
	const repositories = new Map<number, ImageRepository>();
	for (let page = 1; page <= 20; page++) {
		const result = record(await get(`/user/installations?per_page=100&page=${page}`));
		if (!Array.isArray(result.installations)) throw new Error("GitHub returned an invalid installation list.");
		for (const value of result.installations) {
			const installation = record(value);
			if (!Number.isSafeInteger(installation.id) || installation.suspended_at || record(installation.permissions).contents !== "write") continue;
			for (let repoPage = 1; repoPage <= 20; repoPage++) {
				const response = record(await get(`/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`));
				if (!Array.isArray(response.repositories)) throw new Error("GitHub returned an invalid repository list.");
				for (const entry of response.repositories) {
					const repo = record(entry), owner = record(repo.owner);
					if (repo.private !== false || repo.archived === true || repo.disabled === true || record(repo.permissions).push !== true ||
						!Number.isSafeInteger(repo.id) || typeof repo.name !== "string" || typeof owner.login !== "string" || typeof repo.default_branch !== "string") continue;
					repositories.set(repo.id as number, { id: repo.id as number, owner: owner.login, name: repo.name, defaultBranch: repo.default_branch });
				}
				if (response.repositories.length < 100) break;
				if (repoPage === 20) throw new Error("Too many repositories. Limit the GitHub App installation to your image repository.");
			}
		}
		if (result.installations.length < 100) return [...repositories.values()].sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
	}
	throw new Error("Too many installations. Limit the GitHub App to the account used for images.");
}
