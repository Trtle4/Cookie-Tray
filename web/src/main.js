import { wrap } from "comlink";

import { makeTrayParams, inputOnly } from "./params.js";
import { deriveParamsFromProduct } from "./calculator.js";
import { Viewer } from "./viewer.js";
import { buildFillGroup } from "./fill.js";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const api = wrap(worker);

const els = {
  tabs: document.querySelectorAll(".tab-btn"),
  panels: document.querySelectorAll(".tab-panel"),
  directForm: document.getElementById("direct-form"),
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

let mode = "direct";
let lastValidParams = null; // §3 input-shaped params, ready for buildTray
let lastFillSpec = null; // { cookiesPerCell, cookieDiameter, cookieThickness, endClearance } | null
let debounceTimer = null;
let buildToken = 0;

function setStatus(text) {
  els.status.textContent = text;
  els.status.classList.toggle("hidden", !text);
}

// ---- Tabs ----
els.tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.tabs.forEach((b) => b.classList.remove("active"));
    els.panels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.tab;
    document.getElementById(`${mode === "direct" ? "direct" : "product"}-form`).classList.add("active");
    scheduleRebuild();
  });
});

els.distributeBy.addEventListener("change", () => {
  const byPerCell = els.distributeBy.value === "cookiesPerCell";
  els.nCellsField.style.display = byPerCell ? "none" : "";
  els.perCellField.style.display = byPerCell ? "" : "none";
  scheduleRebuild();
});

// ---- Form change wiring ----
for (const form of [els.directForm, els.productForm]) {
  form.addEventListener("input", scheduleRebuild);
  form.addEventListener("change", scheduleRebuild);
}

els.fillToggle.addEventListener("change", updateFillOverlay);

function scheduleRebuild() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rebuild, 250);
}

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

function readDirectInput() {
  const raw = formToObject(els.directForm);
  return {
    nCells: raw.nCells,
    longAxis: raw.longAxis,
    cellLen: raw.cellLen,
    cellWid: raw.cellWid,
    cellH: raw.cellH,
    cradleR: raw.cradleR,
    wall: raw.wall,
    floor: raw.floor,
    cornerR: raw.cornerR,
    draftDeg: raw.draftDeg,
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
    sideClearance: raw.sideClearance,
    endClearance: raw.endClearance,
    cradleClearance: raw.cradleClearance,
    longAxis: raw.longAxisProduct,
  };
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
  ];
  els.summary.innerHTML = rows.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join("");
}

function filenameFor(params, ext) {
  return `cookietray_${params.nCells}x_${Math.round(params.cellWid)}w_${Math.round(params.cellLen)}l.${ext}`;
}

async function rebuild() {
  let result;
  // Direct mode preserves whatever fill spec a prior "From Product" build set,
  // so shrinking cell dimensions by hand still shows cookies overflowing.
  let fillSpec = lastFillSpec;

  if (mode === "direct") {
    result = makeTrayParams(readDirectInput());
  } else {
    const productInput = readProductInput();
    try {
      result = deriveParamsFromProduct(productInput);
      fillSpec = {
        cookiesPerCell: result.meta.cookiesPerCell,
        cookieDiameter: productInput.cookieDiameter,
        cookieThickness: productInput.cookieThickness,
        endClearance: productInput.endClearance,
      };
    } catch (err) {
      result = { params: null, derived: null, errors: [err.message], warnings: [] };
    }
  }

  renderMessages(result.errors, result.warnings || []);
  renderSummary(result.derived);

  if (!result.valid) {
    lastValidParams = null;
    els.downloadStl.disabled = true;
    els.downloadStep.disabled = true;
    els.fillToggle.disabled = true;
    viewer.setFillGroup(null);
    return;
  }

  lastValidParams = inputOnly(result.params);
  lastFillSpec = fillSpec;
  els.fillToggle.disabled = !fillSpec;
  if (!fillSpec) els.fillToggle.checked = false;

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
    rebuild();
  })
  .catch((err) => {
    setStatus(`Failed to load OpenCASCADE: ${err.message}`);
  });

// Exposed for automated/browser testing.
window.__cookieTray = {
  api,
  rebuild,
  viewer,
  get lastValidParams() { return lastValidParams; },
  get lastFillSpec() { return lastFillSpec; },
};
