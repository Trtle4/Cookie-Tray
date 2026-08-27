/**
 * Inverse calculator — JS port of cookie_tray/calculator.py (§5).
 * Product dimensions -> tray-shaping suggestions. Layouts are 1xN, so there
 * is no 2D row x col factoring — just distribute a cookie count along one
 * axis.
 */

import { makeTrayParams } from "./params.js";

/**
 * The single round/rect branch point for product -> cell-shape math
 * (cellWid, the pack pitch along the channel, vertical extent, and the
 * cradleR suggestion). Both `suggestFromProduct` and anything else that
 * needs this mapping should call this rather than re-deriving it, so the
 * round/rectangle rules (cell_wid formula, "rectangles suggest a 5mm
 * cradle" rule) live in exactly one place and can't drift from each other.
 */
function resolveProductCellShape(spec) {
  const {
    productType = "round",
    packMode = "standing",
    cookieDiameter,
    cookieThickness,
    productWidth,
    productHeight,
    productThickness,
    sideClearance = 1.5,
    cradleClearance = 0.0,
  } = spec;

  let cellWid, packPitch, vertExtent;
  if (productType === "rectangle") {
    if (!(productWidth > 0) || !(productHeight > 0) || !(productThickness > 0)) {
      throw new Error("productWidth, productHeight, and productThickness must be > 0");
    }
    cellWid = productWidth + 2 * sideClearance;
    packPitch = productThickness;
    vertExtent = productHeight;
  } else {
    if (!(cookieDiameter > 0) || !(cookieThickness > 0)) {
      throw new Error("cookieDiameter and cookieThickness must be > 0");
    }
    cellWid = cookieDiameter + 2 * sideClearance;
    packPitch = cookieThickness;
    vertExtent = cookieDiameter;
  }

  const maxCradleR = cellWid / 2;
  let cradleR;
  if (packMode === "stack") {
    // A product lying flat rests on its own broad face, not a curved side --
    // same reasoning as the rectangle rule below (a modest fixed radius, not
    // a deep hugging curve), just applied whenever the product lies flat,
    // round or rectangle alike.
    cradleR = 2.5 - cradleClearance;
  } else if (productType === "rectangle") {
    // Rectangular products have no natural "radius" to hug; suggest a modest
    // fixed rounded-bottom radius instead of cellWid/2.
    cradleR = 5.0 - cradleClearance;
  } else {
    cradleR = cellWid / 2 - cradleClearance;
  }
  cradleR = Math.min(Math.max(cradleR, 0.5), maxCradleR);

  return { cellWid, packPitch, vertExtent, cradleR };
}

/**
 * The core product -> tray-shape math (cellWid/cellLen/cradleR/nCells),
 * without requiring or producing a full TrayParams. Used both as a
 * lightweight suggestion source for the always-visible tray form (main.js
 * fills in cellWid/cellLen/cradleR/nCells from this unless the user has
 * edited those fields themselves) and as the basis for the full round-trip
 * in `deriveParamsFromProduct`.
 */
export function suggestFromProduct(spec) {
  const { qtyTotal, nCells = null, cookiesPerCell = null, nCols = 1, endClearance = 3.0, packMode = "standing" } = spec;

  if ((nCells === null) === (cookiesPerCell === null)) {
    throw new Error("Supply exactly one of nCells or cookiesPerCell, not both/neither.");
  }
  if (!(qtyTotal >= 1)) {
    throw new Error(`qtyTotal must be >= 1, got ${qtyTotal}`);
  }
  if (!(nCols >= 1)) {
    throw new Error(`nCols must be >= 1, got ${nCols}`);
  }

  const { cellWid, packPitch, vertExtent, cradleR } = resolveProductCellShape(spec);

  let finalNCells, finalCookiesPerCell;
  if (cookiesPerCell !== null) {
    finalCookiesPerCell = cookiesPerCell;
    finalNCells = Math.ceil(qtyTotal / cookiesPerCell);
  } else {
    finalNCells = nCells;
    finalCookiesPerCell = Math.ceil(qtyTotal / nCells);
  }

  // finalCookiesPerCell is the total for one full row; nCols (default 1, no
  // change in behavior) splits that row's channel into nCols end-to-end
  // sub-cells (see params.js's nCols/colDivider). Every sub-cell (pocket)
  // gets the same count -- ceil(.../nCols), since an uneven split (see
  // fill.js's balanced-columns helper) puts the remainder on the busiest
  // column(s), and every pocket shares the same physical size regardless of
  // its own count. This is identical for both pack modes below -- only
  // which physical dimension that count drives differs.
  const maxPerColCell = Math.ceil(finalCookiesPerCell / nCols);

  let cellLen, cellH;
  if (packMode === "stack") {
    // Flat/stacked: each pocket holds a vertical stack of maxPerColCell
    // products lying flat, so the footprint (cellLen) doesn't grow with the
    // count -- it's just the product's other footprint dimension (round:
    // diameter; rectangle: height) plus clearance. The count instead drives
    // the STACK HEIGHT (cellH), the mirror image of the standing/channel
    // formulas below.
    cellLen = vertExtent + endClearance;
    cellH = maxPerColCell * packPitch + 4.0;
  } else {
    cellLen = maxPerColCell * packPitch + endClearance;
    cellH = vertExtent + 4.0; // small margin above the product's vertical extent
  }

  return { nCells: finalNCells, cellLen, cellWid, cradleR, cellH, cookiesPerCell: finalCookiesPerCell };
}

/**
 * Full product spec -> a fully-populated TrayParams (via makeTrayParams),
 * for programmatic/complete use. Requires `cellH` explicitly (independent
 * of cookie size) plus any tray-shaping inputs not derived from product
 * dims — everything else falls back to TrayParams' own defaults.
 */
export function deriveParamsFromProduct(spec) {
  const suggestion = suggestFromProduct(spec);
  const {
    cellH, // explicit trough depth (mm); independent of cookie size, required
    longAxis = "X",
    wall = 3.0,
    divider = null,
    nCols = 1,
    colDivider = null,
    floor = 2.5,
    cornerR = 8.0,
    draftDeg = 5.0,
    stripL = 5.0,
    stripW = 5.0,
    lipH = 3.0,
    flangeT = 2.5,
    cellFillet = 2.0,
    nozzle = 0.42,
  } = spec;

  if (!(cellH > 0)) {
    throw new Error(`cellH must be > 0, got ${cellH}`);
  }

  const rawParams = {
    nCells: suggestion.nCells,
    longAxis,
    cellLen: suggestion.cellLen,
    cellWid: suggestion.cellWid,
    cellH,
    cradleR: suggestion.cradleR,
    wall,
    divider,
    nCols,
    colDivider,
    floor,
    cornerR,
    draftDeg,
    stripL,
    stripW,
    lipH,
    flangeT,
    cellFillet,
    nozzle,
  };

  // Round-trip requirement (§5): must pass every §3 guard before building.
  const result = makeTrayParams(rawParams);
  return {
    ...result,
    meta: { cookiesPerCell: suggestion.cookiesPerCell, nCells: suggestion.nCells },
  };
}
