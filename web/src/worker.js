/**
 * Web Worker: loads the OpenCASCADE WASM build, builds the tray solid, and
 * hands back a three.js-ready mesh (plus STL/STEP blobs on demand). Runs off
 * the main thread since OCC boolean ops are slow-ish and would freeze the UI.
 */

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC } from "replicad";
import { expose } from "comlink";

import { buildTray, buildProduct } from "./geometry.js";

let readyPromise = null;
function init() {
  if (!readyPromise) {
    readyPromise = opencascade({ locateFile: () => opencascadeWasm }).then((OC) => {
      setOC(OC);
      return true;
    });
  }
  return readyPromise;
}

let currentShape = null;

async function build(params) {
  await init();
  // Build the NEW shape before touching the old one: if buildTray throws,
  // currentShape must keep pointing at the last successfully-built (valid,
  // still-exportable) shape rather than a freed/dangling reference.
  const newShape = buildTray(params);
  if (currentShape) {
    try {
      currentShape.delete();
    } catch {
      // already freed
    }
  }
  currentShape = newShape;
  const mesh = currentShape.mesh();
  const edges = currentShape.meshEdges();
  const bbox = currentShape.boundingBox;
  return {
    mesh,
    edges,
    bbox: { bounds: bbox.bounds, center: bbox.center },
  };
}

async function exportSTL() {
  if (!currentShape) throw new Error("No shape built yet");
  return currentShape.blobSTL();
}

async function exportSTEP() {
  if (!currentShape) throw new Error("No shape built yet");
  return currentShape.blobSTEP();
}

let currentProductShape = null;

/** Build a single product unit (never fused into the tray) for standalone export. */
async function buildProductSolid(spec) {
  await init();
  const newShape = buildProduct(spec);
  if (currentProductShape) {
    try {
      currentProductShape.delete();
    } catch {
      // already freed
    }
  }
  currentProductShape = newShape;
  return true;
}

async function exportProductSTL() {
  if (!currentProductShape) throw new Error("No product built yet");
  return currentProductShape.blobSTL();
}

async function exportProductSTEP() {
  if (!currentProductShape) throw new Error("No product built yet");
  return currentProductShape.blobSTEP();
}

/** Milestone/self-test helper: build+mesh+STEP a plain box, no tray geometry involved. */
async function selfTest() {
  await init();
  const { makeBaseBox } = await import("replicad");
  const box = makeBaseBox(10, 10, 10);
  const mesh = box.mesh();
  const blob = box.blobSTEP();
  const text = await blob.text();
  box.delete();
  return {
    triangleCount: mesh.triangles.length,
    vertexCount: mesh.vertices.length,
    stepHeader: text.slice(0, 20),
    stepSize: blob.size,
  };
}

expose({
  init,
  build,
  exportSTL,
  exportSTEP,
  buildProduct: buildProductSolid,
  exportProductSTL,
  exportProductSTEP,
  selfTest,
});
