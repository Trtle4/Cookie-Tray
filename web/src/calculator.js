/**
 * Inverse calculator — JS port of cookie_tray/calculator.py (§5).
 * Product dimensions -> the same TrayParams shape the "Direct" mode produces.
 * Layouts are 1xN, so there is no 2D row x col factoring — just distribute a
 * cookie count along one axis.
 */

import { makeTrayParams } from "./params.js";

export function deriveParamsFromProduct(spec) {
  const {
    cookieDiameter,
    cookieThickness,
    qtyTotal,
    nCells = null,
    cookiesPerCell = null,
    sideClearance = 1.5,
    endClearance = 3.0,
    cradleClearance = 0.0,
    cellH, // explicit trough depth (mm); independent of cookie size, required
    longAxis = "X",
    wall = 3.0,
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

  if ((nCells === null) === (cookiesPerCell === null)) {
    throw new Error("Supply exactly one of nCells or cookiesPerCell, not both/neither.");
  }
  if (!(qtyTotal >= 1)) {
    throw new Error(`qtyTotal must be >= 1, got ${qtyTotal}`);
  }
  if (!(cookieDiameter > 0) || !(cookieThickness > 0)) {
    throw new Error("cookieDiameter and cookieThickness must be > 0");
  }
  if (!(cellH > 0)) {
    throw new Error(`cellH must be > 0, got ${cellH}`);
  }

  const cellWid = cookieDiameter + 2 * sideClearance;

  const maxCradleR = cellWid / 2;
  let cradleR = cellWid / 2 - cradleClearance;
  cradleR = Math.min(Math.max(cradleR, 0.5), maxCradleR);

  let finalNCells, finalCookiesPerCell;
  if (cookiesPerCell !== null) {
    finalCookiesPerCell = cookiesPerCell;
    finalNCells = Math.ceil(qtyTotal / cookiesPerCell);
  } else {
    finalNCells = nCells;
    finalCookiesPerCell = Math.ceil(qtyTotal / nCells);
  }

  const cellLen = finalCookiesPerCell * cookieThickness + endClearance;

  const rawParams = {
    nCells: finalNCells,
    longAxis,
    cellLen,
    cellWid,
    cellH,
    cradleR,
    wall,
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
    meta: { cookiesPerCell: finalCookiesPerCell, nCells: finalNCells },
  };
}
