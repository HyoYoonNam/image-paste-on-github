# README visuals

`paste-workflow.gif` and `paste-workflow.svg` are original illustrations of the
plugin's successful paste/upload/embed flow. They are not recordings of Obsidian
or GitHub. The note, repository, landscape, filenames, and progress indicator
are illustrative. Filenames and the upload placeholder are shortened for clarity.
No account, token, personal note, or external upload was used to create them.

The GIF shows three steps over nine seconds. The SVG is a static alternative
showing the result, with the three steps still visible. Both use explicit colors
for readability on light and dark README pages and contain no remote resources.

Regenerate both files from the same source with Python 3, `rsvg-convert` (librsvg),
and FFmpeg installed:

```sh
python3 docs/images/generate-workflow.py
```

These tools are only needed to regenerate the artwork, not to build the plugin.
The generated artwork and its source use the repository's MIT license.

`token-setup.png` is the existing GitHub token-configuration screenshot. It shows
the repository selection and Contents permission. Its expiration field says
"No expiration"; follow the README's recommendation to choose an expiration date.
