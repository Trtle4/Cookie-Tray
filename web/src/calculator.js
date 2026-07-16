/**
 * Inverse calculator — JS port of cookie_tray/calculator.py (§5).
 * Product dimensions -> tray-shaping suggestions. Layouts are 1xN, so there
 * is no 2D row x col factoring — just distribute a cookie count along one
 * axis.
 */

import { makeTrayParams } from "./params.js";

/**
 * The core product -> tray-shape math (cellWid/cellLen/cradleR/nCells),
 * without requiring or producing a full TrayParams. Used both as a
 * lightweight suggestion source for the always-visible tray form (main.js
 * fills in cellWid/cellLen/cradleR/nCells from this unless the user has
 * edited those fields themselves) and as the basis for the full round-trip
 * in `deriveParamsFromProduct`.
 */
export function suggestFromProduct(spec) {
  const {
    productType = "round",
    cookieDiameter,
    cookieThickness,
    productWidth,
    productHeight,
    productThickness,
    qtyTotal,
    nCells = null,
    cookiesPerCell = null,
    sideClearance = 1.5,
    endClearance = 3.0,
    cradleClearance = 0.0,
  } = spec;

  if ((nCells === null) === (cookiesPerCell === null)) {
    throw new Error("Supply exactly one of nCells or cookiesPerCell, not both/neither.");
  }
  if (!(qtyTotal >= 1)) {
    throw new Error(`qtyTotal must be >= 1, got ${qtyTotal}`);
  }

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
  // Rectangular products have no natural "radius" to hug; suggest a modest
  // fixed rounded-bottom radius instead of cellWid/2.
  let cradleR = productType === "rectangle" ? 5.0 - cradleClearance : cellWid / 2 - cradleClearance;
  cradleR = Math.min(Math.max(cradleR, 0.5), maxCradleR);

  let finalNCells, finalCookiesPerCell;
  if (cookiesPerCell !== null) {
    finalCookiesPerCell = cookiesPerCell;
    finalNCells = Math.ceil(qtyTotal / cookiesPerCell);
  } else {
    finalNCells = nCells;
    finalCookiesPerCell = Math.ceil(qtyTotal / nCells);
  }

  const cellLen = finalCookiesPerCell * packPitch + endClearance;
  const cellH = vertExtent + 4.0; // small margin above the product's vertical extent

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
