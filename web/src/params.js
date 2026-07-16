/**
 * Parameter model — JS port of cookie_tray/params.py (§3).
 *
 * Mirrors the Python TrayParams: inputs + derived (read-only, computed) +
 * validation guards. `makeTrayParams` is the single source of truth both the
 * "Direct" and "From product" UI modes funnel into before calling buildTray.
 */

export const DEFAULTS = Object.freeze({
  nCells: 3,
  longAxis: "X", // "X" (length-wise channels) or "Y"
  cellLen: 170.0,
  cellWid: 48.0,
  cellH: 28.0,
  cradleR: null, // defaults to cellWid / 2
  wall: 3.0,
  floor: 2.5,
  cornerR: 8.0,
  draftDeg: 5.0,
  stripW: 5.0,
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

  const errors = [];
  const warnings = [];

  if (!(p.nCells >= 1)) {
    errors.push(`n_cells must be >= 1, got ${p.nCells}`);
  }
  if (p.longAxis !== "X" && p.longAxis !== "Y") {
    errors.push(`long_axis must be "X" or "Y", got ${JSON.stringify(p.longAxis)}`);
  }

  // Guard 1: cradle_r = min(cradle_r, cell_wid/2), warn if clamped.
  const maxCradleR = p.cellWid / 2;
  if (p.cradleR > maxCradleR) {
    warnings.push(`cradle_r=${p.cradleR} exceeds cell_wid/2=${maxCradleR}; clamping.`);
    p.cradleR = maxCradleR;
  }
  if (!(p.cradleR > 0)) {
    errors.push(`cradle_r must be > 0, got ${p.cradleR}`);
  }

  // Guard 2: cell_h >= cradle_r, otherwise the rounded bottom can't complete.
  if (p.cellH < p.cradleR) {
    errors.push(
      `cell_h (${p.cellH}) must be >= cradle_r (${p.cradleR.toFixed(3)}); the rounded bottom cannot complete otherwise.`
    );
  }

  // Derived values (§3 "Derived") — computed after cradle_r is resolved.
  const lipT = 3 * p.nozzle;
  const topL = p.cellLen + 2 * p.wall;
  const topW = p.nCells * p.cellWid + (p.nCells + 1) * p.wall;
  const H = p.floor + p.cellH;
  const draftRad = (p.draftDeg * Math.PI) / 180;
  // Bounded base taper offset: never exceeds wall - 0.5mm, regardless of
  // cell height. An unbounded H*tan(draftDeg) would inset the base past
  // the wall thickness on tall cells, undercutting them — geometry.js lofts
  // only up to draftH and goes vertical above that instead of tapering the
  // full height H (see buildTray).
  const dUnbounded = p.draftDeg > 0 ? H * Math.tan(draftRad) : 0;
  const draftOffset = Math.max(0, Math.min(dUnbounded, p.wall - 0.5));
  // Height at which the base taper completes and walls go vertical.
  const draftH = p.draftDeg > 0 && draftOffset > 0 ? draftOffset / Math.tan(draftRad) : 0;
  const bottomL = topL - 2 * draftOffset;
  const bottomW = topW - 2 * draftOffset;
  const bottomCornerR = p.cornerR - draftOffset;
  const outerL = topL + 2 * p.stripW;
  const outerW = topW + 2 * p.stripW;
  const outerR = p.cornerR + p.stripW;
  const overallH = H + p.lipH;
  const footprint = outerL * outerW;

  // Guard 3: corner_r > base_offset (the bounded taper offset), else
  // bottom_corner_r goes non-positive. Cell height is unrestricted since
  // draftOffset is capped regardless of how tall the cell is.
  if (p.cornerR <= draftOffset) {
    errors.push(
      `corner_r (${p.cornerR}) must exceed the base taper offset (${draftOffset.toFixed(3)}); otherwise bottom_corner_r is non-positive.`
    );
  }

  // Guard 4: strip_w > lip_t, else the lip consumes the whole strip.
  if (p.stripW <= lipT) {
    errors.push(
      `strip_w (${p.stripW}) must exceed lip_t (${lipT.toFixed(3)}); otherwise the lip consumes the whole flange strip.`
    );
  }

  // Guard 5: cell_wid > 2*cell_fillet and cell_len > 2*cell_fillet.
  if (p.cellWid <= 2 * p.cellFillet) {
    errors.push(`cell_wid (${p.cellWid}) must exceed 2*cell_fillet (${2 * p.cellFillet})`);
  }
  if (p.cellLen <= 2 * p.cellFillet) {
    errors.push(`cell_len (${p.cellLen}) must exceed 2*cell_fillet (${2 * p.cellFillet})`);
  }

  if (!(p.wall > 0) || !(p.floor > 0)) {
    errors.push("wall and floor must be > 0");
  }

  const derived = {
    lipT,
    topL,
    topW,
    H,
    draftOffset,
    draftH,
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
