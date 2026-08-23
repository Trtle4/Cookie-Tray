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
3. The base taper is a SINGLE continuous loft over the full height H, never
   a bounded band + vertical step (that used to leave a visible crease on
   tall/thin-walled trays). When the wall is thin relative to cell height,
   the draft *angle* itself shrinks (``effective_draft_deg``) so the base
   inset never exceeds ``wall - MIN_WALL``, instead of tapering steeply for
   part of the height and going vertical for the rest.
4. The trough cut is extended a few mm above the rim so the boolean cut
   passes cleanly through the flange/lip instead of leaving a coincident
   face (and a boolean sliver) exactly at z=H.
5. The flange strip (and therefore the whole outer racetrack -- flange,
   chamfer, lip) can have different insets on the long-axis sides
   (``strip_l``) vs the width-axis sides (``strip_w``). The chamfer uses a
   loft (not a taper-extrude, which is isotropic) so each axis gets its own
   inset; see ``loft_rrect``.
"""

from __future__ import annotations

import os

import cadquery as cq

from .params import TrayParams


def rrect(L: float, W: float, r: float) -> cq.Sketch:
    """A rounded-rectangle ("racetrack") sketch of overall size L x W, corner radius r."""
    r = max(min(r, min(L, W) / 2 - 0.01), 0.4)
    return cq.Workplane("XY").sketch().rect(L, W).vertices().fillet(r).finalize()


def _rrect_wire(L: float, W: float, r: float, z: float) -> cq.Wire:
    """The outer wire of an ``rrect`` profile, located at height ``z``."""
    sk = rrect(L, W, r).val()
    wire = sk._faces.Wires()[0]
    return wire.located(cq.Location(cq.Vector(0, 0, z)))


def loft_rrect(
    L1: float, W1: float, r1: float, z1: float, L2: float, W2: float, r2: float, z2: float
) -> cq.Workplane:
    """Loft between two rounded-rectangle profiles of independent size/height.

    Unlike a taper-extrude (isotropic — the same inset in every direction),
    a loft can have different X and Y insets between the two profiles, which
    the chamfer needs when ``strip_l != strip_w``.
    """
    w1 = _rrect_wire(L1, W1, r1, z1)
    w2 = _rrect_wire(L2, W2, r2, z2)
    return cq.Workplane("XY").add(cq.Solid.makeLoft([w1, w2]))


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


def build_product(
    product_type: str,
    *,
    diameter: float | None = None,
    thickness: float | None = None,
    width: float | None = None,
    height: float | None = None,
    edge_r_top: float = 0.0,
    edge_r_bot: float = 0.0,
) -> cq.Workplane:
    """Build a single product unit as a real, exportable solid -- a round
    cylinder or a rounded-edge rectangular block -- never fused into the
    tray. This is the standalone-export counterpart to the always
    viz-only three.js overlay (``web/src/fill.js`` draws the identical
    rectangle profile, display only).

    Both shapes extrude along X (the channel axis), matching the fill
    overlay's convention, so ``thickness`` (the pack pitch along the
    channel) is the depth along X.

    Rectangle corner rounding is done by filleting the SOLID's own X-parallel
    edges (top pair at ``edge_r_top``, bottom pair at ``edge_r_bot``) rather
    than pre-rounding a 2D profile: a 2D sketch's vertex-selector fillet
    does not reliably discriminate top from bottom (verified empirically --
    it silently fillets all four corners at whichever radius was applied
    last), while edge selectors on the real extruded solid do.
    """
    if product_type == "round":
        if diameter is None or thickness is None:
            raise ValueError("round product requires diameter and thickness")
        return cq.Workplane("YZ").circle(diameter / 2.0).extrude(thickness)

    if product_type == "rectangle":
        if width is None or height is None or thickness is None:
            raise ValueError("rectangle product requires width, height, and thickness")
        # -0.01 safety margin (same convention as rrect()): a fillet radius
        # exactly equal to half the shape's own smaller dimension is
        # geometrically degenerate (OCC: "BRep_API: command not done").
        max_r = max(0.0, min(width, height) / 2.0 - 0.01)
        rt = min(max(edge_r_top, 0.0), max_r)
        rb = min(max(edge_r_bot, 0.0), max_r)

        part = cq.Workplane("YZ").rect(width, height).extrude(thickness)
        if rt > 1e-9:
            part = part.edges("|X").edges(">Z").fillet(rt)
        if rb > 1e-9:
            part = part.edges("|X").edges("<Z").fillet(rb)
        return part

    raise ValueError(f'product_type must be "round" or "rectangle", got {product_type!r}')


def build_tray(params: TrayParams) -> cq.Workplane:
    """Build the tray solid for the given :class:`TrayParams`.

    Both the forward path (user-set §3 inputs) and the inverse path
    (:func:`cookie_tray.calculator.derive_params`) produce a
    :class:`TrayParams` and call this same function — one geometry path,
    two front doors.
    """
    p = params

    H = p.H
    top_L = p.top_L
    top_W = p.top_W
    o_L, o_W, o_r = p.outer_L, p.outer_W, p.outer_r

    # Drafted body: ONE continuous taper from the inset base (bottom radius
    # derived so the top lands exactly on corner_r) to the rim, using
    # effective_draft_deg rather than draft_deg so a wall-limited inset
    # still lands exactly on bottom_L/bottom_W over the full height H (no
    # vertical band/step). When draft_offset is 0 (no draft, or draft_deg
    # 0), effective_draft_deg is 0 too, so this is just a plain extrude.
    body = rrect(p.bottom_L, p.bottom_W, p.bottom_corner_r).extrude(H, taper=-p.effective_draft_deg)

    # Flange strip flush with rim (outer flange beyond body).
    body = body.union(
        rrect(o_L, o_W, o_r).extrude(p.flange_t).translate((0, 0, H - p.flange_t))
    )

    # 45 deg support chamfer, expands upward to the flange outer edge.
    # Per-axis inset (strip_l on X, strip_w on Y) via a loft rather than a
    # (necessarily isotropic) taper-extrude, so strip_l != strip_w still
    # gets a real 45 deg chamfer on whichever axis has the larger inset —
    # the other axis ends up shallower than 45 deg, which is still fine for
    # support-free printing (never exceeds it).
    d_l = p.strip_l + 1
    d_w = p.strip_w + 1
    d_r = min(d_l, d_w)
    chamfer_h = max(d_l, d_w)
    chamfer_z = H - p.flange_t - chamfer_h
    body = body.union(
        loft_rrect(
            o_L - 2 * d_l, o_W - 2 * d_w, o_r - d_r, chamfer_z,
            o_L, o_W, o_r, H - p.flange_t,
        )
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
    # Cell 0 starts after the outer wall; consecutive cells are spaced by
    # the pitch (cell_wid + divider) — outer walls use `wall`, internal
    # dividers between cells use `divider` (see top_W).
    #
    # A thin wall combined with a comparatively large corner_r leaves a
    # numerically fragile boolean seam near the tray's own rounded corner
    # (independent of cradle/draft) that a big-enough plan-view corner
    # fillet on the trough resolves as a side effect, the same class of OCC
    # boolean fragility as the shallow-cradle case the fillet already fixes.
    # Bump the fillet radius used for the cut (never below what the user
    # asked for) only in that risky range.
    cell_fillet = p.cell_fillet
    if p.wall < 2.0 and p.corner_r > 6.0:
        cell_fillet = max(cell_fillet, 5.0)

    # Columns (n_cols, default 1) split each row's single cell_len-long
    # channel into n_cols shorter end-to-end sub-cells along X, spaced by
    # col_pitch (cell_len + col_divider) -- mirrors the row spacing above,
    # on the orthogonal axis. n_cols=1 collapses cx to 0.0 for every j,
    # identical to the pre-columns single-cut-per-row behavior.
    for j in range(p.n_cells):
        cy = -top_W / 2 + p.wall + p.cell_wid / 2 + j * p.pitch
        for k in range(p.n_cols):
            cx = -top_L / 2 + p.wall + p.cell_len / 2 + k * p.col_pitch
            part = part.cut(
                trough_neg(cx, cy, p.floor, p.cell_len, p.cell_wid, p.cell_h, p.cradle_r, cell_fillet)
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
