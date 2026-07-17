import { wrap } from "comlink";

import { makeTrayParams, inputOnly } from "./params.js";
import { suggestFromProduct } from "./calculator.js";
import { Viewer } from "./viewer.js";
import { buildFillGroup } from "./fill.js";

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
  productType: document.querySelector('select[name="productType"]'),
  roundFields: document.getElementById("product-round-fields"),
  rectFields: document.getElementById("product-rect-fields"),
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
};

const viewer = new Viewer(els.canvas);

// ---- Segmented toggles: presentational buttons driving the real (visually
// hidden) <select> each is paired with, so field name/value/validation
// logic is completely untouched -- these just make the existing selects
// look/feel like a segmented control. ----
function wireSegment(container, selectEl) {
  const buttons = container.querySelectorAll(".seg-btn");
  const syncFromSelect = () => {
    for (const b of buttons) b.classList.toggle("on", b.dataset.segValue === selectEl.value);
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      if (selectEl.value === b.dataset.segValue) return;
      selectEl.value = b.dataset.segValue;
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

// Tray fields the product section can suggest a value for. If the user has
// edited one of these directly, their value wins — the product section
// stops overwriting it until the page is reloaded.
const SUGGESTABLE_FIELDS = ["nCells", "cellLen", "cellWid", "cellH", "cradleR"];
const userTouched = new Set();
let sectionAxisTouched = false;

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

els.productForm.addEventListener("input", applyProductSuggestions);

// ---- Tray section: mark suggestable fields as user-owned once edited ----
els.trayForm.addEventListener("input", (event) => {
  const name = event.target.name;
  if (SUGGESTABLE_FIELDS.includes(name)) {
    userTouched.add(name);
    event.target.classList.remove("suggested");
  }
  if (name === "pitch") {
    applyPitchEdit();
  }
  if (name === "divider" || name === "cellWid") {
    refreshPitchDisplay();
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
    suggestion = suggestFromProduct(readProductInput());
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
  const crossWidth = isRect ? fillSpec.productWidth : fillSpec.cookieDiameter;
  const vertExtent = isRect ? fillSpec.productHeight : fillSpec.cookieDiameter;
  const packPitch = isRect ? fillSpec.productThickness : fillSpec.cookieThickness;
  if (!(crossWidth > 0) || !(vertExtent > 0) || !(packPitch > 0)) return [];

  const warnings = [];
  if (crossWidth > params.cellWid) {
    warnings.push(
      `Product width (${crossWidth}mm) exceeds cell width (${params.cellWid}mm) by ${(crossWidth - params.cellWid).toFixed(1)}mm.`
    );
  }
  if (vertExtent > params.cellH) {
    warnings.push(
      `Product height (${vertExtent}mm) exceeds cell height (${params.cellH}mm) by ${(vertExtent - params.cellH).toFixed(1)}mm.`
    );
  }
  const neededLen = fillSpec.cookiesPerCell * packPitch + fillSpec.endClearance;
  if (neededLen > params.cellLen) {
    warnings.push(
      `Packed product length (${neededLen.toFixed(1)}mm) exceeds cell length (${params.cellLen}mm) by ${(neededLen - params.cellLen).toFixed(1)}mm.`
    );
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

  els.tbCells.textContent = `${params.nCells}-CELL`;
  els.msTitle.textContent = `Cookie Tray · ${params.nCells}-cell`;

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
api
  .init()
  .then(() => {
    setStatus("");
    applyProductSuggestions(); // seed suggestable tray fields from product defaults
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
};
