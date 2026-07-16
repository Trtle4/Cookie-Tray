# Cookie Tray Sizer

Parametric 3D-printable cookie sizing tray/gauge generator. Genuine 3D solid
modeling (CadQuery / OpenCASCADE), exporting watertight STEP + STL.

This is a standalone module — a sibling to (not an extension of) any 2D
dieline/DXF tooling elsewhere in this repo.

## Install

```
pip install -r requirements.txt
```

## Usage

Forward path — set tray parameters directly:

```python
from cookie_tray import TrayParams, build_tray, export

params = TrayParams(n_cells=3, cell_len=170, cell_wid=48, cell_h=28)
part = build_tray(params)
export(part, "tray", out_dir="out")  # writes out/tray.step and out/tray.stl
```

Inverse path — derive parameters from a product spec:

```python
from cookie_tray import ProductSpec, derive_params, build_tray, export

spec = ProductSpec(
    cookie_diameter=45.0,
    cookie_thickness=12.0,
    qty_total=24,
    n_cells=3,  # or cookies_per_cell=8
)
params = derive_params(spec)
part = build_tray(params)
export(part, "tray", out_dir="out")
```

Both paths produce the same `TrayParams` object and feed the same
`build_tray` — one geometry path, two front doors.

## Layout

```
cookie_tray/
  params.py       # TrayParams: inputs + derived (read-only) + validation guards
  geometry.py      # rrect, trough_neg, build_tray, export
  calculator.py    # ProductSpec -> TrayParams
  tests/           # pytest suite
```

## Tests

```
pytest
```

## Web app

`web/` is a shareable, zero-install browser app (replicad + three.js + Vite)
that ports this same geometry to run client-side and exports STEP + STL from
a link — no Python, no scripts. This Python module remains the geometry
source of truth; see `web/README.md` for details.
