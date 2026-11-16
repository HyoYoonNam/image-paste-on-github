# README visuals

## Recorded Obsidian demo

`obsidian-paste-demo.gif` is a real screen recording made on macOS with Obsidian
1.12.7 on 2026-11-16. `obsidian-paste-demo.png` is a still frame from the same
recording. The plugin uses the local production bundle with source changes
through commit `83e038c`.

The capture uses a separate demo vault and the original synthetic artwork in
`demo-sample.svg` and `demo-sample.png`. The sample was opened in Preview, copied,
and pasted into an open Markdown note with Cmd+V. The recording shows the real
upload placeholder followed by the image loaded from GitHub. No personal image
was used. Authentication and plugin settings were completed before recording.

The upload created [this public sample image](https://raw.githubusercontent.com/HyoYoonNam/obsidian-image-cdn/main/assets/readme-demo/pasted-1794813871415-zqk7eo.png).
The returned Git blob SHA is `0afb7305fa3ef4779c0d56b050577ad50fb49c36`.
Both the source and uploaded PNG decode to identical 640 by 360 RGBA pixels;
Preview re-encoded the clipboard image, so their PNG file bytes differ. The demo
vault contained only the Markdown note outside `.obsidian`, with no local image
attachment after the upload.

The original capture is 17.5 seconds, recorded with macOS `screencapture` from the
demo area at `(0, 0, 1060, 650)` screen points, yielding 2120 by 1300 pixels. The
GIF keeps seconds 2.5 through 11.5 at the original speed, resizes to 1060 by 650,
and samples at 12 fps. No upload state was simulated and no overlay was added.
All 108 exported frames were reviewed. Only the demo note, file list, and sample
appear in the GIF; account, token, settings, and login screens are excluded.

The raw capture remains outside the repository. To export the reviewed segment
from a copy named `obsidian-paste-original.mov`:

```sh
ffmpeg -ss 2.5 -t 9 -i obsidian-paste-original.mov \
  -filter_complex 'fps=12,scale=1060:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4' \
  -loop 0 docs/images/obsidian-paste-demo.gif

ffmpeg -ss 8 -i obsidian-paste-original.mov -frames:v 1 \
  -vf scale=1060:-2:flags=lanczos docs/images/obsidian-paste-demo.png
```

The synthetic sample artwork uses the repository's MIT license. Its PNG can be
rendered from the SVG with `rsvg-convert`:

```sh
rsvg-convert docs/images/demo-sample.svg -o docs/images/demo-sample.png
```

## Workflow illustration

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

## Token setup reference

`token-setup.png` is the existing GitHub token-configuration screenshot. It shows
the repository selection and Contents permission. Its expiration field says
"No expiration"; follow the README's recommendation to choose an expiration date.
