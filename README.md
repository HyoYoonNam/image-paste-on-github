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
  with **Contents: read and write**. Nothing else is needed.
- The token is stored unencrypted in this vault's plugin data (`data.json`).

## Setup

1. Create a public repo to hold your images (e.g. `my-image-cdn`).
2. Create a fine-grained PAT: GitHub → Settings → Developer settings →
   Fine-grained tokens → restrict it to that one repo, grant **Contents: write**.
3. In Obsidian: Settings → Image Paste on GitHub, and fill in:
   - **GitHub token**
   - **Owner** (your username/org)
   - **Repository**
   - **Branch** (default `main`)
   - **Upload path** (folder prefix inside the repo, default `assets`)
4. Click **Test connection** to confirm push access and public visibility.

## Usage

Paste or drag an image into any note. A `![uploading...]()` placeholder appears,
and once the upload finishes it is replaced with `![](https://raw.githubusercontent.com/...)`.
If config is missing, Obsidian's default local-save behavior is left untouched.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # type-check + production bundle
```

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/image-paste-on-github/` to test.

## License

MIT
