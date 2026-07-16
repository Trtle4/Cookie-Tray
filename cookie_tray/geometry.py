"""Solid modeling for the parametric cookie tray sizer.

Builds a watertight, 3D-printable sizing tray (§2/§4). The build order and
the drafted-body corner-radius derivation are load-bearing — see §7 of the
spec ("Gotchas") before touching either:

1. Cells are cut LAST, after body -> flange -> chamfer -> lip are unioned.
   Cutting earlier can leave boolean slivers that cap or hole the openings.
2. The drafted body's *bottom* corner radius is derived as
   ``corner_r - draft_offset`` so the drafted *top* lands exactly on
   ``corner_r`` (what the flange references). A fixed bottom radius would
   make the top radius grow with draft and the flange would miss the body
   at the corners.
3. The base taper is bounded: it only tapers over ``draft_h`` (never
   insetting the base past ``wall - 0.5``mm), then goes vertical up to the
   rim. An unbounded full-height taper would inset the base past the wall
   thickness on tall cells, undercutting them. Short trays (where the
   unbounded taper never reaches the wall limit) are unaffected — ``draft_h``
   lands exactly on ``H`` and the body is a single loft, as before.
4. The trough cut is extended a few mm above the rim so the boolean cut
   passes cleanly through the flange/lip instead of leaving a coincident
   face (and a boolean sliver) exactly at z=H.
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

    The upper box is extended a few mm above the rim (``RIM_OVERCUT``) so the
    cut passes cleanly through the flange/lip instead of leaving a coincident
    face (a boolean sliver) exactly at z=H. The plan-view corner fillet
    (``cell_fillet``, spanning the full straight-wall height including the
    overcut) is applied by edge-filleting the assembled union rather than
    pre-rounding each sub-solid's profile: pre-rounding looks equivalent but
    removes the vertical corner edges the fillet operation also relies on to
    resolve the box/cylinder tangency where the flat bottom (when
    ``cradle_r < cell_wid/2``) meets the corner-rounding cylinders, which
    otherwise silently leaves a non-manifold defect there.
    """
    w = cell_wid
    r = min(cradle_r, w / 2.0)
    negs = []

    RIM_OVERCUT = 5.0
    upper_h = (cell_h - r) + RIM_OVERCUT
    if upper_h > 1e-6:
        negs.append(
            cq.Workplane("XY")
            .workplane(offset=floor + r)
            .box(cell_len, w, upper_h, centered=(True, True, False))
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
        rr = min(fil, cell_len / 2 - 0.1, w / 2 - 0.1)
        if rr > 0:
            neg = neg.edges("|Z").fillet(rr)  # fillet cell plan-view corners

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

    # Drafted body: bounded base taper (bottom radius derived so the top
    # lands exactly on corner_r), then straight vertical walls up to the
    # rim once the taper completes at draft_h. Short trays where the
    # unbounded taper never reaches the wall limit get draft_h == H, i.e. a
    # single loft over the full height (unchanged from before).
    if p.draft_offset <= 1e-9:
        body = rrect(p.top_L, p.top_W, p.corner_r).extrude(H)
    elif p.draft_h >= H - 1e-6:
        body = rrect(p.bottom_L, p.bottom_W, p.bottom_corner_r).extrude(H, taper=-p.draft_deg)
    else:
        tapered = rrect(p.bottom_L, p.bottom_W, p.bottom_corner_r).extrude(p.draft_h, taper=-p.draft_deg)
        straight = rrect(p.top_L, p.top_W, p.corner_r).extrude(H - p.draft_h).translate((0, 0, p.draft_h))
        body = tapered.union(straight)

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
