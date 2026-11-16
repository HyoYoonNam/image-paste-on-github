"""Build the README's original workflow illustration, without network access."""

from html import escape
from pathlib import Path
import shutil
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
PURPLE = "#7154c7"
GREEN = "#18765b"
INK = "#242436"
MUTED = "#66667b"


def text(x, y, value, size=18, color=INK, weight=400, **attrs):
    extra = " ".join(f'{key.replace("_", "-")}="{value}"' for key, value in attrs.items())
    return (
        f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" '
        f'font-weight="{weight}" {extra}>{escape(value)}</text>'
    )


def box(x, y, width, height, fill, radius=12, stroke="none"):
    return (
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" '
        f'rx="{radius}" fill="{fill}" stroke="{stroke}"/>'
    )


def picture(x, y, width, height):
    return f'''<svg x="{x}" y="{y}" width="{width}" height="{height}" viewBox="0 0 300 144">
      <rect width="300" height="144" rx="8" fill="#e7e5f6"/>
      <circle cx="239" cy="35" r="17" fill="#efc975"/>
      <path d="M0 112 75 36 160 144H0Z" fill="#ab9ed9"/>
      <path d="m61 144 113-108 126 108Z" fill="#7f70b4"/>
      <path d="m145 64 29-28 32 28-19-5-13 10-12-10Z" fill="#f8f7fd"/>
      <path d="M0 123q75-25 144 0t156-4v25H0Z" fill="#c5bde2"/>
    </svg>'''


def frame(stage):
    items = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520" role="img" aria-labelledby="title desc">',
        '<title id="title">Paste an image, upload it to GitHub, and embed it in your note</title>',
        '<desc id="desc">Workflow illustration, not a screen recording. On successful upload, the image file is stored in a public GitHub repository. The Obsidian note embeds its raw URL and no local attachment is created.</desc>',
        '<g font-family="Arial, Helvetica, sans-serif">',
        box(0, 0, 960, 520, "#f7f7fb", 20),
        text(28, 37, "IMAGE PASTE ON GITHUB", 14, MUTED, 700, letter_spacing="1.3"),
        text(932, 37, "WORKFLOW ILLUSTRATION", 12, MUTED, 400, text_anchor="end", letter_spacing="1"),
    ]
    for index, (x, label) in enumerate([(28, "Paste an image"), (342, "Upload to GitHub"), (656, "See it in your note")], 1):
        active = stage == index
        items.extend([
            box(x, 58, 276, 50, "#eee9fb" if active else "#ffffff", 12),
            f'<circle cx="{x + 25}" cy="83" r="14" fill="{PURPLE if active else "#efedf5"}"/>',
            text(x + 25, 89, str(index), 16, "#ffffff" if active else MUTED, 700, text_anchor="middle"),
            text(x + 49, 90, label, 19, PURPLE if active else MUTED, 700 if active else 400),
        ])
        if index < 3:
            items.append(text(x + 295, 90, "›", 26, "#b4adc6", text_anchor="middle"))

    items.extend([
        box(28, 129, 520, 285, "#ffffff", 14, "#dddce8"),
        box(588, 129, 344, 285, "#ffffff", 14, "#dddce8"),
        text(48, 159, "OBSIDIAN", 12, PURPLE, 700, letter_spacing="1"),
        text(528, 159, "Your vault", 13, MUTED, text_anchor="end"),
        '<path d="M28 174h520M588 174h344" stroke="#e5e3ed"/>',
        text(608, 159, "GITHUB", 12, GREEN, 700, letter_spacing="1"),
        text(912, 159, "Public repository", 13, MUTED, text_anchor="end"),
        box(42, 189, 132, 211, "#f8f7fb", 8),
        text(55, 212, "FILES", 11, MUTED, 700, letter_spacing="0.8"),
        box(49, 225, 118, 31, "#eee9fb", 6),
        text(60, 246, "Notes.md", 15, PURPLE),
        text(55, 371, "Local attachments", 11, MUTED),
        text(55, 390, "0 added", 16, GREEN, 700),
        text(194, 213, "Notes", 24, INK, 700),
        text(194, 239, "A view worth keeping.", 16, MUTED),
        text(608, 211, "your-image-repo", 21, INK, 700),
        box(608, 226, 304, 35, "#f8f7fb", 6),
        text(623, 250, "assets/", 17, MUTED, 400, font_family="monospace"),
    ])

    if stage == 1:
        items.extend([
            picture(194, 252, 300, 120),
            box(313, 337, 197, 51, "#ffffff", 8, "#c8bce8"),
            text(411, 358, "Cmd / Ctrl + V", 17, PURPLE, 700, text_anchor="middle"),
            text(411, 378, "or drag an image", 13, MUTED, text_anchor="middle"),
            text(623, 300, "Waiting for an image", 17, MUTED),
        ])
        caption = ("01  Paste or drop", "Use any open Markdown note after setup.")
    elif stage == 2:
        items.extend([
            box(194, 262, 334, 74, "#f7f3ff", 8),
            text(208, 290, "![image-paste-uploading-…]()", 15, PURPLE, font_family="monospace"),
            text(208, 318, "Temporary placeholder", 14, MUTED),
            text(623, 299, "Uploading image…", 19, GREEN, 700),
            box(623, 317, 270, 6, "#e8eee9", 3),
            box(623, 317, 170, 6, GREEN, 3),
            text(623, 353, "The file goes to your repository.", 15, MUTED),
            '<path d="M554 275h27m-8-7 8 7-8 7" fill="none" stroke="#7154c7" stroke-width="2.5" stroke-linecap="round"/>',
        ])
        caption = ("02  Automatic upload", "The plugin commits the image to your public repository.")
    else:
        items.extend([
            picture(194, 251, 300, 118),
            text(194, 390, "Embedded from the raw URL", 14, GREEN, 700),
            box(608, 272, 304, 46, "#eff7f3", 8),
            text(623, 301, "pasted-…-… .png".replace(" ", ""), 17, GREEN, 400, font_family="monospace"),
            text(623, 347, "Image saved on GitHub", 18, GREEN, 700),
            text(623, 372, "Your note contains the link.", 16, MUTED),
            '<path d="M581 275h-27m8-7-8 7 8 7" fill="none" stroke="#18765b" stroke-width="2.5" stroke-linecap="round"/>',
        ])
        caption = ("03  Image in the note, file on GitHub", "On success, no local attachment is created.")

    items.extend([
        text(28, 451, caption[0], 21, INK, 700),
        text(28, 478, caption[1], 17, MUTED),
        text(932, 505, "Example filenames shortened", 11, MUTED, text_anchor="end"),
        "</g></svg>",
    ])
    return "\n".join(items) + "\n"


def main():
    for executable in ("rsvg-convert", "ffmpeg"):
        if not shutil.which(executable):
            raise SystemExit(f"Required for regenerating artwork: {executable}")

    (HERE / "paste-workflow.svg").write_text(frame(3))
    with tempfile.TemporaryDirectory(prefix="image-paste-artwork-") as temporary:
        work = Path(temporary)
        for stage in (1, 2, 3):
            svg = work / f"{stage}.svg"
            svg.write_text(frame(stage))
            subprocess.run(["rsvg-convert", str(svg), "-o", str(work / f"{stage}.png")], check=True)

        # 2 seconds for paste, 2 for upload, 5 for the result. Three full frames.
        (work / "frames.txt").write_text(
            "file '1.png'\nduration 2\nfile '2.png'\nduration 2\n"
            "file '3.png'\nduration 5\nfile '3.png'\n"
        )
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
            "-safe", "0", "-i", str(work / "frames.txt"), "-filter_complex",
            "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
            "-fps_mode", "vfr", "-loop", "0", str(HERE / "paste-workflow.gif"),
        ], check=True)


if __name__ == "__main__":
    main()
