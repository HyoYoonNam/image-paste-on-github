# Image Paste on GitHub

Upload pasted (or dropped) images straight to your own GitHub repository and insert
a `raw.githubusercontent.com` link instead of saving the file into your vault. Keep
your Obsidian vault small while your screenshots live on GitHub's CDN.

## Why

Unlike Notion, Obsidian stores every pasted image as a local file, so your vault
keeps growing. This plugin intercepts the paste, commits the image to a GitHub
repo you control, and embeds the public raw URL — nothing is written to your vault.

## ⚠️ Before you start

- **The target repository must be public.** Raw GitHub links only render without a
  token for public repos, so **every image you paste becomes publicly accessible.**
  Do not paste sensitive screenshots.
- Use a **fine-grained personal access token** scoped to a **single repository**
  with **Contents: read and write**, and give it an **expiration date**. Nothing
  else is needed, so a leaked token can only push to that one image repo.
- The token is stored **unencrypted** in this vault's plugin data (`data.json`).
  Do not sync, commit, or share `data.json`.

## Setup

Open Settings → Image Paste on GitHub. The settings are ordered so you choose the
repository first, then create a token scoped to it:

1. Fill in **Owner** (your username/org) and **Repository**.
2. **Create repository → Create**: makes a new public repo (and fills in owner and
   repository for you). If your token is scoped too narrowly to create repos, it
   opens GitHub's new-repo page instead. Skip this if the repo already exists.
3. **Create a token → Open GitHub**: generates a fine-grained PAT. Restrict it to
   that repository and grant **Contents: read and write**, then paste it into
   **GitHub token**.
4. Optionally adjust **Branch** (default `main`) and **Upload path** (default
   `assets`).
5. Click **Test connection** to confirm push access and public visibility.

Enter **Upload path** as a normal folder path, without URL encoding. Spaces,
Unicode, `#`, `?`, parentheses, and literal `%` characters are encoded in the
upload and image URLs while `/` keeps folders separate. Valid branch names with
`/`, such as `feature/images`, are supported; enter the branch name as-is.

When creating the token, restrict **Repository access** to your image repository and
set **Contents** to **Read and write** (Metadata stays Read-only):

![Fine-grained token settings with repository access limited to the image repo and Contents set to read and write](docs/images/token-setup.png)

## Usage

Paste or drag an image into any note. A `![uploading...]()` placeholder appears,
and once the upload finishes it is replaced with `![](https://raw.githubusercontent.com/...)`.
If config is missing, Obsidian's default local-save behavior is left untouched.
Mixed attachments (such as an image and a PDF) use Obsidian's default handling.
Canvas and editors outside an open Markdown note view also use the default handling.
Pending uploads stay tied to the original note when you switch tabs or rename the
note. Removing the upload placeholder cancels insertion and prevents uploads that
have not started. A conversion already running may finish, and an image already
uploaded to GitHub is not deleted.

Files with MIME types `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
`image/svg+xml`, `image/bmp`, and `image/avif` are uploaded without conversion.
These formats are selected by the file's MIME string, not by inspecting its bytes.

HEIC and HEIF files (`image/heic`, `image/heif`) are converted locally to JPEG before
uploading. A file with an empty MIME type is also accepted if its name ends in
`.heic` or `.heif`, ignoring case. Other unknown MIME types are not inferred from
filenames. If any attachment is unsupported, the entire paste or drop uses
Obsidian's default handling.

HEIC conversion uses the bundled decoder, without an external conversion service.
It converts one primary image (or the first image) at JPEG quality 0.9, without
preserving the original metadata or additional images. HEIC conversions run one
at a time. If the JPEG upload fails, **Save locally on failure** saves the converted
JPEG. If conversion itself fails, that setting preserves the original HEIC or HEIF
as a normal file link and shows a notice. With the setting off, no file is saved or
uploaded on conversion failure. Export the original as JPEG and try again.

## Development

```bash
npm ci
npm run dev    # watch build
npm run build  # type-check + production bundle
npm test       # mocked plugin and API regression tests
npm run test:browser  # real HEIC conversion using the production bundle
```

Development requires Node.js 20 or later. The browser test uses installed Google
Chrome by default. Set `CHROME_EXECUTABLE_PATH` to another Chrome or Chromium
executable if needed. It uses the synthetic fixture documented in
[`tests/fixtures/SOURCE.txt`](tests/fixtures/SOURCE.txt), blocks external network
requests, and replaces the GitHub API with a stub. No token is needed.

The converter dependency is pinned in `package.json` and `package-lock.json`.
To replace it, update that dependency and its lockfile, or the adapter in
`src/heic.ts`, then run `npm ci` and `npm run build`. Pinned upstream source and decoder build instructions
are listed in [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/image-paste-on-github/` to test.

## Security

Obsidian has no secure credential storage, so the token is kept **unencrypted** in
`data.json` — the same as other token-based plugins. The plugin only sends the token
to GitHub in the `Authorization` header; it is never written to your notes, logged,
or placed in URLs. The practical risk is `data.json` leaking through sync, backups,
or sharing, so the main protection is keeping the token narrowly scoped:

- Scope it to a **single public repository** with **Contents: read and write** only.
- Set an **expiration date** and rotate it.
- Never sync, commit, or share `data.json`.

With this setup, a leaked token can only push images to that one repo — it cannot
touch the rest of your GitHub account.

## License

The plugin's own code is MIT licensed. HEIC conversion bundles `heic-to` 1.6.7,
`libheif` 1.23.7, and `libde265` 1.0.16 under LGPL version 3 or later. Their source
links, attribution, and full license texts are in
[`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES) and are also included in the generated
`main.js` so they remain available in the installed plugin.
