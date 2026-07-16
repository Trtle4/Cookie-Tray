/**
 * Solid modeling — replicad (JS/OpenCASCADE-WASM) port of cookie_tray/geometry.py.
 *
 * The Python module is the geometry source of truth; this reproduces it
 * exactly, translating CadQuery's taper-extrude to replicad's loft (§4 of
 * the web spec). The build order and corner-radius derivation are
 * load-bearing — do not regress (see the numbered invariants below, same
 * four as the Python spec's §7):
 *
 * 1. Cut cells LAST (body -> flange -> chamfer -> lip -> then cut troughs).
 *    Cutting earlier can leave boolean slivers that cap or hole the openings.
 * 2. Body bottom corner radius = cornerR - draftOffset, so the drafted TOP
 *    lands exactly on cornerR (what the flange references).
 * 3. Draft opens toward the rim (top wider than bottom) — the loft goes from
 *    the smaller bottom rectangle to the larger top rectangle.
 * 4. Chamfer height/inset is per-axis (dL = stripL + 1 on X, dW = stripW + 1
 *    on Y), via a loft rather than a taper-extrude (which is isotropic) —
 *    stripL != stripW still gets a real 45 degree chamfer on the axis with
 *    the larger inset.
 * 5. Internal cell walls stay vertical — only the outer body lofts/drafts.
 * 6. The base taper is a SINGLE continuous loft over the full height H,
 *    never a bounded band + vertical step (that used to leave a visible
 *    crease on tall/thin-walled trays). When the wall is thin relative to
 *    cell height, the inset is limited so it never exceeds wall - MIN_WALL
 *    (the loft's implied angle just gets gentler — no extra angle math
 *    needed since a loft, unlike a taper-extrude, has no "angle" input).
 * 7. The trough cut is extended a few mm above the rim so the cut passes
 *    cleanly through the flange/lip instead of leaving a coincident face
 *    (a boolean sliver) exactly at z=H.
 * 8. A thin wall combined with a comparatively large cornerR leaves a
 *    numerically fragile boolean seam near the tray's own rounded corner
 *    (independent of cradle/draft) that a big-enough trough plan-view
 *    fillet resolves as a side effect — see the cellFillet floor below.
 */

import { drawRoundedRectangle, drawCircle } from "replicad";

import { MIN_WALL } from "./params.js";

/** A rounded-rectangle sketch on plane `plane` (default XY) at offset `z`. */
function rrectSketch(L, W, r, z = 0, plane = "XY") {
  const rr = Math.max(Math.min(r, Math.min(L, W) / 2 - 0.01), 0.4);
  return drawRoundedRectangle(L, W, rr).sketchOnPlane(plane, z);
}

/**
 * Negative solid for one rounded trough, long axis along X. Half-round
 * bottom when `cradleR === cellWid / 2`; otherwise a flat bottom of width
 * `cellWid - 2*cradleR` with `cradleR` fillets at the bottom corners,
 * collapsing continuously to the half-round at the cap.
 *
 * The upper box is extended a few mm above the rim (`RIM_OVERCUT`) so the
 * cut passes cleanly through the flange/lip instead of leaving a coincident
 * face (a boolean sliver) exactly at z=H. The plan-view corner fillet
 * (`fil`, spanning the full straight-wall height including the overcut) is
 * applied by edge-filleting the assembled union rather than pre-rounding
 * each sub-solid's profile: pre-rounding looks equivalent but removes the
 * vertical corner edges the fillet operation also relies on to resolve the
 * box/cylinder tangency where the flat bottom (when `cradleR < cellWid/2`)
 * meets the corner-rounding cylinders, which otherwise silently leaves a
 * non-manifold defect there.
 */
function troughNeg(cx, cy, floor, cellLen, cellWid, cellH, cradleR, fil) {
  const w = cellWid;
  const r = Math.min(cradleR, w / 2);
  let neg = null;

  const RIM_OVERCUT = 5.0;
  const upperH = cellH - r + RIM_OVERCUT;
  if (upperH > 1e-6) {
    neg = drawRoundedRectangle(cellLen, w, 0)
      .sketchOnPlane("XY", floor + r)
      .extrude(upperH)
      .translate([cx, cy, 0]);
  }

  // Central flat-bottom box (zero width -> skipped when r === w/2).
  const flatW = w - 2 * r;
  if (flatW > 1e-6) {
    const b = drawRoundedRectangle(cellLen, flatW, 0)
      .sketchOnPlane("XY", floor)
      .extrude(r)
      .translate([cx, cy, 0]);
    neg = neg ? neg.fuse(b) : b;
  }

  // Bottom corner fillets (single centered cylinder when full half-round).
  const signs = r >= w / 2 - 1e-9 ? [0] : [-1, 1];
  for (const sgn of signs) {
    const oy = cy + sgn * (w / 2 - r);
    const cyl = drawCircle(r)
      .sketchOnPlane("YZ", cx - cellLen / 2)
      .extrude(cellLen)
      .translate([0, oy, floor + r]);
    neg = neg ? neg.fuse(cyl) : cyl;
  }

  if (fil > 0) {
    const rr = Math.min(fil, cellLen / 2 - 0.1, w / 2 - 0.1);
    if (rr > 0) {
      neg = neg.fillet(rr, (e) => e.inDirection([0, 0, 1])); // fillet cell plan-view corners
    }
  }

  return neg;
}

/**
 * Build the tray solid for the given (already-validated) params object —
 * same shape as `makeTrayParams(...).params` from params.js.
 */
export function buildTray(p) {
  const R = Math.min(p.cradleR, p.cellWid / 2);
  const topL = p.cellLen + 2 * p.wall;
  // Outer walls (both sides) are `wall`; the nCells-1 internal dividers
  // between cells are `divider`.
  const topW = p.nCells * p.cellWid + 2 * p.wall + (p.nCells - 1) * p.divider;
  const pitch = p.cellWid + p.divider; // cell center-to-center spacing
  const H = p.floor + p.cellH;
  const draftRad = (p.draftDeg * Math.PI) / 180;
  // Base inset for a SINGLE continuous loft over the full height H, limited
  // so it never exceeds wall - MIN_WALL (thin walls just get a gentler
  // continuous taper, never a step).
  const maxInset = Math.max(0, p.wall - MIN_WALL);
  const fullInset = p.draftDeg > 0 ? H * Math.tan(draftRad) : 0;
  const draftOffset = Math.min(fullInset, maxInset);
  const oL = topL + 2 * p.stripL;
  const oW = topW + 2 * p.stripW;
  // min() keeps the corner blend clean when the two strip widths differ.
  const oR = p.cornerR + Math.min(p.stripL, p.stripW);
  const lipT = 3 * p.nozzle;

  // Drafted body: one continuous loft from the inset base (bottom radius
  // derived so the top lands exactly on cornerR) to the full-size rim.
  const bottom = rrectSketch(topL - 2 * draftOffset, topW - 2 * draftOffset, p.cornerR - draftOffset, 0);
  const top = rrectSketch(topL, topW, p.cornerR, H);
  let part = bottom.loftWith(top);

  // Flange strip flush with rim.
  part = part.fuse(rrectSketch(oL, oW, oR, H - p.flangeT).extrude(p.flangeT));

  // 45 deg support chamfer (loft small bottom -> outer top). Per-axis inset
  // (stripL on X, stripW on Y) so stripL != stripW still gets a real 45 deg
  // chamfer on whichever axis has the larger inset — the other axis ends up
  // shallower than 45 deg, which is still fine for support-free printing
  // (never exceeds it).
  const dL = p.stripL + 1;
  const dW = p.stripW + 1;
  const dR = Math.min(dL, dW);
  const chamferH = Math.max(dL, dW);
  const cb = rrectSketch(oL - 2 * dL, oW - 2 * dW, oR - dR, H - p.flangeT - chamferH);
  const ct = rrectSketch(oL, oW, oR, H - p.flangeT);
  part = part.fuse(cb.loftWith(ct));

  // Perimeter lip (ring).
  const lipOuter = rrectSketch(oL, oW, oR, H).extrude(p.lipH);
  const lipInner = rrectSketch(oL - 2 * lipT, oW - 2 * lipT, oR - lipT, H).extrude(p.lipH);
  part = part.fuse(lipOuter.cut(lipInner));

  // Cut cells LAST (prevents boolean slivers capping the openings). Cell 0
  // starts after the outer wall; consecutive cells are spaced by pitch
  // (cellWid + divider).
  //
  // A thin wall combined with a comparatively large cornerR leaves a
  // numerically fragile boolean seam near the tray's own rounded corner
  // (independent of cradle/draft) that a big-enough plan-view corner
  // fillet on the trough resolves as a side effect, the same class of OCC
  // boolean fragility as the shallow-cradle case the fillet already fixes.
  // Bump the fillet radius used for the cut (never below what the user
  // asked for) only in that risky range.
  let cellFillet = p.cellFillet;
  if (p.wall < 2.0 && p.cornerR > 6.0) {
    cellFillet = Math.max(cellFillet, 5.0);
  }

  for (let j = 0; j < p.nCells; j++) {
    const cy = -topW / 2 + p.wall + p.cellWid / 2 + j * pitch;
    part = part.cut(troughNeg(0, cy, p.floor, p.cellLen, p.cellWid, p.cellH, R, cellFillet));
  }

  if (p.longAxis === "Y") {
    part = part.rotate(90, [0, 0, 0], [0, 0, 1]);
  }

  return part;
}
