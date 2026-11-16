# GitHub App authentication relay

This Node.js 20+ service exchanges GitHub App authorization codes and rotating refresh tokens for the Obsidian plugin. It uses only Node's standard library. Images go directly from the plugin to GitHub; the relay never receives them.

The GitHub App client secret lives only in the server environment. The relay handles user tokens transiently while forwarding requests and responses, but does not persist tokens, authorization codes, images, or user accounts. It uses no GitHub App private key and creates no installation tokens.

## Register the GitHub App

1. Register a GitHub App with **Repository permissions → Contents: read and write**. Metadata is read-only. Keep other permissions disabled and install the App only on the intended public image repository.
2. Set its callback URL to `https://YOUR-AUTH-DOMAIN/auth/callback`. Use the same origin as `PUBLIC_BASE_URL` below. Do not enable **Request user authorization (OAuth) during installation**; authorization starts separately through this relay.
3. Keep expiring user access tokens enabled. The relay also requests `offline_access` and rejects non-expiring token responses. Disable **Webhooks → Active** because this service has no webhook receiver. No device flow or private key is used.
4. Copy the **Client ID** (not the numeric App ID), generate a client secret, and note the App slug from `https://github.com/apps/YOUR-SLUG`. Store the secret in the deployment platform's secret store or an access-restricted environment file. Never put it in plugin settings or commit it.
5. Configure the plugin with the HTTPS relay origin. The public `/auth/config` endpoint supplies the App installation link. After installation, return to the plugin to authorize and choose an accessible public repository.

A user access token is constrained by both the user's permissions and the App installation. Contents write can modify other content in the selected repository, not just images. The relay does not create repositories or install the App on the user's behalf.

See GitHub's [App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [web authorization and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), and [refresh-token rotation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) documentation.

## Run the server

There are no dependencies to install. From this directory:

```sh
cp .env.example .env
# Fill in the App credentials and public origin in .env, then restrict access.
chmod 600 .env
node --env-file=.env server.mjs
```

`--env-file` requires Node.js 20.6 or later. With earlier Node 20 versions, inject the same variables through your process supervisor. The source code requires Node.js 20 or later.

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub App Client ID |
| `GITHUB_CLIENT_SECRET` | Server-only client secret |
| `GITHUB_APP_SLUG` | Slug used in the App's GitHub URL |
| `PUBLIC_BASE_URL` | Exact public HTTPS origin, with no path, credentials, query, or fragment |
| `HOST` | Bind interface, default `127.0.0.1` |
| `PORT` | Bind port, default `3000` |
| `ALLOW_HTTP_LOOPBACK` | Default `false`; explicit `true` permits an HTTP loopback public origin for local development |
| `ALLOWED_ORIGINS` | Optional comma-separated exact browser origins; empty by default |

The plugin uses Obsidian's native `requestUrl`, so browser CORS is normally unnecessary. Requests without `Origin` are supported. Requests with an unlisted browser origin are rejected; CORS is not an authentication mechanism. Do not add a wildcard.

For a local relay test, use `PUBLIC_BASE_URL=http://127.0.0.1:3000` and `ALLOW_HTTP_LOOPBACK=true`. Real GitHub authorization still needs an appropriately registered callback and App credentials. Automated tests use a mock GitHub upstream and need no credentials.

### Container deployment

```sh
docker build -t image-paste-auth ./relay
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file relay/.env -e HOST=0.0.0.0 \
  -p 127.0.0.1:3000:3000 image-paste-auth
```

Run these commands from the repository root. The image runs as the unprivileged `node` user and includes no `.env` file. Terminate TLS at your ingress and forward to the bound port. Publish only HTTPS, keep Node/container security updates current, and configure the deployment platform's process health check to use `GET /health`.

Run **one process and one replica**. Pending login transactions exist only in memory for ten minutes. A restart loses pending logins and users must start again. Multiple independent replicas cannot share this state. Access and refresh tokens already held by the plugin do not depend on this pending-login map.

Configure ingress request limits and a maximum 16 KiB request body. The built-in limits are 120 authentication requests per minute per socket IP, 1,000 pending transactions, 32 concurrent GitHub requests, and 10 seconds per upstream request. Rate-limit state is bounded to 10,000 socket IPs. The server does not trust `Forwarded` or `X-Forwarded-*`; behind a reverse proxy, the built-in per-IP quota is shared by clients of that proxy. Apply real client-IP limiting at the trusted ingress, rather than accepting arbitrary forwarded headers in the relay.

**Disable request-query and request/response-body logging at the proxy, hosting platform, and error tracker.** GitHub callback queries contain short-lived authorization codes. The service itself logs only startup/configuration status, never request URLs, bodies, tokens, codes, or upstream error text. Secret rotation belongs in the hosting platform; restarting afterward invalidates pending logins.

## API contract

All POST endpoints require `Content-Type: application/json`. Responses are `Cache-Control: no-store`. Tokens and proofs are sent in request/response bodies, never URL query parameters. The only browser callback query is GitHub's short-lived code and server-generated OAuth state.

| Method and endpoint | Request | Response |
| --- | --- | --- |
| `GET /health` | None | `{ "status": "ok" }` |
| `GET /auth/config` | None | `{ clientId, appSlug, installationUrl, callbackUrl }` |
| `POST /auth/start` | `{ codeChallenge, clientState }` | `{ transactionId, authorizationUrl, expiresAt }`, with epoch milliseconds |
| `GET /auth/callback` | GitHub's `code` or `error`, plus `state` | HTML containing a fixed **Return to Obsidian** link |
| `POST /auth/complete` | `{ transactionId, codeVerifier }` | GitHub token pair described below |
| `POST /auth/cancel` | `{ transactionId, codeVerifier }` | `204` |
| `POST /auth/refresh` | `{ refreshToken }` | Rotated GitHub token pair |
| `POST /auth/revoke` | `{ accessToken }` | `204` when revoked or already absent |

`clientState` is 32 random bytes encoded as 43 base64url characters. `codeVerifier` is 43–128 RFC 7636 unreserved characters; generate it with a cryptographically secure random generator. `codeChallenge` is its SHA-256 digest encoded as 43 base64url characters. The plugin keeps the verifier locally until completion or cancellation.

The relay generates a separate transaction ID and OAuth state, each from 32 random bytes. GitHub's callback must match that OAuth state and can be used only once. The code stays in relay memory; the browser receives only:

```text
obsidian://image-paste-on-github-auth?transaction_id=TRANSACTION_ID&state=CLIENT_STATE
```

There is no code, token, verifier, vault name, arbitrary callback URL, or user-selected redirect destination in that link. The plugin must compare both the transaction ID and its original client state before calling `/auth/complete`. The relay independently checks the S256 verifier and marks the transaction as consuming before awaiting GitHub. A second completion cannot perform another exchange. A failed exchange or lost completion response requires a new login.

Token responses contain only:

```json
{
  "access_token": "USER_ACCESS_TOKEN",
  "token_type": "bearer",
  "expires_in": 28800,
  "refresh_token": "REFRESH_TOKEN",
  "refresh_token_expires_in": 15897600
}
```

Clients must use the returned lifetimes, persist both new tokens together, and avoid concurrent refreshes. GitHub rotates refresh tokens; the previous pair stops working after a successful refresh. The relay does not retry refresh automatically. A lost refresh response can require signing in again.

Errors use `{ "error": "stable_code", "message": "static message" }`. Notable codes are `invalid_request` (400), `invalid_proof` (403), `transaction_not_found` (404, including expiry/cancellation), `authorization_pending` (409, retry after browser authorization), `transaction_consumed` (409), `user_denied` (400), `rate_limited` (429), and `github_error` (502). GitHub error descriptions are never reflected. Denials still require the correct state and verifier. Cancelled, expired, and denied transactions cannot produce tokens.

Revocation calls GitHub's `DELETE /applications/{client_id}/token`, authenticated with the server client ID and secret. It does not revoke the entire App grant or uninstall the App. If only an expired or invalid access token remains, remote revocation of a newer token cannot be guaranteed; users can revoke the authorization in their GitHub settings. Local sign-out and remote revocation should be reported separately if the network request fails.

## Verification

```sh
npm test --prefix relay
```

Run from the repository root. Tests use a real local HTTP relay and a mocked GitHub `fetch`; they never exchange real credentials or upload images. They cover the complete PKCE flow, state and callback replay, concurrent completion, expiry during request receipt, cancellation, rotation, revocation, body and concurrency limits, fixed upstream destinations, CORS, and redacted failures.

The relay is deployment preparation until a real App, HTTPS domain, and operator secret are configured. Local tests do not establish that a deployment's TLS, proxy logging, GitHub installation, desktop deep link, or mobile deep link is configured correctly.
