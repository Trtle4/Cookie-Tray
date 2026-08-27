import { wrap } from "comlink";

import { makeTrayParams, inputOnly } from "./params.js";
import { suggestFromProduct } from "./calculator.js";
import { Viewer } from "./viewer.js";
import { buildFillGroup } from "./fill.js";
import { encodeStateToParams, decodeStateFromParams } from "./urlState.js";
import { exportTrayGLB, exportProductGLB, exportTrayUSDZ, exportProductUSDZ } from "./arExport.js";
import QRCode from "qrcode";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const api = wrap(worker);

const els = {
  trayForm: document.getElementById("tray-form"),
  productForm: document.getElementById("product-form"),
  messages: document.getElementById("messages"),
  status: document.getElementById("status-overlay"),
  downloadStl: document.getElementById("download-stl"),
  downloadStep: document.getElementById("download-step"),
  exportTargetSeg: document.getElementById("export-target-seg"),
  exportTargetProductBtn: document.getElementById("export-target-product-btn"),
  fillToggle: document.getElementById("fill-toggle"),
  fillLabel: document.getElementById("fill-toggle-label"),
  canvas: document.getElementById("three-canvas"),
  distributeBy: document.querySelector('select[name="distributeBy"]'),
  nCellsField: document.getElementById("product-ncells-field"),
  perCellField: document.getElementById("product-percell-field"),
  perCellLabel: document.querySelector('label[for="f-cookiesPerCell"]'),
  perCellSegBtn: document.querySelector('#distribute-by-seg .seg-btn[data-seg-value="cookiesPerCell"]'),
  packMode: document.querySelector('select[name="packMode"]'),
  packModeSeg: document.getElementById("pack-mode-seg"),
  productType: document.querySelector('select[name="productType"]'),
  roundFields: document.getElementById("product-round-fields"),
  rectFields: document.getElementById("product-rect-fields"),
  resetAllBtn: document.getElementById("reset-all-suggestions-btn"),
  cameraButtons: document.querySelectorAll(".cam-btn"),
  sectionToggle: document.getElementById("section-toggle"),
  sectionAxis: document.getElementById("section-axis"),
  sectionSlider: document.getElementById("section-slider"),
  // reskin: header status, segmented toggles, title-block, dimension overlay
  buildStatus: document.getElementById("build-status"),
  buildStatusText: document.getElementById("build-status-text"),
  productTypeSeg: document.getElementById("product-type-seg"),
  distributeBySeg: document.getElementById("distribute-by-seg"),
  longAxisSeg: document.getElementById("long-axis-seg"),
  dimsToggle: document.getElementById("dims-toggle"),
  fitBtn: document.getElementById("fit-btn"),
  dimsOverlay: document.getElementById("dims-overlay"),
  titleblock: document.getElementById("titleblock"),
  tbTitle: document.getElementById("tb-title"),
  tbCells: document.getElementById("tb-cells"),
  tbRows: document.getElementById("tb-rows"),
  viewChip: document.getElementById("view-chip"),
  msTitle: document.getElementById("ms-title"),
  msReady: document.getElementById("ms-ready"),
  msGrid: document.getElementById("ms-grid"),
  // phone/AR handoff
  arShareBtn: document.getElementById("ar-share-btn"),
  arPanelOverlay: document.getElementById("ar-panel-overlay"),
  arPanel: document.getElementById("ar-panel"),
  arPanelClose: document.getElementById("ar-panel-close"),
  arTargetSeg: document.getElementById("ar-target-seg"),
  arTargetProductBtn: document.getElementById("ar-target-product-btn"),
  arModelViewer: document.getElementById("ar-model-viewer"),
  arLaunchBtn: document.getElementById("ar-launch-btn"),
  arViewerStatus: document.getElementById("ar-viewer-status"),
  arFillToggle: document.getElementById("ar-fill-toggle"),
  arDimsToggle: document.getElementById("ar-dims-toggle"),
  arFlatToggle: document.getElementById("ar-flat-toggle"),
  arDimsHotspot: document.getElementById("ar-dims-hotspot"),
  arNote: document.getElementById("ar-note"),
  arQrCanvas: document.getElementById("ar-qr-canvas"),
  arShareLink: document.getElementById("ar-share-link"),
  arCopyLinkBtn: document.getElementById("ar-copy-link-btn"),
};

const viewer = new Viewer(els.canvas);

// ---- Segmented toggles: presentational buttons driving the real (visually
// hidden) <select> each is paired with, so field name/value/validation
// logic is completely untouched -- these just make the existing selects
// look/feel like a segmented control. Dispatches BOTH "input" and "change"
// (real browsers fire "input" before "change" on a <select>), so a click
// arms the exact same live-update pipeline a keystroke does -- productType/
// distributeBy already had their own dedicated "change" listeners, but
// longAxis didn't, and nothing else in trayForm listens for "change"; only
// its generic "input" listener schedules a rebuild. Without the "input"
// dispatch, clicking Length/Width silently updated the field but never
// rebuilt the tray (reproducible with or without URL-loaded params). ----
function wireSegment(container, selectEl) {
  const buttons = container.querySelectorAll(".seg-btn");
  const syncFromSelect = () => {
    for (const b of buttons) b.classList.toggle("on", b.dataset.segValue === selectEl.value);
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      if (selectEl.value === b.dataset.segValue) return;
      selectEl.value = b.dataset.segValue;
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      syncFromSelect();
    });
  }
  selectEl.addEventListener("change", syncFromSelect);
  syncFromSelect();
}

wireSegment(els.productTypeSeg, els.productType);
wireSegment(els.distributeBySeg, els.distributeBy);
wireSegment(els.longAxisSeg, els.trayForm.elements.longAxis);
wireSegment(els.packModeSeg, els.packMode);

// Tray fields the product section can suggest a value for. If the user has
// edited one of these directly, their value wins — the product section
// stops overwriting it until it's explicitly released back to auto (the
// per-field reset-to-auto affordance / "Reset to auto" below), not just on
// reload.
const SUGGESTABLE_FIELDS = ["nCells", "cellLen", "cellWid", "cellH", "cradleR"];
const userTouched = new Set();
let sectionAxisTouched = false;

/** Reflects each suggestable field's manual/auto state onto its .field
 * wrapper (data-manual, toggling the inline reset-to-auto affordance) and
 * enables/disables the bulk "Reset to auto" control -- called any time
 * userTouched changes for a suggestable field. */
function syncSuggestableFieldAffordances() {
  let anyManual = false;
  for (const field of SUGGESTABLE_FIELDS) {
    const manual = userTouched.has(field);
    if (manual) anyManual = true;
    const wrapper = els.trayForm.elements[field]?.closest(".field");
    if (wrapper) wrapper.dataset.manual = manual ? "true" : "false";
  }
  if (els.resetAllBtn) els.resetAllBtn.disabled = !anyManual;
}

/** Release one suggestable field back to auto: stop treating it as
 * user-owned and recompute suggestions. applyProductSuggestions() only
 * ever writes to fields NOT in userTouched, so every other manual override
 * is left completely alone. */
function resetFieldToAuto(field) {
  if (!SUGGESTABLE_FIELDS.includes(field)) return;
  userTouched.delete(field);
  applyProductSuggestions();
  syncSuggestableFieldAffordances();
}

function resetAllToAuto() {
  userTouched.clear();
  applyProductSuggestions();
  syncSuggestableFieldAffordances();
}

for (const btn of document.querySelectorAll(".reset-auto-btn")) {
  btn.addEventListener("click", () => resetFieldToAuto(btn.dataset.field));
}
els.resetAllBtn?.addEventListener("click", resetAllToAuto);

/** On load, if the URL carries a params-in-URL link (see urlState.js),
 * populate the tray/product forms from it BEFORE the first build -- the
 * decoded values just become form field values, so they run through the
 * exact same makeTrayParams/suggestFromProduct validation+guard pipeline
 * regular typed input does. Never a bypass: a bad URL value blocks or
 * clamps exactly like a bad typed value would. This is what makes any
 * configured tray a shareable/bookmarkable link, and what the QR/AR panel
 * piggybacks on (it just encodes the live location.href). */
function applyURLParamsToForm() {
  const { trayInput, productInput, hasAny } = decodeStateFromParams(new URL(location.href).searchParams);
  if (!hasAny) return;

  // Mark any suggestable tray field explicitly present in the URL as
  // user-owned BEFORE the productType/distributeBy "change" dispatches
  // below (which trigger applyProductSuggestions), so the suggestion
  // engine never clobbers a value that came from the shared link.
  for (const key of Object.keys(trayInput)) {
    if (SUGGESTABLE_FIELDS.includes(key)) userTouched.add(key);
  }

  for (const [key, val] of Object.entries(productInput)) {
    const el = els.productForm.elements[key];
    if (el) el.value = val;
  }
  for (const [key, val] of Object.entries(trayInput)) {
    const el = els.trayForm.elements[key];
    if (el) el.value = val;
  }

  // Re-sync the presentational bits a real user interaction would normally
  // drive (segmented "on" state, round/rect + per-cell field visibility),
  // and -- via the productType/distributeBy "change" listeners -- apply
  // suggestions + schedule the first build.
  els.productType.dispatchEvent(new Event("change", { bubbles: true }));
  els.distributeBy.dispatchEvent(new Event("change", { bubbles: true }));
  els.packMode?.dispatchEvent(new Event("change", { bubbles: true }));
  els.trayForm.elements.longAxis.dispatchEvent(new Event("change", { bubbles: true }));
  syncSuggestableFieldAffordances();
}

let lastValidParams = null; // §3 input-shaped params, ready for buildTray
let lastDerived = null; // makeTrayParams(...).derived for lastValidParams -- feeds the title-block + dimension overlay
let lastFillSpec = null; // { cookiesPerCell, cookieDiameter, cookieThickness, endClearance } | null
let debounceTimer = null;
let buildToken = 0;
let hasEverBuilt = false; // true once any build has ever succeeded -- lets a
// later build FAILURE keep exporting that still-valid previous shape
// instead of stranding it behind disabled buttons (worker.js keeps
// currentShape pointed at the last success on failure; see build()).
let buildExportable = false; // mirrors the tray download buttons' enabled condition
let exportTarget = "tray"; // "tray" | "product" -- which solid the format buttons act on

/** Sync the target seg buttons + STL/STEP button disabled state from
 * `buildExportable` (tray build validity, unchanged meaning) and whether a
 * product is currently configured. Falls back to "tray" if the product
 * target becomes unavailable while selected. */
function refreshExportButtons() {
  const productAvailable = !!lastFillSpec;
  if (els.exportTargetProductBtn) els.exportTargetProductBtn.disabled = !productAvailable;
  if (!productAvailable && exportTarget === "product") {
    exportTarget = "tray";
    for (const b of els.exportTargetSeg.querySelectorAll(".seg-btn")) {
      b.classList.toggle("on", b.dataset.segValue === "tray");
    }
  }
  const exportable = exportTarget === "product" ? buildExportable && productAvailable : buildExportable;
  els.downloadStl.disabled = !exportable;
  els.downloadStep.disabled = !exportable;
  if (els.arShareBtn) els.arShareBtn.disabled = !buildExportable;
}

function setExportTarget(target) {
  exportTarget = target;
  for (const b of els.exportTargetSeg.querySelectorAll(".seg-btn")) {
    b.classList.toggle("on", b.dataset.segValue === target);
  }
  refreshExportButtons();
}

for (const btn of els.exportTargetSeg.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    setExportTarget(btn.dataset.segValue);
  });
}

function setStatus(text) {
  els.status.textContent = text;
  els.status.classList.toggle("hidden", !text);
}

function scheduleRebuild() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rebuild, 250);
}

// ---- Product section: distribute-by toggle ----
els.distributeBy.addEventListener("change", () => {
  const byPerCell = els.distributeBy.value === "cookiesPerCell";
  els.nCellsField.style.display = byPerCell ? "none" : "";
  els.perCellField.style.display = byPerCell ? "" : "none";
  applyProductSuggestions();
});

// ---- Product section: round <-> rectangle field group toggle ----
els.productType.addEventListener("change", () => {
  const isRect = els.productType.value === "rectangle";
  els.roundFields.style.display = isRect ? "none" : "";
  els.rectFields.style.display = isRect ? "" : "none";
  applyProductSuggestions();
});

/** "Cookies per cell" is the same distribution field in both pack modes
 * (see calculator.js: it's still the per-pocket count, before/after the
 * nCols split, regardless of orientation) -- only its on-screen wording
 * changes so "stack" mode reads naturally ("per stack" rather than
 * "per cell"). */
function updatePackModeLabels() {
  const stack = els.packMode?.value === "stack";
  if (els.perCellLabel) els.perCellLabel.textContent = stack ? "Products per stack" : "Cookies per cell";
  if (els.perCellSegBtn) els.perCellSegBtn.textContent = stack ? "Per-stack" : "Per-cell";
}

// ---- Product section: standing <-> flat/stacked orientation toggle ----
els.packMode?.addEventListener("change", () => {
  updatePackModeLabels();
  applyProductSuggestions();
});
updatePackModeLabels();

els.productForm.addEventListener("input", applyProductSuggestions);

// ---- Tray section: mark suggestable fields as user-owned once edited ----
els.trayForm.addEventListener("input", (event) => {
  const name = event.target.name;
  if (SUGGESTABLE_FIELDS.includes(name)) {
    userTouched.add(name);
    event.target.classList.remove("suggested");
    syncSuggestableFieldAffordances();
  }
  if (name === "pitch") {
    applyPitchEdit();
  }
  if (name === "divider" || name === "cellWid") {
    refreshPitchDisplay();
  }
  if (name === "nCols") {
    // cellLen's SUGGESTED value depends on nCols (busiest column's count) --
    // re-run suggestions so an un-touched cellLen picks up the new split.
    // No-op if cellLen was already manually overridden.
    applyProductSuggestions();
  }
  scheduleRebuild();
});

els.fillToggle.addEventListener("change", updateFillOverlay);

// ---- Camera view buttons ----
const VIEW_LABELS = { iso: "Iso", top: "Top", bottom: "Bottom", front: "Front", side: "Side" };
let currentView = "iso";

function setActiveView(view) {
  currentView = view;
  for (const btn of els.cameraButtons) btn.classList.toggle("on", btn.dataset.view === view);
  if (els.viewChip) els.viewChip.textContent = `${VIEW_LABELS[view] || view} view · mm`;
}

for (const btn of els.cameraButtons) {
  btn.addEventListener("click", () => {
    viewer.setCameraView(btn.dataset.view);
    setActiveView(btn.dataset.view);
  });
}
setActiveView(currentView);

els.fitBtn?.addEventListener("click", () => viewer.setCameraView(currentView));

// ---- Dimension-callout overlay toggle ----
els.dimsToggle?.addEventListener("change", () => {
  els.dimsOverlay.classList.toggle("hidden", !els.dimsToggle.checked);
});
els.dimsOverlay?.classList.toggle("hidden", !els.dimsToggle?.checked);

// ---- Cross-section controls ----
function updateSectionPlane() {
  viewer.setSectionPlane(els.sectionAxis.value, parseFloat(els.sectionSlider.value));
}

els.sectionToggle.addEventListener("change", () => {
  const enabled = els.sectionToggle.checked;
  viewer.setSectionEnabled(enabled);
  els.sectionAxis.disabled = !enabled;
  els.sectionSlider.disabled = !enabled;
  if (enabled) updateSectionPlane();
});

els.sectionAxis.addEventListener("change", () => {
  sectionAxisTouched = true;
  updateSectionPlane();
});

els.sectionSlider.addEventListener("input", updateSectionPlane);

function formToObject(form) {
  const data = new FormData(form);
  const out = {};
  for (const [key, value] of data.entries()) {
    const input = form.elements[key];
    if (input && input.type === "number") {
      out[key] = value === "" ? null : parseFloat(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readTrayInput() {
  const raw = formToObject(els.trayForm);
  return {
    nCells: raw.nCells,
    longAxis: raw.longAxis,
    cellLen: raw.cellLen,
    cellWid: raw.cellWid,
    cellH: raw.cellH,
    cradleR: raw.cradleR,
    wall: raw.wall,
    divider: raw.divider,
    nCols: raw.nCols,
    colDivider: raw.colDivider,
    floor: raw.floor,
    cornerR: raw.cornerR,
    draftDeg: raw.draftDeg,
    stripL: raw.stripL,
    stripW: raw.stripW,
    lipH: raw.lipH,
    flangeT: raw.flangeT,
    cellFillet: raw.cellFillet,
    nozzle: raw.nozzle,
  };
}

function readProductInput() {
  const raw = formToObject(els.productForm);
  const byPerCell = els.distributeBy.value === "cookiesPerCell";
  return {
    productType: raw.productType,
    packMode: raw.packMode,
    cookieDiameter: raw.cookieDiameter,
    cookieThickness: raw.cookieThickness,
    productWidth: raw.productWidth,
    productHeight: raw.productHeight,
    productThickness: raw.productThickness,
    edgeRTop: raw.edgeRTop,
    edgeRBot: raw.edgeRBot,
    qtyTotal: raw.qtyTotal,
    nCells: byPerCell ? null : raw.nCellsProduct,
    cookiesPerCell: byPerCell ? raw.cookiesPerCell : null,
  };
}

// ---- Divider <-> pitch (two views of the same value) ----
function currentCellWid() {
  const v = parseFloat(els.trayForm.elements.cellWid.value);
  return Number.isFinite(v) ? v : 0;
}

function currentDivider() {
  const raw = els.trayForm.elements.divider.value;
  if (raw !== "") return parseFloat(raw);
  const wallRaw = els.trayForm.elements.wall.value;
  return wallRaw !== "" ? parseFloat(wallRaw) : 0;
}

/** Columns (nCols) is a plain, directly user-set tray field -- not
 * calculator-suggested -- but the calculator still needs its CURRENT value
 * to size the suggested cellLen for the busiest column (see
 * applyProductSuggestions/checkProductFit). */
function currentNCols() {
  const raw = els.trayForm.elements.nCols.value;
  const n = raw !== "" ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** User typed into the pitch field: back-derive divider = pitch - cellWid. */
function applyPitchEdit() {
  const pitchRaw = els.trayForm.elements.pitch.value;
  if (pitchRaw === "") return;
  const pitch = parseFloat(pitchRaw);
  if (!Number.isFinite(pitch)) return;
  const divider = pitch - currentCellWid();
  els.trayForm.elements.divider.value = divider.toFixed(2);
  userTouched.add("divider");
}

/** Refresh the pitch field to reflect cellWid + divider, unless the user is
 * actively typing into it (don't fight their keystrokes). */
function refreshPitchDisplay() {
  if (document.activeElement === els.trayForm.elements.pitch) return;
  els.trayForm.elements.pitch.value = (currentCellWid() + currentDivider()).toFixed(2);
}

// ---- Product section drives suggestions into the tray form ----
function applyProductSuggestions() {
  let suggestion;
  try {
    suggestion = suggestFromProduct({ ...readProductInput(), nCols: currentNCols() });
  } catch {
    suggestion = null; // invalid product input -- leave tray fields alone
  }

  const productInput = readProductInput();
  if (suggestion) {
    const suggestedValues = {
      nCells: String(suggestion.nCells),
      cellLen: suggestion.cellLen.toFixed(1),
      cellWid: suggestion.cellWid.toFixed(1),
      cellH: suggestion.cellH.toFixed(1),
      cradleR: suggestion.cradleR.toFixed(1),
    };
    for (const field of SUGGESTABLE_FIELDS) {
      if (userTouched.has(field)) continue;
      const el = els.trayForm.elements[field];
      el.value = suggestedValues[field];
      el.classList.add("suggested");
    }
    lastFillSpec = {
      productType: productInput.productType,
      packMode: productInput.packMode,
      cookiesPerCell: suggestion.cookiesPerCell,
      cookieDiameter: productInput.cookieDiameter,
      cookieThickness: productInput.cookieThickness,
      productWidth: productInput.productWidth,
      productHeight: productInput.productHeight,
      productThickness: productInput.productThickness,
      edgeRTop: productInput.edgeRTop,
      edgeRBot: productInput.edgeRBot,
      endClearance: 3.0,
      qtyTotal: productInput.qtyTotal,
    };
  } else {
    lastFillSpec = null;
  }

  refreshPitchDisplay();
  scheduleRebuild();
}

function renderMessages(errors, warnings) {
  els.messages.innerHTML = "";
  for (const e of errors) {
    const div = document.createElement("div");
    div.className = "msg error";
    div.textContent = typeof e === "string" ? e : e.message;
    els.messages.appendChild(div);
  }
  for (const w of warnings) {
    const div = document.createElement("div");
    div.className = "msg warning";
    div.textContent = w;
    els.messages.appendChild(div);
  }
}

/** Flag the specific tray-form field(s) named by each structured error with
 * a red border, instead of leaving the user to cross-reference the
 * aggregate message list against every field by hand. */
function markInvalidFields(errors) {
  for (const el of els.trayForm.elements) {
    el.classList?.remove("invalid");
  }
  for (const e of errors) {
    if (typeof e !== "object" || !e.field) continue;
    const fields = Array.isArray(e.field) ? e.field : [e.field];
    for (const name of fields) {
      const el = els.trayForm.elements[name];
      if (el) el.classList.add("invalid");
    }
  }
}

/** Cross-check the configured product (if any) against the built tray's
 * cell dimensions and return non-blocking warning strings when it doesn't
 * fit -- independent of whether the product-fill overlay is toggled on, so
 * a mismatch is never silent. Pure/local: does not touch TrayParams. */
function checkProductFit(params, fillSpec) {
  if (!fillSpec) return [];
  const isRect = fillSpec.productType === "rectangle";
  const isStack = fillSpec.packMode === "stack";
  const crossWidth = isRect ? fillSpec.productWidth : fillSpec.cookieDiameter;
  const vertExtent = isRect ? fillSpec.productHeight : fillSpec.cookieDiameter;
  const packPitch = isRect ? fillSpec.productThickness : fillSpec.cookieThickness;
  if (!(crossWidth > 0) || !(vertExtent > 0) || !(packPitch > 0)) return [];

  // Matches calculator.js's suggestFromProduct: every pocket (after the
  // nCols split) gets the same count, whichever pack mode is active --
  // only which physical dimension that count drives differs below.
  const maxPerColCell = Math.ceil(fillSpec.cookiesPerCell / (params.nCols || 1));

  const warnings = [];
  if (crossWidth > params.cellWid) {
    warnings.push(
      `Product width (${crossWidth}mm) exceeds cell width (${params.cellWid}mm) by ${(crossWidth - params.cellWid).toFixed(1)}mm.`
    );
  }

  if (isStack) {
    // Flat/stacked: cellLen is footprint-based (not count-scaled), cellH
    // carries the stack height instead.
    const neededLen = vertExtent + fillSpec.endClearance;
    if (neededLen > params.cellLen) {
      warnings.push(
        `Product footprint (${neededLen.toFixed(1)}mm) exceeds cell length (${params.cellLen}mm) by ${(neededLen - params.cellLen).toFixed(1)}mm.`
      );
    }
    const neededHeight = maxPerColCell * packPitch + 4.0;
    if (neededHeight > params.cellH) {
      warnings.push(
        `Stacked product height (${neededHeight.toFixed(1)}mm) exceeds cell height (${params.cellH}mm) by ${(neededHeight - params.cellH).toFixed(1)}mm.`
      );
    }
  } else {
    if (vertExtent > params.cellH) {
      warnings.push(
        `Product height (${vertExtent}mm) exceeds cell height (${params.cellH}mm) by ${(vertExtent - params.cellH).toFixed(1)}mm.`
      );
    }
    const neededLen = maxPerColCell * packPitch + fillSpec.endClearance;
    if (neededLen > params.cellLen) {
      warnings.push(
        `Packed product length (${neededLen.toFixed(1)}mm) exceeds cell length (${params.cellLen}mm) by ${(neededLen - params.cellLen).toFixed(1)}mm.`
      );
    }
  }
  return warnings;
}

/** Non-blocking advisory: a cell_fillet large enough to eat most of the
 * product's own side clearance can visually intrude on the product near
 * the cell's rounded corners (the fillet rounds the trough's full-height
 * plan-view corners, and the first/last product in a row sits closest to
 * them). This is separate from geometric validity -- cell_fillet itself is
 * always silently clamped to a safe max in params.py/js so the SOLID stays
 * valid; this only flags when the (still-valid) fillet the user chose may
 * visually eat into the product they've configured. Pure/local: does not
 * touch TrayParams. */
function checkFilletProductConflict(params, fillSpec) {
  if (!fillSpec || !(params.cellFillet > 0)) return [];
  const isRect = fillSpec.productType === "rectangle";
  const crossWidth = isRect ? fillSpec.productWidth : fillSpec.cookieDiameter;
  if (!(crossWidth > 0)) return [];

  const sideClearance = (params.cellWid - crossWidth) / 2;
  if (sideClearance < params.cellFillet) {
    return [
      `Cell fillet (${params.cellFillet.toFixed(1)}mm) may intrude on the product near the cell corners ` +
        `(only ${sideClearance.toFixed(1)}mm of side clearance). Consider a smaller cell_fillet or a wider cell.`,
    ];
  }
  return [];
}

/** Dim the 3D view when the displayed shape no longer corresponds to the
 * current form input (guards reject it, or the last build attempt threw). */
function setViewportStale(stale) {
  els.canvas.classList.toggle("stale", stale);
}

/** A short human-readable description of the configured product, for the
 * title-block's "Product" row. */
function productSummaryText(fillSpec) {
  if (!fillSpec) return "—";
  const qty = fillSpec.qtyTotal != null && Number.isFinite(fillSpec.qtyTotal) ? ` · ${fillSpec.qtyTotal} pcs` : "";
  if (fillSpec.productType === "rectangle") {
    return `${fillSpec.productWidth}×${fillSpec.productHeight}mm rect${qty}`;
  }
  return `⌀${fillSpec.cookieDiameter}mm round${qty}`;
}

/** Engineering title-block: the derived readouts (footprint, overall H,
 * product, cradle R, nozzle), rendered both as the floating desktop corner
 * panel and the static mobile spec panel below the viewport -- same data,
 * same source of truth, CSS decides which is visible at which width. */
function renderTitleblock(derived, params) {
  if (!derived || !params) {
    els.tbRows.innerHTML = "";
    els.msGrid.innerHTML = "";
    els.tbCells.textContent = "";
    els.msTitle.textContent = "Cookie Tray";
    return;
  }

  // "3-CELL" for a single-column tray (unchanged); "3x2-CELL" (6 total)
  // once columns split each row into more than one cell.
  const cellCountLabel = params.nCols > 1 ? `${params.nCells}x${params.nCols}` : `${params.nCells}`;
  els.tbCells.textContent = `${cellCountLabel}-CELL`;
  els.msTitle.textContent = `Cookie Tray · ${cellCountLabel}-cell`;

  const rows = [
    ["Footprint", `${derived.outerL.toFixed(1)} × ${derived.outerW.toFixed(1)} mm`, true],
    ["Overall H", `${derived.overallH.toFixed(1)} mm`, false],
    ["Product", productSummaryText(lastFillSpec), false],
    ["Cradle R", `${params.cradleR.toFixed(1)} mm`, false],
    ["Nozzle", `${params.nozzle} mm`, false],
  ];

  els.tbRows.innerHTML = rows
    .map(([k, v, bold]) => `<div class="tbrow"><div class="k">${k}</div><div class="v">${bold ? `<b>${v}</b>` : v}</div></div>`)
    .join("");
  els.msGrid.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
}

/** Header + mobile "ready to export" indicator. */
function setBuildStatus(state, text) {
  els.buildStatus.classList.toggle("building", state === "building");
  els.buildStatus.classList.toggle("error", state === "error");
  els.buildStatusText.textContent = text;
  if (els.msReady) {
    els.msReady.textContent = text;
    els.msReady.classList.toggle("error", state === "error");
  }
}

function filenameFor(params, ext) {
  return `cookietray_${params.nCells}x_${Math.round(params.cellWid)}w_${Math.round(params.cellLen)}l_${Math.round(params.cradleR)}r_${Math.round(params.draftDeg)}d.${ext}`;
}

/** Sync the URL querystring to the CURRENT form state via replaceState (no
 * history spam). Together with applyURLParamsToForm() above, this is what
 * makes any configured tray a shareable/bookmarkable link -- called after
 * every SUCCESSFUL build (not the failed-build recovery path: the URL
 * should reflect what actually built, not input that just errored). */
function updateURLFromState() {
  const trayInput = formToObject(els.trayForm);
  const productInput = formToObject(els.productForm);
  const qs = encodeStateToParams({ trayInput, productInput }).toString();
  const url = new URL(location.href);
  url.search = qs;
  history.replaceState(null, "", url);
  refreshARPanelIfOpen();
}

/** Trims to at most 2 decimals without forcing trailing zeros (12.70 -> "12.7", 46 -> "46"). */
function fmtNum(n) {
  return Number(n.toFixed(2)).toString();
}

/** `buildProduct(spec)`-shaped input derived from the configured product
 * (lastFillSpec), or null if none is configured. lastFillSpec is only ever
 * set from a successful suggestFromProduct() call (see
 * applyProductSuggestions), which already validated that diameter/thickness
 * or width/height/thickness are all > 0. */
function productSpecForExport() {
  if (!lastFillSpec) return null;
  if (lastFillSpec.productType === "rectangle") {
    return {
      productType: "rectangle",
      width: lastFillSpec.productWidth,
      height: lastFillSpec.productHeight,
      thickness: lastFillSpec.productThickness,
      edgeRTop: lastFillSpec.edgeRTop,
      edgeRBot: lastFillSpec.edgeRBot,
    };
  }
  return {
    productType: "round",
    diameter: lastFillSpec.cookieDiameter,
    thickness: lastFillSpec.cookieThickness,
  };
}

function filenameForProduct(fillSpec, ext) {
  if (fillSpec.productType === "rectangle") {
    return `cookieproduct_${fmtNum(fillSpec.productWidth)}x${fmtNum(fillSpec.productHeight)}x${fmtNum(fillSpec.productThickness)}.${ext}`;
  }
  return `cookieproduct_d${fmtNum(fillSpec.cookieDiameter)}x${fmtNum(fillSpec.cookieThickness)}.${ext}`;
}

async function rebuild() {
  const result = makeTrayParams(readTrayInput());
  const fitWarnings = checkProductFit(result.params, lastFillSpec);
  const filletWarnings = checkFilletProductConflict(result.params, lastFillSpec);
  const advisories = [...(result.warnings || []), ...fitWarnings, ...filletWarnings];

  renderMessages(result.errors, advisories);
  markInvalidFields(result.errors);
  renderTitleblock(result.derived, result.params);
  if (result.derived) refreshPitchDisplay();

  if (!result.valid) {
    lastValidParams = null;
    lastDerived = null;
    buildExportable = false;
    refreshExportButtons();
    els.fillToggle.disabled = true;
    viewer.setFillGroup(null);
    setViewportStale(true);
    setBuildStatus("error", "Blocked");
    return;
  }

  lastValidParams = inputOnly(result.params);
  lastDerived = result.derived;
  els.fillToggle.disabled = !lastFillSpec;
  if (!lastFillSpec) els.fillToggle.checked = false;

  if (!sectionAxisTouched && els.sectionAxis.value !== lastValidParams.longAxis) {
    els.sectionAxis.value = lastValidParams.longAxis;
  }

  const token = ++buildToken;
  setStatus("Building...");
  setBuildStatus("building", "Building...");
  buildExportable = false;
  refreshExportButtons();
  try {
    const { mesh, edges } = await api.build(lastValidParams);
    if (token !== buildToken) return; // a newer build superseded this one
    viewer.setShape({ mesh, edges });
    updateFillOverlay();
    if (els.sectionToggle.checked) updateSectionPlane();
    hasEverBuilt = true;
    buildExportable = true;
    refreshExportButtons();
    setViewportStale(false);
    setStatus("");
    setBuildStatus("ready", "Ready to export");
    updateURLFromState();
  } catch (err) {
    if (token !== buildToken) return;
    setStatus("");
    renderMessages([...result.errors, `Build failed: ${err.message}`], advisories);
    markInvalidFields(result.errors);
    // The worker keeps its last successfully-built shape intact on a failed
    // build (never deletes-then-fails), so if one exists it's still a
    // legitimate export candidate -- don't strand it behind disabled
    // buttons just because THIS build attempt threw.
    if (hasEverBuilt) {
      buildExportable = true;
    }
    refreshExportButtons();
    setViewportStale(true);
    setBuildStatus("error", "Build failed");
  }
}

function updateFillOverlay() {
  if (els.fillToggle.checked && lastFillSpec && lastValidParams) {
    const group = buildFillGroup({ params: lastValidParams, ...lastFillSpec });
    viewer.setFillGroup(group);
  } else {
    viewer.setFillGroup(null);
  }
}

// ---- Dimension-callout overlay ----
// Live technical dimension lines (extension lines + arrowheads) projected
// from the tray's actual 3D bounding box onto the viewport, showing the
// same footprint/height numbers as the title-block. Recomputed every frame
// so they track the camera through orbit/pan/zoom and view-snap animation
// (an isometric projection means these are never perfectly horizontal or
// vertical on screen -- that's expected; they follow the true 3D edges).
const SVG_NS = "http://www.w3.org/2000/svg";

function makeDimGroup() {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "dim-group");
  const extA = document.createElementNS(SVG_NS, "line");
  extA.setAttribute("class", "dim-ext");
  const extB = document.createElementNS(SVG_NS, "line");
  extB.setAttribute("class", "dim-ext");
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "dimline");
  line.setAttribute("marker-start", "url(#dimArrowStart)");
  line.setAttribute("marker-end", "url(#dimArrowEnd)");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("class", "dim-label-bg");
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "dim");
  text.setAttribute("text-anchor", "middle");
  g.append(extA, extB, line, bg, text);
  return { g, extA, extB, line, bg, text };
}

function initDimDefs() {
  if (!els.dimsOverlay) return;
  const defs = document.createElementNS(SVG_NS, "defs");
  const addMarker = (id, path, refX) => {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", refX);
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", path);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "#59656c");
    p.setAttribute("stroke-width", "1.1");
    marker.appendChild(p);
    defs.appendChild(marker);
  };
  addMarker("dimArrowEnd", "M0,0 L7,3 L0,6", "6");
  addMarker("dimArrowStart", "M7,0 L0,3 L7,6", "1");
  els.dimsOverlay.appendChild(defs);
}
initDimDefs();

const dimLength = makeDimGroup();
const dimWidth = makeDimGroup();
const dimHeight = makeDimGroup();
els.dimsOverlay?.append(dimLength.g, dimWidth.g, dimHeight.g);

function updateDimGroup({ extA, extB, line, bg, text }, p1, p2, labelText) {
  const visible = p1 && p2 && labelText;
  for (const el of [extA, extB, line, bg, text]) el.setAttribute("opacity", visible ? "1" : "0");
  if (!visible) return;

  // Short perpendicular extension ticks at each end.
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * 6;
  const py = (dx / len) * 6;

  extA.setAttribute("x1", p1.x - px);
  extA.setAttribute("y1", p1.y - py);
  extA.setAttribute("x2", p1.x + px);
  extA.setAttribute("y2", p1.y + py);
  extB.setAttribute("x1", p2.x - px);
  extB.setAttribute("y1", p2.y - py);
  extB.setAttribute("x2", p2.x + px);
  extB.setAttribute("y2", p2.y + py);

  line.setAttribute("x1", p1.x);
  line.setAttribute("y1", p1.y);
  line.setAttribute("x2", p2.x);
  line.setAttribute("y2", p2.y);

  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  text.setAttribute("x", midX);
  text.setAttribute("y", midY + 4);
  text.textContent = labelText;

  try {
    const bbox = text.getBBox();
    bg.setAttribute("x", bbox.x - 4);
    bg.setAttribute("y", bbox.y - 2);
    bg.setAttribute("width", bbox.width + 8);
    bg.setAttribute("height", bbox.height + 4);
  } catch {
    // getBBox can throw before the element is actually laid out
  }
}

function updateDimsOverlay() {
  requestAnimationFrame(updateDimsOverlay);
  if (!els.dimsToggle?.checked || !lastValidParams || !lastDerived) {
    updateDimGroup(dimLength, null, null, "");
    updateDimGroup(dimWidth, null, null, "");
    updateDimGroup(dimHeight, null, null, "");
    return;
  }
  const box = viewer.getTrayBoundingBox();
  if (!box) return;
  const p = (x, y, z) => viewer.projectToScreen(x, y, z);

  updateDimGroup(dimLength, p(box.min.x, box.min.y, box.min.z), p(box.max.x, box.min.y, box.min.z), lastDerived.outerL.toFixed(1));
  updateDimGroup(dimWidth, p(box.max.x, box.min.y, box.min.z), p(box.max.x, box.max.y, box.min.z), lastDerived.outerW.toFixed(1));
  updateDimGroup(dimHeight, p(box.max.x, box.max.y, box.min.z), p(box.max.x, box.max.y, box.max.z), lastDerived.overallH.toFixed(1));
}
updateDimsOverlay();

// ---- Phone / AR handoff ----
// The QR code just encodes the live location.href (kept in sync with the
// current build by updateURLFromState() above) -- scanning it opens this
// exact tray/product on the phone, which rebuilds it locally from the URL
// params. No upload, no backend, no file transfer. The panel's "View in AR"
// button (slotted into model-viewer's own ar-button slot, so it's
// automatically shown/hidden by real capability detection -- see
// canActivateAR/updateArAvailabilityNote below) launches WebXR or Scene
// Viewer on Android via the GLB, and AR Quick Look on iOS via a
// client-side-generated USDZ (see arExport.js) -- on ANY iOS browser, not
// just Safari: model-viewer 4.3.1 already supports handing Quick Look off
// from third-party iOS browsers (Chrome/Firefox/Edge, all WebKit under the
// hood), gated only on the app providing iosSrc.
let arPanelOpen = false;
let arTarget = "tray";
let currentModelObjectUrl = null;
let currentUsdzObjectUrl = null;
// Sticky once the user manually touches the "Lay flat" toggle -- after that,
// switching AR target no longer overrides their choice (see setArTarget).
let arFlatToggleUserSet = false;

async function ensureModelViewerLoaded() {
  if (!customElements.get("model-viewer")) {
    // The package's ESM "module" entry re-imports a bare "three" specifier
    // at a newer API version than this app pins (peer range conflict --
    // see the --legacy-peer-deps install). Its prebuilt dist bundle is
    // fully self-contained (its own internal three, no external imports),
    // so target that directly instead of the bare package specifier.
    await import("@google/model-viewer/dist/model-viewer.min.js");
  }
}

/** Only used to decide whether it's worth generating a USDZ at all (Android
 * and desktop never consult iosSrc, so skip that extra export there -- a
 * real cost, since USDZ is an uncompressed zip that can run several MB for
 * a detailed tray). This is NOT used to gate AR availability by browser:
 * model-viewer 4.3.1 already supports AR Quick Look handoff from iOS Chrome/
 * Firefox/Edge/DuckDuckGo (all WebKit-based), not just Safari -- see
 * IS_AR_QUICKLOOK_CANDIDATE in its own constants.ts, which does real feature
 * detection (`relList.supports('ar')`) for third-party iOS browsers rather
 * than assuming they can't. iPadOS reports as "MacIntel" in its UA,
 * distinguished from a real Mac by touch support. */
function detectIOSBrowser() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return { isIOS };
}

/** Static per-session guidance text (device/browser doesn't change mid-visit)
 * -- set once when the panel first opens. Deliberately browser-agnostic: it
 * used to steer non-Safari iOS users to "open this in Safari," which is no
 * longer true (see detectIOSBrowser above) and actively worse UX. Genuine
 * AR unavailability (checked via model-viewer's own canActivateAR, a real
 * capability signal) is surfaced separately, only after the model has
 * actually finished loading -- see updateArAvailabilityNote(). */
function renderArNote() {
  const { isIOS } = detectIOSBrowser();
  els.arNote.className = "ar-note";
  els.arNote.textContent = isIOS
    ? "Tap “View in AR” to place this in your space. Drag the model to move it, or exit AR and tap the button again to start over."
    : "On a phone: tap “View in AR” to place this in your space, then drag to move it. On desktop: rotate & zoom the 3D model above.";
}

/** Runs once <model-viewer> has actually finished loading the current model
 * (so canActivateAR reflects real capability, not a stale/default value).
 * Appends a short, non-technical note ONLY when AR is genuinely unavailable
 * on this device/browser -- never assumed from a browser check. */
function updateArAvailabilityNote() {
  // Idempotent: safe to call after every refresh (fresh export or cache
  // hit) without piling up duplicate notes.
  const existing = els.arNote?.querySelector(".ar-note-unavailable");
  if (existing) existing.remove();
  if (!els.arModelViewer || els.arModelViewer.canActivateAR) return;
  const span = document.createElement("span");
  span.className = "ar-note-unavailable";
  span.textContent = " AR isn't available on this device or browser — you can still rotate and zoom the 3D model above.";
  els.arNote.append(span);
}

// AR launch state machine (Ready -> Launching -> Ready), independent of
// refreshARModel's own asset-preparation state above. Guards against a
// rapid double-tap re-entering activateAR() mid-launch: the slotted button
// stops the click from bubbling to model-viewer's own ar-button container
// while a launch is already in flight.
const AR_LAUNCH_DEFAULT_LABEL = "📱 View in AR";
let arLaunching = false;
let arLaunchResetTimer = null;

function resetArLaunchState(label) {
  arLaunching = false;
  if (arLaunchResetTimer) {
    clearTimeout(arLaunchResetTimer);
    arLaunchResetTimer = null;
  }
  if (els.arLaunchBtn) els.arLaunchBtn.textContent = label ?? AR_LAUNCH_DEFAULT_LABEL;
}

els.arLaunchBtn?.addEventListener("click", (event) => {
  if (arLaunching) {
    event.preventDefault();
    event.stopImmediatePropagation(); // don't let this second tap reach the ar-button container's own activateAR() call
    return;
  }
  arLaunching = true;
  els.arLaunchBtn.textContent = "Opening AR…";
  // Belt-and-suspenders release: iOS Quick Look navigates away from the
  // page entirely, so no further ar-status events are guaranteed once that
  // happens -- the lock can't depend solely on hearing back from
  // model-viewer, or a launch that never reports back would wedge the
  // button forever.
  arLaunchResetTimer = setTimeout(() => resetArLaunchState(), 4000);
});

els.arModelViewer?.addEventListener("ar-status", (event) => {
  const status = event.detail?.status;
  console.debug(`[AR] ar-status: ${status}`);
  if (status === "failed") {
    resetArLaunchState("Try AR again");
  } else if (status === "object-placed" || status === "not-presenting") {
    resetArLaunchState();
  }
});

/** Whether "Show product fill" is meaningful right now (tray target + a
 * configured product) -- disabled and force-unchecked otherwise. */
function syncArFillToggleAvailability() {
  const available = arTarget === "tray" && !!lastFillSpec;
  els.arFillToggle.disabled = !available;
  if (!available) els.arFillToggle.checked = false;
}

function setArTarget(target) {
  arTarget = target;
  for (const b of els.arTargetSeg.querySelectorAll(".seg-btn")) {
    b.classList.toggle("on", b.dataset.segValue === target);
  }
  syncArFillToggleAvailability();
  // A standalone product is naturally presented resting on its broad face
  // (how it'd actually sit on a table), unlike the tray, which already
  // sits base-down by default -- so default the toggle accordingly per
  // target, but only until the user makes their own choice, which then
  // sticks regardless of which target they're viewing.
  if (!arFlatToggleUserSet && els.arFlatToggle) {
    els.arFlatToggle.checked = target === "product";
  }
  refreshARModel();
}

for (const btn of els.arTargetSeg.querySelectorAll(".seg-btn")) {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    setArTarget(btn.dataset.segValue);
  });
}

els.arFillToggle?.addEventListener("change", () => {
  if (arPanelOpen) refreshARModel(); // re-export the GLB/USDZ with/without fill baked in
});

els.arFlatToggle?.addEventListener("change", () => {
  arFlatToggleUserSet = true; // stops setArTarget from overriding the user's own choice
  if (arPanelOpen) refreshARModel(); // re-export laid flat vs. the upright (base-down) default
});

/** Preview-only overlay (never baked into the exported GLB/USDZ -- native
 * room-placement AR renders model geometry only and can't show HTML/SVG, so
 * this only affects the in-panel <model-viewer>). Uses model-viewer's
 * declarative hotspot API: a slotted child tracks a 3D point on the model
 * as the camera orbits, no manual screen-space projection needed. Position
 * is expressed in the exported GLB's own space -- mirror wrapForExport()'s
 * transform (mm -> m, then Z-up -> Y-up via (x,y,z) -> (x,z,-y)). */
function mmToGlbPosition(x, y, z) {
  return `${(x * 0.001).toFixed(4)} ${(z * 0.001).toFixed(4)} ${(-y * 0.001).toFixed(4)}`;
}

function computeArDimsLabel() {
  if (arTarget === "product") {
    const spec = productSpecForExport();
    if (!spec) return null;
    if (spec.productType === "rectangle") {
      return { text: `${spec.width}×${spec.height}×${spec.thickness}mm`, posMM: [spec.thickness / 2, spec.width / 2, spec.height / 2] };
    }
    return { text: `⌀${spec.diameter}×${spec.thickness}mm`, posMM: [spec.thickness / 2, spec.diameter / 2, spec.diameter / 2] };
  }
  if (!lastDerived) return null;
  const box = viewer.getTrayBoundingBox();
  if (!box) return null;
  return {
    text: `${lastDerived.outerL.toFixed(1)} × ${lastDerived.outerW.toFixed(1)} × ${lastDerived.overallH.toFixed(1)}mm`,
    posMM: [box.max.x, box.max.y, box.max.z],
  };
}

function updateArDimsHotspot() {
  if (!customElements.get("model-viewer")) return;
  // computeArDimsLabel()'s position assumes the default base-down export
  // transform; the "Lay flat" toggle applies an extra tip + re-centering
  // translation (see arExport.js) that this label doesn't account for, so
  // suppress it rather than show it drifted off the model's actual corner.
  const data = els.arDimsToggle.checked && !els.arFlatToggle?.checked ? computeArDimsLabel() : null;
  if (!data) {
    els.arDimsHotspot.classList.add("hidden");
    return;
  }
  els.arDimsHotspot.classList.remove("hidden");
  els.arDimsHotspot.textContent = data.text;
  const position = mmToGlbPosition(...data.posMM);
  els.arDimsHotspot.dataset.position = position;
  els.arModelViewer.updateHotspot({ name: "dims", position, normal: "0 1 0" });
}

els.arDimsToggle?.addEventListener("change", updateArDimsHotspot);

// Every async step of the AR flow (dynamic import, GLB/USDZ export,
// model-viewer's own parse) is wrapped with a timeout below -- a promise
// that stalls (slow/broken network fetching the model-viewer chunk, a
// malformed GLB model-viewer never finishes parsing, etc.) would otherwise
// leave "Preparing 3D model..." showing forever instead of surfacing an
// error the user can act on.
const AR_STEP_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Resolves once <model-viewer> actually finishes loading/parsing the
 * model just assigned to `.src` (its "load" event), rejects on its "error"
 * event or after `timeoutMs` -- so a blob URL that model-viewer can't
 * render (vs. one JS merely handed to it) still surfaces visibly. */
function waitForModelViewerLoad(mv, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      mv.removeEventListener("load", onLoad);
      mv.removeEventListener("error", onError);
    };
    const onLoad = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (ev) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(ev?.detail?.type ? `model-viewer couldn't load the model (${ev.detail.type})` : "model-viewer couldn't load the model"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`model-viewer did not finish loading after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    mv.addEventListener("load", onLoad, { once: true });
    mv.addEventListener("error", onError, { once: true });
  });
}

// Guards against a stale refresh clobbering a newer one's UI when the user
// switches AR target (or toggles fill) again before the first export
// finishes -- each call only touches the DOM if it's still the latest.
let arRefreshSeq = 0;

// Config-key cache: JSON.stringify of every input that actually affects the
// exported GLB/USDZ. All of {lastValidParams, lastFillSpec, spec} are plain,
// JSON-safe POJOs (never mutated in place -- always replaced wholesale on a
// successful rebuild), so stringifying them is cheap and correctly detects
// "nothing AR-relevant changed" -- e.g. re-opening the panel on the same
// target, or a refreshARPanelIfOpen() call after a rebuild that didn't
// actually touch this target's geometry. A cache hit skips straight past
// the GLB/USDZ export + model-viewer reparse entirely (spec: avoid
// regenerating AR assets unnecessarily). Reset to null on any failed
// export so a later identical-looking config still retries instead of
// permanently caching a failure.
let lastArCacheKey = null;

/** Export the currently-selected target (tray, optionally with the product
 * fill baked in, or a standalone product) as a display-only GLB (Android /
 * desktop preview) and, on iOS, an additional USDZ (AR Quick Look -- Safari
 * AND third-party iOS browsers alike, see detectIOSBrowser). Never touches
 * the STL/STEP export path (worker.js) -- entirely separate three.js-side
 * geometry (see arExport.js). */
async function refreshARModel() {
  if (!arPanelOpen) return;
  const seq = ++arRefreshSeq;
  try {
    console.debug("[AR] loading <model-viewer>...");
    await withTimeout(ensureModelViewerLoaded(), AR_STEP_TIMEOUT_MS, "Loading the 3D viewer");
    if (seq !== arRefreshSeq) return;
    console.debug("[AR] <model-viewer> ready");

    const includeFill = arTarget === "tray" && els.arFillToggle.checked && !!lastFillSpec;
    const layFlat = !!els.arFlatToggle?.checked;
    const spec = arTarget === "product" ? productSpecForExport() : null;
    const { isIOS } = detectIOSBrowser();

    const cacheKey = JSON.stringify({
      arTarget,
      includeFill,
      layFlat,
      isIOS,
      params: lastValidParams,
      fillSpec: includeFill ? lastFillSpec : null,
      spec,
    });
    if (cacheKey === lastArCacheKey && currentModelObjectUrl) {
      console.debug("[AR] config unchanged since last export -- reusing cached GLB/USDZ");
      updateArDimsHotspot();
      updateArAvailabilityNote();
      els.arViewerStatus.classList.add("hidden");
      return;
    }

    els.arViewerStatus.textContent = "Preparing 3D model...";
    els.arViewerStatus.classList.remove("hidden");

    // Built fresh here rather than reused from viewer.fillGroup, which is
    // only populated while the main viewport's OWN "Fill" toggle is on --
    // a separate control from this panel's "Show product fill" toggle. The
    // AR fill needs to reflect ITS OWN toggle regardless of the viewport's.
    const arFillGroup = includeFill && lastValidParams ? buildFillGroup({ params: lastValidParams, ...lastFillSpec }) : null;
    console.debug(
      `[AR] fill toggle=${els.arFillToggle.checked} target=${arTarget} lastFillSpec=${!!lastFillSpec} lastValidParams=${!!lastValidParams} -> arFillGroup children=${arFillGroup ? arFillGroup.children.length : "n/a"}`,
    );

    console.debug(`[AR] exporting GLB (target=${arTarget}, includeFill=${!!arFillGroup}, layFlat=${layFlat})...`);
    const glbBlob = await withTimeout(
      arTarget === "product" ? exportProductGLB(spec, layFlat) : exportTrayGLB(viewer, arFillGroup, layFlat),
      AR_STEP_TIMEOUT_MS,
      "Exporting the 3D model",
    );
    if (seq !== arRefreshSeq) return;
    console.debug(`[AR] GLB export done (${glbBlob.size} bytes)`);

    if (currentModelObjectUrl) URL.revokeObjectURL(currentModelObjectUrl);
    currentModelObjectUrl = URL.createObjectURL(glbBlob);
    const modelViewerLoaded = waitForModelViewerLoad(els.arModelViewer, AR_STEP_TIMEOUT_MS);
    els.arModelViewer.src = currentModelObjectUrl;

    // USDZ is only ever consulted by iOS's AR button (Quick Look) -- skip
    // generating it anywhere else (real cost: it's an uncompressed zip, can
    // run several MB for a detailed tray). model-viewer 4.3.1 already
    // supports handing Quick Look off from third-party iOS browsers, not
    // just Safari, so this is gated purely on platform (isIOS), never on
    // which iOS browser it is.
    if (isIOS) {
      console.debug("[AR] exporting USDZ for AR Quick Look...");
      const usdzBlob = await withTimeout(
        arTarget === "product" ? exportProductUSDZ(spec, layFlat) : exportTrayUSDZ(viewer, arFillGroup, layFlat),
        AR_STEP_TIMEOUT_MS,
        "Exporting the AR Quick Look model",
      );
      if (seq !== arRefreshSeq) return;
      console.debug(`[AR] USDZ export done (${usdzBlob.size} bytes)`);
      if (currentUsdzObjectUrl) URL.revokeObjectURL(currentUsdzObjectUrl);
      currentUsdzObjectUrl = URL.createObjectURL(usdzBlob);
      els.arModelViewer.iosSrc = currentUsdzObjectUrl;
    } else if (currentUsdzObjectUrl) {
      URL.revokeObjectURL(currentUsdzObjectUrl);
      currentUsdzObjectUrl = null;
      els.arModelViewer.iosSrc = null;
    }

    console.debug("[AR] waiting for <model-viewer> to report load...");
    await modelViewerLoaded;
    if (seq !== arRefreshSeq) return;
    console.debug("[AR] <model-viewer> reported load; model is visible");

    lastArCacheKey = cacheKey;
    updateArDimsHotspot();
    updateArAvailabilityNote();
    els.arViewerStatus.classList.add("hidden");
  } catch (err) {
    if (seq !== arRefreshSeq) return; // superseded by a newer refresh -- don't clobber its UI
    lastArCacheKey = null; // don't cache a failure -- a later identical-looking config should still retry
    console.error("[AR] failed to prepare 3D model:", err);
    els.arViewerStatus.textContent = arTarget === "product" && !lastFillSpec ? "No product configured yet." : humanizeARError(err);
    els.arViewerStatus.classList.remove("hidden");
  }
}

// Every error message this app itself throws inside the AR pipeline is
// already written to be shown as-is (withTimeout's own labels, "No tray
// built yet", model-viewer's load/error summary). Anything else is an
// unexpected failure from a dependency (GLTFExporter/USDZExporter/etc) whose
// raw message (a bare "Failed to execute ..." or "undefined is not a
// function") would be confusing and unactionable in the UI -- so only known,
// human-authored messages are shown verbatim; everything else falls back to
// a generic message while the real error still goes to the console above.
const KNOWN_AR_ERROR_PATTERNS = [/timed out after/, /^No tray built yet$/, /couldn't load the model/, /did not finish loading/];

function humanizeARError(err) {
  const message = err?.message ?? "";
  if (KNOWN_AR_ERROR_PATTERNS.some((re) => re.test(message))) {
    return `Couldn't prepare model: ${message}`;
  }
  return "Couldn't prepare the AR model right now. Try again, or check your connection.";
}

/** QR encodes the live, params-carrying URL -- generated client-side only
 * (the qrcode package renders to <canvas>; nothing is sent anywhere). */
async function refreshARQr() {
  const url = location.href;
  els.arShareLink.value = url;
  try {
    await QRCode.toCanvas(els.arQrCanvas, url, {
      width: 176,
      margin: 1,
      color: { dark: "#192227", light: "#ffffff" },
    });
  } catch {
    // QR payload too long for the chosen size, or canvas unsupported -- the
    // link text + copy button below still work as a fallback.
  }
}

async function openARPanel() {
  arPanelOpen = true;
  els.arPanelOverlay.classList.remove("hidden");
  els.arTargetProductBtn.disabled = !lastFillSpec;
  if (!lastFillSpec && arTarget === "product") arTarget = "tray";
  renderArNote();
  syncArFillToggleAvailability();
  setArTarget(arTarget);
  await refreshARQr();
}

function closeARPanel() {
  arPanelOpen = false;
  els.arPanelOverlay.classList.add("hidden");
}

/** Called after every successful build (see updateURLFromState) so the
 * panel's model + QR stay live if the user leaves it open while tweaking
 * inputs, without doing any of that work while the panel is closed. */
function refreshARPanelIfOpen() {
  if (!arPanelOpen) return;
  els.arTargetProductBtn.disabled = !lastFillSpec;
  syncArFillToggleAvailability();
  if (!lastFillSpec && arTarget === "product") {
    setArTarget("tray"); // triggers refreshARModel() itself
  } else {
    refreshARModel();
  }
  refreshARQr();
}

els.arShareBtn?.addEventListener("click", () => openARPanel());
els.arPanelClose?.addEventListener("click", () => closeARPanel());
els.arPanelOverlay?.addEventListener("click", (event) => {
  if (event.target === els.arPanelOverlay) closeARPanel();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && arPanelOpen) closeARPanel();
});

// Redundant close paths for mobile, where the header close button can end
// up hard to reach under the browser's own chrome: swipe-down-to-dismiss,
// started only from the drag-handle/header zone so it doesn't fight
// scrolling the panel's own content (QR section etc. further down).
let arSwipeStartY = null;
let arSwipeCurrentY = null;

els.arPanel?.addEventListener(
  "touchstart",
  (event) => {
    if (event.touches.length !== 1) return;
    const rect = els.arPanel.getBoundingClientRect();
    if (event.touches[0].clientY - rect.top > 60) return;
    arSwipeStartY = event.touches[0].clientY;
    arSwipeCurrentY = arSwipeStartY;
  },
  { passive: true }
);

els.arPanel?.addEventListener(
  "touchmove",
  (event) => {
    if (arSwipeStartY === null) return;
    arSwipeCurrentY = event.touches[0].clientY;
  },
  { passive: true }
);

els.arPanel?.addEventListener("touchend", () => {
  if (arSwipeStartY === null) return;
  if (arSwipeCurrentY - arSwipeStartY > 60) closeARPanel();
  arSwipeStartY = null;
  arSwipeCurrentY = null;
});

els.arCopyLinkBtn?.addEventListener("click", async () => {
  const original = els.arCopyLinkBtn.textContent;
  try {
    await navigator.clipboard.writeText(els.arShareLink.value);
    els.arCopyLinkBtn.textContent = "Copied!";
  } catch {
    els.arShareLink.select();
    els.arCopyLinkBtn.textContent = "Select + Ctrl/Cmd-C";
  }
  setTimeout(() => {
    els.arCopyLinkBtn.textContent = original;
  }, 1500);
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function handleExport(ext) {
  if (exportTarget === "product") {
    const spec = productSpecForExport();
    if (!spec) return;
    try {
      await api.buildProduct(spec);
      const blob = ext === "stl" ? await api.exportProductSTL() : await api.exportProductSTEP();
      downloadBlob(blob, filenameForProduct(lastFillSpec, ext));
    } catch (err) {
      setStatus(`Product export failed: ${err.message}`);
      setTimeout(() => setStatus(""), 4000);
    }
    return;
  }

  if (!lastValidParams) return;
  try {
    const blob = ext === "stl" ? await api.exportSTL() : await api.exportSTEP();
    downloadBlob(blob, filenameFor(lastValidParams, ext));
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
    setTimeout(() => setStatus(""), 4000);
  }
}

els.downloadStl.addEventListener("click", () => handleExport("stl"));
els.downloadStep.addEventListener("click", () => handleExport("step"));

setStatus("Loading OpenCASCADE...");
setBuildStatus("building", "Loading...");
applyURLParamsToForm(); // populate the form from a shared link BEFORE the first build, if present
api
  .init()
  .then(() => {
    setStatus("");
    applyProductSuggestions(); // seed suggestable tray fields from product defaults (or URL-provided values)
  })
  .catch((err) => {
    setStatus(`Failed to load OpenCASCADE: ${err.message}`);
    setBuildStatus("error", "Load failed");
  });

// Exposed for automated/browser testing.
window.__cookieTray = {
  api,
  rebuild,
  viewer,
  userTouched,
  get lastValidParams() { return lastValidParams; },
  get lastFillSpec() { return lastFillSpec; },
  get lastDerived() { return lastDerived; },
  get exportTarget() { return exportTarget; },
  setExportTarget,
  openARPanel,
  closeARPanel,
  setArTarget,
  detectIOSBrowser,
  get arPanelOpen() { return arPanelOpen; },
  get arTarget() { return arTarget; },
  get arCacheKey() { return lastArCacheKey; },
  get arLaunching() { return arLaunching; },
  get canActivateAR() { return els.arModelViewer?.canActivateAR ?? null; },
  get currentModelObjectUrl() { return currentModelObjectUrl; },
  get currentUsdzObjectUrl() { return currentUsdzObjectUrl; },
};
