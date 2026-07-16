"""Solid modeling for the parametric cookie tray sizer.

Builds a watertight, 3D-printable sizing tray (§2/§4). The build order and
the drafted-body corner-radius derivation are load-bearing — see §7 of the
spec ("Gotchas") before touching either:

1. Cells are cut LAST, after body -> flange -> chamfer -> lip are unioned.
   Cutting earlier can leave boolean slivers that cap or hole the openings.
2. The drafted body's *bottom* corner radius is derived as ``corner_r - D``
   so the drafted *top* lands exactly on ``corner_r`` (what the flange
   references). A fixed bottom radius would make the top radius grow with
   draft and the flange would miss the body at the corners.
"""

from __future__ import annotations

import os

import cadquery as cq

from .params import TrayParams


def rrect(L: float, W: float, r: float) -> cq.Sketch:
    """A rounded-rectangle ("racetrack") sketch of overall size L x W, corner radius r."""
    r = max(min(r, min(L, W) / 2 - 0.01), 0.4)
    return cq.Workplane("XY").sketch().rect(L, W).vertices().fillet(r).finalize()


def trough_neg(
    cx: float,
    cy: float,
    floor: float,
    cell_len: float,
    cell_wid: float,
    cell_h: float,
    cradle_r: float,
    fil: float,
) -> cq.Workplane:
    """Negative solid for one rounded trough, long axis along X.

    Half-round bottom when ``cradle_r == cell_wid / 2``; otherwise a flat
    bottom of width ``cell_wid - 2*cradle_r`` with ``cradle_r`` fillets at
    the bottom corners, collapsing continuously to the half-round at the cap.
    """
    w = cell_wid
    r = min(cradle_r, w / 2.0)
    negs = []

    # Full-width upper box, above the fillet centers.
    if cell_h - r > 1e-6:
        negs.append(
            cq.Workplane("XY")
            .workplane(offset=floor + r)
            .box(cell_len, w, cell_h - r, centered=(True, True, False))
            .translate((cx, cy, 0))
        )

    # Central flat-bottom box (zero width -> skipped when r == w/2).
    flat_w = w - 2 * r
    if flat_w > 1e-6:
        negs.append(
            cq.Workplane("XY")
            .workplane(offset=floor)
            .box(cell_len, flat_w, r, centered=(True, True, False))
            .translate((cx, cy, 0))
        )

    # Bottom corner fillets (single centered cylinder when full half-round).
    signs = (0,) if r >= w / 2 - 1e-9 else (-1, 1)
    for sgn in signs:
        oy = cy + sgn * (w / 2 - r)
        cyl = cq.Solid.makeCylinder(
            r, cell_len, cq.Vector(cx - cell_len / 2, oy, floor + r), cq.Vector(1, 0, 0)
        )
        negs.append(cq.Workplane("XY").add(cyl))

    neg = negs[0]
    for e in negs[1:]:
        neg = neg.union(e)

    if fil > 0:
        try:
            neg = neg.edges("|Z").fillet(fil)  # fillet cell plan-view corners
        except Exception:
            pass

    return neg


def build_tray(params: TrayParams) -> cq.Workplane:
    """Build the tray solid for the given :class:`TrayParams`.

    Both the forward path (user-set §3 inputs) and the inverse path
    (:func:`cookie_tray.calculator.derive_params`) produce a
    :class:`TrayParams` and call this same function — one geometry path,
    two front doors.
    """
    p = params

    H = p.H
    top_W = p.top_W
    o_L, o_W, o_r = p.outer_L, p.outer_W, p.outer_r

    # Drafted body: bottom radius derived so the TOP lands exactly on corner_r.
    body = rrect(p.bottom_L, p.bottom_W, p.bottom_corner_r).extrude(H, taper=-p.draft_deg)

    # Flange strip flush with rim (outer flange beyond body).
    body = body.union(
        rrect(o_L, o_W, o_r).extrude(p.flange_t).translate((0, 0, H - p.flange_t))
    )

    # 45 deg support chamfer, expands upward to the flange outer edge.
    d = p.strip_w + 1
    body = body.union(
        rrect(o_L - 2 * d, o_W - 2 * d, o_r - d)
        .extrude(d, taper=-45.0)
        .translate((0, 0, H - p.flange_t - d))
    )

    # Perimeter lip (ring).
    lip = rrect(o_L, o_W, o_r).extrude(p.lip_h).translate((0, 0, H))
    lip = lip.cut(
        rrect(o_L - 2 * p.lip_t, o_W - 2 * p.lip_t, o_r - p.lip_t)
        .extrude(p.lip_h + 1)
        .translate((0, 0, H))
    )

    part = body.union(lip)

    # Cut cells LAST (prevents boolean slivers capping the openings).
    for j in range(p.n_cells):
        cy = -top_W / 2 + p.wall + p.cell_wid / 2 + j * (p.cell_wid + p.wall)
        part = part.cut(
            trough_neg(0.0, cy, p.floor, p.cell_len, p.cell_wid, p.cell_h, p.cradle_r, p.cell_fillet)
        )

    if p.long_axis == "Y":
        part = part.rotate((0, 0, 0), (0, 0, 1), 90)

    return part


def export(part: cq.Workplane, stem: str, out_dir: str = ".") -> tuple[str, str]:
    """Export ``part`` to both STEP and STL, sharing the same solid. Returns (step_path, stl_path)."""
    os.makedirs(out_dir, exist_ok=True)
    step_path = os.path.join(out_dir, f"{stem}.step")
    stl_path = os.path.join(out_dir, f"{stem}.stl")
    cq.exporters.export(part, step_path)
    cq.exporters.export(part, stl_path)
    return step_path, stl_path
