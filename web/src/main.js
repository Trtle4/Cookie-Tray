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
  summary: document.getElementById("derived-summary"),
  status: document.getElementById("status-overlay"),
  downloadStl: document.getElementById("download-stl"),
  downloadStep: document.getElementById("download-step"),
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
};

const viewer = new Viewer(els.canvas);

// Tray fields the product section can suggest a value for. If the user has
// edited one of these directly, their value wins — the product section
// stops overwriting it until the page is reloaded.
const SUGGESTABLE_FIELDS = ["nCells", "cellLen", "cellWid", "cellH", "cradleR"];
const userTouched = new Set();
let sectionAxisTouched = false;

let lastValidParams = null; // §3 input-shaped params, ready for buildTray
let lastFillSpec = null; // { cookiesPerCell, cookieDiameter, cookieThickness, endClearance } | null
let debounceTimer = null;
let buildToken = 0;
let hasEverBuilt = false; // true once any build has ever succeeded -- lets a
// later build FAILURE keep exporting that still-valid previous shape
// instead of stranding it behind disabled buttons (worker.js keeps
// currentShape pointed at the last success on failure; see build()).

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
for (const btn of els.cameraButtons) {
  btn.addEventListener("click", () => viewer.setCameraView(btn.dataset.view));
}

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

/** Dim the 3D view when the displayed shape no longer corresponds to the
 * current form input (guards reject it, or the last build attempt threw). */
function setViewportStale(stale) {
  els.canvas.classList.toggle("stale", stale);
}

function renderSummary(derived) {
  if (!derived) {
    els.summary.innerHTML = "";
    return;
  }
  const rows = [
    ["Top L x W", `${derived.topL.toFixed(1)} x ${derived.topW.toFixed(1)} mm`],
    ["Overall height", `${derived.overallH.toFixed(1)} mm`],
    ["Outer footprint", `${derived.outerL.toFixed(1)} x ${derived.outerW.toFixed(1)} mm`],
    ["Footprint area", `${(derived.footprint / 100).toFixed(1)} cm^2`],
    ["Cell pitch", `${derived.pitch.toFixed(1)} mm`],
  ];
  els.summary.innerHTML = rows.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join("");
}

function filenameFor(params, ext) {
  return `cookietray_${params.nCells}x_${Math.round(params.cellWid)}w_${Math.round(params.cellLen)}l_${Math.round(params.cradleR)}r_${Math.round(params.draftDeg)}d.${ext}`;
}

async function rebuild() {
  const result = makeTrayParams(readTrayInput());
  const fitWarnings = checkProductFit(result.params, lastFillSpec);

  renderMessages(result.errors, [...(result.warnings || []), ...fitWarnings]);
  markInvalidFields(result.errors);
  renderSummary(result.derived);
  if (result.derived) refreshPitchDisplay();

  if (!result.valid) {
    lastValidParams = null;
    els.downloadStl.disabled = true;
    els.downloadStep.disabled = true;
    els.fillToggle.disabled = true;
    viewer.setFillGroup(null);
    setViewportStale(true);
    return;
  }

  lastValidParams = inputOnly(result.params);
  els.fillToggle.disabled = !lastFillSpec;
  if (!lastFillSpec) els.fillToggle.checked = false;

  if (!sectionAxisTouched && els.sectionAxis.value !== lastValidParams.longAxis) {
    els.sectionAxis.value = lastValidParams.longAxis;
  }

  const token = ++buildToken;
  setStatus("Building...");
  els.downloadStl.disabled = true;
  els.downloadStep.disabled = true;
  try {
    const { mesh, edges } = await api.build(lastValidParams);
    if (token !== buildToken) return; // a newer build superseded this one
    viewer.setShape({ mesh, edges });
    updateFillOverlay();
    if (els.sectionToggle.checked) updateSectionPlane();
    hasEverBuilt = true;
    els.downloadStl.disabled = false;
    els.downloadStep.disabled = false;
    setViewportStale(false);
    setStatus("");
  } catch (err) {
    if (token !== buildToken) return;
    setStatus("");
    renderMessages([...result.errors, `Build failed: ${err.message}`], [...(result.warnings || []), ...fitWarnings]);
    markInvalidFields(result.errors);
    // The worker keeps its last successfully-built shape intact on a failed
    // build (never deletes-then-fails), so if one exists it's still a
    // legitimate export candidate -- don't strand it behind disabled
    // buttons just because THIS build attempt threw.
    if (hasEverBuilt) {
      els.downloadStl.disabled = false;
      els.downloadStep.disabled = false;
    }
    setViewportStale(true);
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

els.downloadStl.addEventListener("click", async () => {
  if (!lastValidParams) return;
  const blob = await api.exportSTL();
  downloadBlob(blob, filenameFor(lastValidParams, "stl"));
});

els.downloadStep.addEventListener("click", async () => {
  if (!lastValidParams) return;
  const blob = await api.exportSTEP();
  downloadBlob(blob, filenameFor(lastValidParams, "step"));
});

setStatus("Loading OpenCASCADE...");
api
  .init()
  .then(() => {
    setStatus("");
    applyProductSuggestions(); // seed suggestable tray fields from product defaults
  })
  .catch((err) => {
    setStatus(`Failed to load OpenCASCADE: ${err.message}`);
  });

// Exposed for automated/browser testing.
window.__cookieTray = {
  api,
  rebuild,
  viewer,
  userTouched,
  get lastValidParams() { return lastValidParams; },
  get lastFillSpec() { return lastFillSpec; },
};
