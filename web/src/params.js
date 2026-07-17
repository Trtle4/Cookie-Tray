/**
 * Parameter model — JS port of cookie_tray/params.py (§3).
 *
 * Mirrors the Python TrayParams: inputs + derived (read-only, computed) +
 * validation guards. `makeTrayParams` is the single source of truth the UI
 * funnels tray-form input into before calling buildTray.
 */

export const MIN_WALL = 0.8; // outer-wall floor: draft angle is reduced to respect this
export const MIN_DIVIDER = 0.8; // internal-divider floor

export const DEFAULTS = Object.freeze({
  nCells: 3,
  longAxis: "X", // "X" (length-wise channels) or "Y"
  cellLen: 170.0,
  cellWid: 48.0,
  cellH: 28.0,
  cradleR: null, // defaults to cellWid / 2
  wall: 3.0, // outer-wall thickness
  divider: null, // internal cell-to-cell wall thickness; defaults to wall
  floor: 2.5,
  cornerR: 8.0,
  draftDeg: 5.0,
  stripL: 5.0, // flange strip width on the +/-X (long-axis) sides
  stripW: 5.0, // flange strip width on the +/-Y (width-axis) sides
  lipH: 3.0,
  flangeT: 2.5,
  cellFillet: 2.0,
  nozzle: 0.42,
});

const INPUT_KEYS = Object.keys(DEFAULTS);

/**
 * Validates inputs and computes derived values (§3 "Derived").
 * Never throws — returns { params, errors, warnings, valid } so the UI can
 * show inline messages instead of attempting to build an invalid solid.
 */
export function makeTrayParams(rawInput = {}) {
  const p = { ...DEFAULTS, ...rawInput };
  if (p.cradleR === null || p.cradleR === undefined) {
    p.cradleR = p.cellWid / 2;
  }
  if (p.divider === null || p.divider === undefined) {
    p.divider = p.wall;
  }

  const errors = [];
  const warnings = [];

  if (!(p.nCells >= 1)) {
    errors.push({ field: "nCells", message: `n_cells must be >= 1, got ${p.nCells}` });
  }
  if (p.longAxis !== "X" && p.longAxis !== "Y") {
    errors.push({ field: "longAxis", message: `long_axis must be "X" or "Y", got ${JSON.stringify(p.longAxis)}` });
  }

  // Guard 1: cradle_r = min(cradle_r, cell_wid/2), warn if clamped.
  const maxCradleR = p.cellWid / 2;
  if (p.cradleR > maxCradleR) {
    warnings.push(`cradle_r=${p.cradleR} exceeds cell_wid/2=${maxCradleR}; clamping.`);
    p.cradleR = maxCradleR;
  }
  if (!(p.cradleR > 0)) {
    errors.push({ field: "cradleR", message: `cradle_r must be > 0, got ${p.cradleR}` });
  }

  // Guard 2: cell_h >= cradle_r, otherwise the rounded bottom can't complete.
  if (p.cellH < p.cradleR) {
    errors.push({
      field: ["cellH", "cradleR"],
      message: `cell_h (${p.cellH}) must be >= cradle_r (${p.cradleR.toFixed(3)}); the rounded bottom cannot complete otherwise. Increase cell_h or decrease cradle_r.`,
    });
  }

  // Wall floor: draft angle is reduced to fit thin walls (see draftOffset
  // below), but the wall itself has a hard minimum.
  if (p.wall < MIN_WALL) {
    errors.push({ field: "wall", message: `wall (${p.wall}) must be >= ${MIN_WALL}mm` });
  }
  if (!(p.floor > 0)) {
    errors.push({ field: "floor", message: "floor must be > 0" });
  }

  // Negative draft has no physical meaning; clamp to 0 (no draft) and warn,
  // mirroring the cradle_r over-max clamp above -- never reject, since "no
  // draft" is always a valid fallback.
  if (p.draftDeg < 0) {
    warnings.push("draft_deg is negative; clamped to 0 (no draft).");
    p.draftDeg = 0;
  }

  // Derived values (§3 "Derived") — computed after cradle_r/divider are resolved.
  const lipT = 3 * p.nozzle;
  const topL = p.cellLen + 2 * p.wall;
  // Outer walls (both sides) are `wall`; the nCells-1 internal dividers
  // between cells are `divider`.
  const topW = p.nCells * p.cellWid + 2 * p.wall + (p.nCells - 1) * p.divider;
  const pitch = p.cellWid + p.divider; // cell center-to-center spacing
  const H = p.floor + p.cellH;
  const draftRad = (p.draftDeg * Math.PI) / 180;
  // Base inset applied by a SINGLE continuous draft over the full height H,
  // limited so the base never insets past wall - MIN_WALL. When the wall is
  // thin relative to cell height, the draft *angle* itself shrinks
  // (effectiveDraftDeg) rather than tapering steeply for part of the height
  // and going vertical for the rest, which used to leave a visible crease.
  const maxInset = Math.max(0, p.wall - MIN_WALL);
  const fullInset = p.draftDeg > 0 ? H * Math.tan(draftRad) : 0;
  const draftOffset = Math.min(fullInset, maxInset);
  const effectiveDraftDeg = draftOffset > 0 ? (Math.atan(draftOffset / H) * 180) / Math.PI : 0;
  const bottomL = topL - 2 * draftOffset;
  const bottomW = topW - 2 * draftOffset;
  const bottomCornerR = p.cornerR - draftOffset;
  const outerL = topL + 2 * p.stripL;
  const outerW = topW + 2 * p.stripW;
  // min() keeps the corner blend clean when the two strip widths differ.
  const outerR = p.cornerR + Math.min(p.stripL, p.stripW);
  const overallH = H + p.lipH;
  const footprint = outerL * outerW;

  // Non-blocking note: draft angle was reduced from draftDeg to keep the
  // base inset within the wall's clearance.
  if (fullInset > draftOffset + 1e-9) {
    warnings.push("Draft reduced to fit a thin wall.");
  }

  // Guard 3: corner_r > draft_offset (the wall-limited base inset), else
  // bottom_corner_r goes non-positive. Cell height is unrestricted: the
  // draft is a single continuous taper over the full height, its angle
  // (not just a bounded band) shrinks to respect the wall.
  if (p.cornerR <= draftOffset) {
    errors.push({
      field: "cornerR",
      message: `corner_r (${p.cornerR}) must exceed the draft inset (${draftOffset.toFixed(3)}); otherwise bottom_corner_r is non-positive.`,
    });
  }

  // Guard 4: strip_l > lip_t and strip_w > lip_t, else the lip consumes the
  // whole strip on that axis.
  if (p.stripL <= lipT) {
    errors.push({
      field: "stripL",
      message: `strip_l (${p.stripL}) must exceed lip_t (${lipT.toFixed(3)}); otherwise the lip consumes the whole flange strip.`,
    });
  }
  if (p.stripW <= lipT) {
    errors.push({
      field: "stripW",
      message: `strip_w (${p.stripW}) must exceed lip_t (${lipT.toFixed(3)}); otherwise the lip consumes the whole flange strip.`,
    });
  }

  // Guard 5: cell_fillet is clamped (not rejected) to whatever the cell's
  // own smaller dimension can geometrically support, so the solid always
  // stays valid. This is a purely geometric-validity clamp and is
  // intentionally silent (no warning) -- it's distinct from whether the
  // fillet visually intrudes on a configured PRODUCT, which is surfaced
  // separately as a non-blocking advisory (see `checkFilletProductConflict`
  // in main.js, mirroring the D5 product-fit warning): clamp for geometric
  // validity, advise for product interference, never block the build.
  const maxSafeFillet = Math.max(0, Math.min(p.cellWid, p.cellLen) / 2 - 0.01);
  if (p.cellFillet > maxSafeFillet) {
    p.cellFillet = maxSafeFillet;
  }

  // Guard 6: divider >= MIN_DIVIDER.
  if (p.divider < MIN_DIVIDER) {
    errors.push({ field: "divider", message: `divider (${p.divider}) must be >= ${MIN_DIVIDER}mm` });
  }

  // Guard 7: lip_h and flange_t are extruded thicknesses -- zero or
  // negative has no valid interpretation and previously reached replicad
  // construction directly, surfacing as an opaque low-level error.
  if (!(p.lipH > 0)) {
    errors.push({ field: "lipH", message: `lip_h (${p.lipH}) must be > 0` });
  }
  if (!(p.flangeT > 0)) {
    errors.push({ field: "flangeT", message: `flange_t (${p.flangeT}) must be > 0` });
  }

  // Guard 8: nozzle and cell_fillet are physical/geometric dimensions with
  // no valid negative interpretation (a negative nozzle width inverts the
  // lip's inner-cut sizing; a negative fillet has no meaning). Zero remains
  // valid for both (cell_fillet=0 means "no fillet", a legitimate
  // sharp-corner design choice).
  if (p.nozzle < 0) {
    errors.push({ field: "nozzle", message: `nozzle (${p.nozzle}) must be >= 0` });
  }
  if (p.cellFillet < 0) {
    errors.push({ field: "cellFillet", message: `cell_fillet (${p.cellFillet}) must be >= 0` });
  }

  const derived = {
    lipT,
    topL,
    topW,
    pitch,
    H,
    draftOffset,
    effectiveDraftDeg,
    bottomL,
    bottomW,
    bottomCornerR,
    outerL,
    outerW,
    outerR,
    overallH,
    footprint,
  };

  return { params: p, derived, errors, warnings, valid: errors.length === 0 };
}

/** Strips any non-§3-input keys (e.g. calculator metadata) before building. */
export function inputOnly(params) {
  const out = {};
  for (const k of INPUT_KEYS) out[k] = params[k];
  return out;
}
