/**
 * Binary-GLB export for the AR/"View on phone" panel -- a DISPLAY mesh only,
 * built from the same three.js geometry already on screen (tray) or the
 * same per-unit geometry fill.js draws (product). Never touches, blocks, or
 * reads from the STL/STEP export path (worker.js / geometry.js), which
 * stays the sole source of truth for the real, watertight, exportable
 * solid -- this module exists purely so <model-viewer> has something to
 * render and hand to Scene Viewer / AR Quick Look.
 */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { rectProductGeometry } from "./fill.js";

const exporter = new GLTFExporter();

/** glTF/GLB convention is meters + Y-up; this app models in millimeters
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
  const glb = await exporter.parseAsync(wrapper, { binary: true });
  return new Blob([glb], { type: "model/gltf-binary" });
}

/** Export the CURRENTLY BUILT tray (viewer.meshGroup: the solid + its crisp
 * edge lines, exactly what's on screen) as a binary GLB Blob. */
export async function exportTrayGLB(viewer) {
  if (!viewer.meshGroup.children.length) throw new Error("No tray built yet");
  const cloned = viewer.meshGroup.clone(true); // deep clone the hierarchy; geometry/material are shared refs (fine, export-only)
  return toGLBBlob(wrapForExport(cloned));
}

/** Build a single centered product-unit mesh (round cylinder or rounded-edge
 * rectangle), the same geometry fill.js tiles into a packed row, and export
 * it as a binary GLB Blob. `spec` matches productSpecForExport()'s shape:
 * { productType, diameter, thickness } | { productType, width, height, thickness, edgeRTop, edgeRBot }. */
export async function exportProductGLB(spec) {
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

  const blob = await toGLBBlob(wrapForExport(mesh));
  geometry.dispose();
  material.dispose();
  return blob;
}
