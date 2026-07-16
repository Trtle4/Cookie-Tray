# Cookie Tray Sizer — Web App

A shareable, zero-install browser app that reproduces the `cookie_tray/`
Python module's geometry (parametric cookie sizing tray) so a non-technical
person can open a link, plug in numbers, see the tray, optionally preview it
filled with product, and download STL + STEP.

**`cookie_tray/` (Python) is the geometry source of truth.** This app is a
port of it to [replicad](https://replicad.xyz) (OpenCASCADE compiled to
WebAssembly), which is what makes real STEP export possible client-side —
mesh-only tools (OpenSCAD, trimesh) can't do that.

## Stack

- **replicad** + **replicad-opencascadejs** (single-threaded WASM build — no
  COOP/COEP / cross-origin-isolation headers required).
- **three.js** for the live preview.
- **Vite** (vanilla JS, no framework) for dev + build.
- Geometry runs in a **Web Worker** so the UI stays responsive during OCC
  boolean operations (a full tray build takes a few seconds).

## Develop

```
npm install
npm run dev
```

Open the printed local URL. The left panel has two always-visible sections:

- **Product** — a product type toggle (**Round** or **Rectangle**), plus
  quantity and either a cell count or cookies-per-cell. Round takes
  diameter/thickness; Rectangle takes width/height/thickness and independent
  top/bottom edge radii (visualization only). This drives the product-fill
  preview and *suggests* values for the Tray section's cell width/height/
  cradle radius/cell count (Rectangle suggests a 5mm cradle radius, since a
  rectangular product has no natural radius to hug).
- **Tray** — every tray parameter (§3 of the spec), directly editable.
  Fields currently populated by a Product suggestion are highlighted; typing
  into one makes it yours from then on (the Product section stops
  overwriting it). Divider and cell pitch are two views of the same value —
  editing either updates the other.

Toggle **Show product fill** to overlay the packed product at true size —
useful for sanity-checking that a hand-tuned Tray field still fits the
product spec (shrink a dimension and watch the shapes poke through the
wall). Every product rests with its lowest point exactly at the cell floor,
regardless of the cradle radius.

The viewport toolbar above the 3D canvas has camera view buttons (**Iso**,
**Top**, **Bottom**, **Front**, **Side** — each re-fits to the current
model, orbit stays interactive afterward) and a **Cross-section** toggle
with an axis selector and position slider. The cross-section clips both the
tray and the product fill together, so you can see how the product nests in
the cradle.

## Build

```
npm run build
```

Outputs a static site to `dist/` (`npm run preview` serves it locally to
sanity-check the production build before deploying).

## Deploy (share as a link, zero install for recipients)

- **Netlify Drop**: `npm run build`, then drag `dist/` onto
  https://app.netlify.com/drop for an instant public URL. No account/CLI
  config needed — the fastest path to "send someone a link."
- **GitHub Pages**: add a Pages Action that builds `web/` and publishes
  `dist/`; set `base: "/<repo-name>/"` in `vite.config.js` first. Requires a
  public repo (or GitHub Pro for private).

Recipients just open the URL in Chrome/Edge — nothing to install.

## Layout

```
web/
  index.html          # layout: left = param form, right = 3D canvas, top = export buttons
  src/
    main.js            # UI wiring, debounce, three.js viewport glue
    worker.js           # loads OCC WASM, builds the tray, returns mesh + STL/STEP blobs
    geometry.js          # buildTray + troughNeg — replicad port of cookie_tray/geometry.py
    params.js             # TrayParams port — inputs, derived values, §3 validation guards
    calculator.js          # ProductSpec -> TrayParams — port of cookie_tray/calculator.py
    viewer.js               # three.js scene/camera/controls, mesh + edges rendering
    fill.js                  # three.js cookie-fill overlay (visualization only, never exported)
    style.css
```

## Notes

- The product fill is a three.js overlay only — it is never fused into the
  exported solid.
- If a replicad API used here ever drifts from current docs, trust the docs
  and the Python geometry in `cookie_tray/` over this app's code.
