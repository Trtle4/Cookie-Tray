/**
 * GLB + USDZ export for the AR/"View on phone" panel -- a DISPLAY mesh only,
 * built from the same three.js geometry already on screen (tray, optionally
 * with the product-fill overlay) or the same per-unit geometry fill.js draws
 * (a standalone product). Never touches, blocks, or reads from the STL/STEP
 * export path (worker.js / geometry.js), which stays the sole source of
 * truth for the real, watertight, exportable solid -- this module exists
 * purely so <model-viewer> has something to render and hand to Scene Viewer
 * (Android, via the GLB) or AR Quick Look (iOS Safari, via the USDZ).
 */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { rectProductGeometry } from "./fill.js";

const gltfExporter = new GLTFExporter();
const usdzExporter = new USDZExporter();

/** glTF/USDZ convention is meters + Y-up; this app models in millimeters
 * with Z-up (see viewer.js: camera.up = (0,0,1)). Wrapping in a group with
 * this scale+rotation converts on export without touching the live scene
 * (the source object is cloned, never reparented). */
function wrapForExport(object3D) {
  const wrapper = new THREE.Group();
  wrapper.rotation.x = -Math.PI / 2; // Z-up -> Y-up
  wrapper.scale.setScalar(0.001); // mm -> m
  wrapper.add(object3D);
  return wrapper;
}

async function toGLBBlob(wrapper) {
  const glb = await gltfExporter.parseAsync(wrapper, { binary: true });
  return new Blob([glb], { type: "model/gltf-binary" });
}

async function toUSDZBlob(wrapper) {
  // quickLookCompatible: iOS Quick Look's older/stricter USDZ material
  // handling (color-space + shader compatibility), separate from the
  // ar.anchoring default (horizontal plane) which already matches a tray
  // resting on a table/floor.
  const usdz = await usdzExporter.parseAsync(wrapper, { quickLookCompatible: true });
  return new Blob([usdz], { type: "model/vnd.usdz+zip" });
}

/** Deep-clones viewer.meshGroup (the tray solid + its crisp edge lines) and,
 * when `includeFill` is true and a fill overlay is currently built, also
 * clones viewer.fillGroup alongside it -- so the AR model can be viewed
 * either empty or loaded with product, matching the in-app 3D view. */
function buildTrayExportScene(viewer, includeFill) {
  if (!viewer.meshGroup.children.length) throw new Error("No tray built yet");
  const scene = new THREE.Group();
  scene.add(viewer.meshGroup.clone(true));
  if (includeFill && viewer.fillGroup.children.length) {
    scene.add(viewer.fillGroup.clone(true));
  }
  return scene;
}

export async function exportTrayGLB(viewer, includeFill = false) {
  return toGLBBlob(wrapForExport(buildTrayExportScene(viewer, includeFill)));
}

export async function exportTrayUSDZ(viewer, includeFill = false) {
  return toUSDZBlob(wrapForExport(buildTrayExportScene(viewer, includeFill)));
}

/** Build a single centered product-unit mesh (round cylinder or rounded-edge
 * rectangle), the same geometry fill.js tiles into a packed row. `spec`
 * matches productSpecForExport()'s shape: { productType, diameter,
 * thickness } | { productType, width, height, thickness, edgeRTop, edgeRBot }. */
function buildProductMesh(spec) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xd4a76a,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  let geometry;
  if (spec.productType === "rectangle") {
    geometry = rectProductGeometry(spec.width, spec.height, spec.thickness, spec.edgeRTop, spec.edgeRBot);
  } else {
    geometry = new THREE.CylinderGeometry(spec.diameter / 2, spec.diameter / 2, spec.thickness, 48);
  }

  const mesh = new THREE.Mesh(geometry, material);
  if (spec.productType !== "rectangle") mesh.rotation.z = Math.PI / 2; // cylinder axis default is Y -> onto X, matching fill.js's convention
  return mesh;
}

export async function exportProductGLB(spec) {
  const mesh = buildProductMesh(spec);
  const blob = await toGLBBlob(wrapForExport(mesh));
  mesh.geometry.dispose();
  mesh.material.dispose();
  return blob;
}

export async function exportProductUSDZ(spec) {
  const mesh = buildProductMesh(spec);
  const blob = await toUSDZBlob(wrapForExport(mesh));
  mesh.geometry.dispose();
  mesh.material.dispose();
  return blob;
}
