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
 * 2. Body bottom corner radius = cornerR - D, so the drafted TOP lands
 *    exactly on cornerR (what the flange references).
 * 3. Draft opens toward the rim (top wider than bottom) — the loft goes from
 *    the smaller bottom rectangle to the larger top rectangle.
 * 4. Chamfer height is tied to stripW (d = stripW + 1) so it spans the
 *    overhang at 45 degrees.
 * 5. Internal cell walls stay vertical — only the outer body lofts/drafts.
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
 */
function troughNeg(cx, cy, floor, cellLen, cellWid, cellH, cradleR, fil) {
  const w = cellWid;
  const r = Math.min(cradleR, w / 2);
  let neg = null;

  // Full-width upper box, above the fillet centers. Pre-rounded with
  // cell_fillet (plan-view corner rounding) — no edge-finder needed.
  if (cellH - r > 1e-6) {
    const upperFil = Math.max(0, Math.min(fil, Math.min(cellLen, w) / 2 - 0.01));
    neg = drawRoundedRectangle(cellLen, w, upperFil)
      .sketchOnPlane("XY", floor + r)
      .extrude(cellH - r)
      .translate([cx, cy, 0]);
  }

  // Central flat-bottom box (zero width -> skipped when r === w/2).
  const flatW = w - 2 * r;
  if (flatW > 1e-6) {
    const flatFil = Math.max(0, Math.min(fil, flatW / 2 - 0.01));
    const b = drawRoundedRectangle(cellLen, flatW, flatFil)
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
  const D = H * Math.tan((p.draftDeg * Math.PI) / 180);
  const oL = topL + 2 * p.stripW;
  const oW = topW + 2 * p.stripW;
  const oR = p.cornerR + p.stripW;
  const lipT = 3 * p.nozzle;

  // Drafted body (narrow bottom -> wide top); bottom radius derived so the
  // top lands exactly on cornerR.
  const bottom = rrectSketch(topL - 2 * D, topW - 2 * D, p.cornerR - D, 0);
  const top = rrectSketch(topL, topW, p.cornerR, H);
  let part = bottom.loftWith(top);

  // Flange strip flush with rim.
  part = part.fuse(rrectSketch(oL, oW, oR, H - p.flangeT).extrude(p.flangeT));

  // 45 deg support chamfer (loft small bottom -> outer top).
  const d = p.stripW + 1;
  const cb = rrectSketch(oL - 2 * d, oW - 2 * d, oR - d, H - p.flangeT - d);
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
