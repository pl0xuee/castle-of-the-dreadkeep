# Castle of the Dreadkeep

A procedural medieval castle crawler — a retro raycaster-style FPS built with Three.js.
Enter the cursed halls, hunt the guardian, and escape the Dreadkeep alive.

## Run

### Standalone app (Windows / Linux)

The game ships as a self-contained desktop app (Electron). Prebuilt packages land
in `release/` after a build:

- **Linux:** `Castle of the Dreadkeep-<version>.AppImage` — `chmod +x` it and run.
- **Windows:** `Castle of the Dreadkeep Setup <version>.exe` — run the installer.

To build them yourself (needs Node + npm; the Windows cross-build needs Wine):

```sh
npm install
npm start          # run the app locally
npm run dist:linux # -> release/*.AppImage
npm run dist:win   # -> release/*Setup*.exe   (uses Wine on Linux)
npm run dist:all   # both
```

### In the browser

The game loads Three.js as an ES module, so it must be served over HTTP
(opening `index.html` directly via `file://` will not work — browsers block
module scripts on the file protocol).

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in your browser.

## Graphics & audio options

Open **Settings** from the title screen. Alongside resolution and fog you can tune:

- **Sharpness** — internal-buffer pixel ratio (0.75×–2×)
- **Anti-aliasing** — Off / MSAA 2× / MSAA 4× / SMAA
- **Shadows** — Off / Low / Medium / High (real cast shadows from nearby torches)
- **Dynamic lights** — how many torches light the scene at once
- **Bloom glow** — post-processing glow on flames, torches and magic
- **Crisp pixel rendering** — the original crunchy look (mutually exclusive with AA)

All settings apply live and persist between runs. Audio now runs through a
procedural stone-hall convolution reverb for spatial depth.

## Controls

- **Enter the Dreadkeep** — start
- **Mouse** — look
- **W / A / S / D** or **Arrow keys** — move
- **Left click** or **Space** — fire
- **R** — restart

## Contents

Fully self-contained, no network dependencies:

- `index.html` — the entire game (inlined styles + logic)
- `assets/vendor/three.module.js` — bundled Three.js
