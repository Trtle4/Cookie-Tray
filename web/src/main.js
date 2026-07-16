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
};

const viewer = new Viewer(els.canvas);

// Tray fields the product section can suggest a value for. If the user has
// edited one of these directly, their value wins — the product section
// stops overwriting it until the page is reloaded.
const SUGGESTABLE_FIELDS = ["nCells", "cellLen", "cellWid", "cradleR"];
const userTouched = new Set();

let lastValidParams = null; // §3 input-shaped params, ready for buildTray
let lastFillSpec = null; // { cookiesPerCell, cookieDiameter, cookieThickness, endClearance } | null
let debounceTimer = null;
let buildToken = 0;

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
    cookieDiameter: raw.cookieDiameter,
    cookieThickness: raw.cookieThickness,
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
      cradleR: suggestion.cradleR.toFixed(1),
    };
    for (const field of SUGGESTABLE_FIELDS) {
      if (userTouched.has(field)) continue;
      const el = els.trayForm.elements[field];
      el.value = suggestedValues[field];
      el.classList.add("suggested");
    }
    lastFillSpec = {
      cookiesPerCell: suggestion.cookiesPerCell,
      cookieDiameter: productInput.cookieDiameter,
      cookieThickness: productInput.cookieThickness,
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
    div.textContent = e;
    els.messages.appendChild(div);
  }
  for (const w of warnings) {
    const div = document.createElement("div");
    div.className = "msg warning";
    div.textContent = w;
    els.messages.appendChild(div);
  }
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
  return `cookietray_${params.nCells}x_${Math.round(params.cellWid)}w_${Math.round(params.cellLen)}l.${ext}`;
}

async function rebuild() {
  const result = makeTrayParams(readTrayInput());

  renderMessages(result.errors, result.warnings || []);
  renderSummary(result.derived);
  if (result.derived) refreshPitchDisplay();

  if (!result.valid) {
    lastValidParams = null;
    els.downloadStl.disabled = true;
    els.downloadStep.disabled = true;
    els.fillToggle.disabled = true;
    viewer.setFillGroup(null);
    return;
  }

  lastValidParams = inputOnly(result.params);
  els.fillToggle.disabled = !lastFillSpec;
  if (!lastFillSpec) els.fillToggle.checked = false;

  const token = ++buildToken;
  setStatus("Building...");
  els.downloadStl.disabled = true;
  els.downloadStep.disabled = true;
  try {
    const { mesh, edges } = await api.build(lastValidParams);
    if (token !== buildToken) return; // a newer build superseded this one
    viewer.setShape({ mesh, edges });
    updateFillOverlay();
    els.downloadStl.disabled = false;
    els.downloadStep.disabled = false;
    setStatus("");
  } catch (err) {
    if (token !== buildToken) return;
    setStatus("");
    renderMessages([...result.errors, `Build failed: ${err.message}`], result.warnings || []);
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
