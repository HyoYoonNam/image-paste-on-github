# GitHub App authentication relay

The relay runs on **Cloudflare Workers and D1**, both in production and in local workerd tests. It handles GitHub App browser authorization and token renewal; images upload directly from Obsidian to GitHub.

Plugin users can use the hosted relay without deploying anything. See the [plugin setup](../README.md#quick-start). For local development, GitHub App registration, and deployment, see the [Cloudflare guide](cloudflare/README.md). The [authentication design](../docs/auth-design.md) defines the API, PKCE flow, credential handling, and failure behavior.

From the repository root, with Node.js 22.12 or later:

```sh
npm ci
npm ci --prefix relay/cloudflare
npm run test:relay
```

`test:relay` and `test:cloudflare` run the same Cloudflare suite. Tests use the actual local workerd runtime and D1, with mocked GitHub requests. They include the plugin's `GitHubAuth` client, so no separate server or real GitHub credentials are needed.

The App client secret belongs only in the Worker's secret binding. D1 temporarily stores pending-login metadata and authorization codes, but never access tokens, refresh tokens, PKCE verifiers, or images. See the Cloudflare guide for expiry, cleanup, recovery, and logging requirements.
