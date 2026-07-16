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
 * 6. The base taper is bounded: it only tapers over draftH (never insetting
 *    the base past wall - 0.5mm), then goes vertical up to the rim. An
 *    unbounded full-height taper would inset the base past the wall
 *    thickness on tall cells, undercutting them.
 * 7. The trough cut is extended a few mm above the rim so the cut passes
 *    cleanly through the flange/lip instead of leaving a coincident face
 *    (a boolean sliver) exactly at z=H.
 */

import { drawRoundedRectangle, drawCircle } from "replicad";

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
  const topW = p.nCells * p.cellWid + (p.nCells + 1) * p.wall;
  const H = p.floor + p.cellH;
  const draftRad = (p.draftDeg * Math.PI) / 180;
  // Bounded base taper offset: never exceeds wall - 0.5mm, regardless of
  // cell height (an unbounded H*tan(draftDeg) would inset the base past the
  // wall thickness on tall cells, undercutting them).
  const dUnbounded = p.draftDeg > 0 ? H * Math.tan(draftRad) : 0;
  const baseOffset = Math.max(0, Math.min(dUnbounded, p.wall - 0.5));
  const draftH = p.draftDeg > 0 && baseOffset > 0 ? baseOffset / Math.tan(draftRad) : 0;
  const oL = topL + 2 * p.stripL;
  const oW = topW + 2 * p.stripW;
  // min() keeps the corner blend clean when the two strip widths differ.
  const oR = p.cornerR + Math.min(p.stripL, p.stripW);
  const lipT = 3 * p.nozzle;

  // Drafted body: bounded base taper (bottom radius derived so the top
  // lands exactly on cornerR), then straight vertical walls up to the rim
  // once the taper completes at draftH. Short trays where the unbounded
  // taper never reaches the wall limit get draftH === H, i.e. a single loft
  // over the full height (unchanged from before).
  let part;
  if (baseOffset <= 1e-9) {
    part = rrectSketch(topL, topW, p.cornerR, 0).extrude(H);
  } else if (draftH >= H - 1e-6) {
    const bottom = rrectSketch(topL - 2 * baseOffset, topW - 2 * baseOffset, p.cornerR - baseOffset, 0);
    const top = rrectSketch(topL, topW, p.cornerR, H);
    part = bottom.loftWith(top);
  } else {
    const bottom = rrectSketch(topL - 2 * baseOffset, topW - 2 * baseOffset, p.cornerR - baseOffset, 0);
    const loftTop = rrectSketch(topL, topW, p.cornerR, draftH);
    const tapered = bottom.loftWith(loftTop);
    const straightBase = rrectSketch(topL, topW, p.cornerR, draftH);
    const straight = straightBase.extrude(H - draftH);
    part = tapered.fuse(straight);
  }

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

  // Cut cells LAST (prevents boolean slivers capping the openings).
  for (let j = 0; j < p.nCells; j++) {
    const cy = -topW / 2 + p.wall + p.cellWid / 2 + j * (p.cellWid + p.wall);
    part = part.cut(troughNeg(0, cy, p.floor, p.cellLen, p.cellWid, p.cellH, R, p.cellFillet));
  }

  if (p.longAxis === "Y") {
    part = part.rotate(90, [0, 0, 0], [0, 0, 1]);
  }

  return part;
}
