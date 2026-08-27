/**
 * Params-in-URL serialization -- the enabler for the phone/AR handoff (no
 * backend, no file transfer: the whole tray+product configuration lives in
 * the querystring, so opening the same URL on another device reconstructs
 * an identical build locally).
 *
 * Pure encode/decode only. Never validates or clamps -- decoded values are
 * fed into the SAME `makeTrayParams`/`suggestFromProduct` pipeline regular
 * form input goes through, so guards apply exactly as normal (a bad URL
 * value blocks or clamps exactly like a bad typed value would).
 */

import { DEFAULTS as TRAY_DEFAULTS } from "./params.js";

// HTML value attributes in index.html are this module's source of truth for
// "what the product form defaults to" (there's no shared DEFAULTS export
// for the product form the way params.js has one for the tray).
export const PRODUCT_DEFAULTS = Object.freeze({
  productType: "round",
  packMode: "standing",
  cookieDiameter: 45,
  cookieThickness: 12,
  productWidth: 45,
  productHeight: 20,
  productThickness: 12,
  edgeRTop: 2,
  edgeRBot: 2,
  qtyTotal: 24,
  distributeBy: "nCells",
  nCellsProduct: 3,
  cookiesPerCell: 8,
});

// long form-field name -> compact querystring key.
const TRAY_KEY_MAP = {
  nCells: "n",
  longAxis: "la",
  cellLen: "cl",
  cellWid: "cw",
  cellH: "ch",
  cradleR: "cr",
  wall: "w",
  divider: "dv",
  nCols: "nc",
  colDivider: "cdv",
  floor: "fl",
  cornerR: "cnr",
  draftDeg: "dr",
  stripL: "sl",
  stripW: "sw",
  lipH: "lh",
  flangeT: "ft",
  cellFillet: "cf",
  nozzle: "nz",
};

const PRODUCT_KEY_MAP = {
  productType: "pty",
  packMode: "pkm",
  cookieDiameter: "pdia",
  cookieThickness: "pthk",
  productWidth: "pw",
  productHeight: "ph",
  productThickness: "ptk",
  edgeRTop: "ert",
  edgeRBot: "erb",
  qtyTotal: "qty",
  distributeBy: "dby",
  nCellsProduct: "ncp",
  cookiesPerCell: "cpc",
};

const STRING_FIELDS = new Set(["longAxis", "productType", "distributeBy", "packMode"]);

/** Trims to at most 4 decimals without forcing trailing zeros (12.7000 -> "12.7"). */
function fmtNum(n) {
  return Number(n.toFixed(4)).toString();
}

function encodeGroup(input, keyMap, defaults, out) {
  for (const [longKey, shortKey] of Object.entries(keyMap)) {
    const v = input[longKey];
    if (v === null || v === undefined || v === "") continue; // blank/auto -- same as unset, omit
    const d = defaults[longKey];
    if (STRING_FIELDS.has(longKey)) {
      if (v === d) continue;
      out.set(shortKey, v);
    } else {
      const num = typeof v === "number" ? v : parseFloat(v);
      if (!Number.isFinite(num)) continue;
      if (typeof d === "number" && Math.abs(num - d) < 1e-9) continue;
      out.set(shortKey, fmtNum(num));
    }
  }
}

/**
 * @param {object} args
 * @param {object} args.trayInput - raw tray form snapshot (formToObject(trayForm) shape)
 * @param {object} args.productInput - raw product form snapshot (formToObject(productForm) shape)
 * @returns {URLSearchParams}
 */
export function encodeStateToParams({ trayInput, productInput }) {
  const out = new URLSearchParams();
  encodeGroup(trayInput, TRAY_KEY_MAP, TRAY_DEFAULTS, out);
  encodeGroup(productInput, PRODUCT_KEY_MAP, PRODUCT_DEFAULTS, out);
  return out;
}

/**
 * @param {URLSearchParams} searchParams
 * @returns {{trayInput: object, productInput: object, hasAny: boolean}}
 */
export function decodeStateFromParams(searchParams) {
  const trayInput = {};
  const productInput = {};
  let hasAny = false;

  for (const [longKey, shortKey] of Object.entries(TRAY_KEY_MAP)) {
    if (!searchParams.has(shortKey)) continue;
    hasAny = true;
    const raw = searchParams.get(shortKey);
    trayInput[longKey] = STRING_FIELDS.has(longKey) ? raw : parseFloat(raw);
  }
  for (const [longKey, shortKey] of Object.entries(PRODUCT_KEY_MAP)) {
    if (!searchParams.has(shortKey)) continue;
    hasAny = true;
    const raw = searchParams.get(shortKey);
    productInput[longKey] = STRING_FIELDS.has(longKey) ? raw : parseFloat(raw);
  }

  return { trayInput, productInput, hasAny };
}
