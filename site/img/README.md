# Site images

Drop real captures here; the page references them and gracefully shows a
branded placeholder until the file exists.

| File | Used for | Suggested size |
| --- | --- | --- |
| `repo.png` | Screenshot: repository page (tree + README) | ~1600×1000 |
| `pr.png`   | Screenshot: pull-request page (diff + merge) | ~1600×1000 |

Capture these from a running instance (`docker run … thecrux`) in both themes if
you like — the site itself toggles light/dark, so a dark capture looks at home.

## Social-share image (`og.png`)

`../index.html` points `og:image` / `twitter:image` at `og.png` (1200×630).
`../og.svg` is the ready-to-export source. Twitter/X and iMessage don't render
SVG, so export a PNG once:

```bash
# with rsvg-convert (librsvg)
rsvg-convert -w 1200 -h 630 ../og.svg -o ../og.png
# or ImageMagick
magick -density 144 -background none ../og.svg -resize 1200x630 ../og.png
# or: open og.svg in any browser and screenshot at 1200×630
```

Commit `og.png` next to `index.html`. Re-export whenever `og.svg` changes.
