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
 * (the source object is cloned, never reparented) -- the rotation also
 * puts the model's footprint centered on X/Z with its base at Y=0 (ground
 * plane), since the source geometry is already centered on X/Y with its
 * base at Z=0.
 *
 * updateMatrixWorld(true) is not optional here: this wrapper is never
 * added to a rendered scene, so matrixWorld is never recomputed on its
 * own (three.js only refreshes it during a render pass or an explicit
 * call). GLTFExporter happened to still work without this -- it reads
 * each node's own LOCAL .matrix and rebuilds the hierarchy -- but
 * USDZExporter's buildXform() reads object.matrixWorld directly. Without
 * this call that stayed a stale identity matrix (copied as-is from the
 * live, untransformed viewport scene), so the USDZ handed to iOS AR
 * Quick Look shipped raw Z-up millimeters with NO rotation and NO mm->m
 * scale: the model rendered ~1000x oversized and lying on its side,
 * exactly the reported bug. The in-panel <model-viewer> preview and
 * Android Scene Viewer never showed this because both consume the GLB,
 * not the USDZ. */
function wrapForExport(object3D, { layFlat = false, layFlatAxis = "x" } = {}) {
  const wrapper = new THREE.Group();
  wrapper.rotation.x = -Math.PI / 2; // Z-up -> Y-up, base-down (the correct AR default)
  if (layFlat) {
    // AR-display-only alternate view, opt-in via the panel's "Lay flat"
    // toggle, applied on top of the correct base-down transform above --
    // never a substitute for it. Which local axis to tip about depends on
    // what "flat" means for the shape being exported, so callers choose:
    //
    // - layFlatAxis "x" (tray): tips 90 deg about the now-horizontal local
    //   X axis so it rests on its long side instead of its base.
    // - layFlatAxis "y" (product): buildProductMesh's default orientation
    //   already stands the product on edge (its thickness axis horizontal,
    //   along local X, matching fill.js's packed-row convention) -- tipping
    //   about X would just spin it around that same horizontal axis and do
    //   nothing visible. Rotating -90 deg about local Y instead swings the
    //   thickness axis from horizontal to vertical (world Y), landing the
    //   product flat on its broad face with both footprint dimensions
    //   staying horizontal, for round AND rectangle products alike.
    //
    // See wrapForExport's centering step below for why this stays
    // correctly grounded after either tip.
    if (layFlatAxis === "y") {
      wrapper.rotateY(-Math.PI / 2);
    } else {
      wrapper.rotateX(Math.PI / 2);
    }
  }
  wrapper.scale.setScalar(0.001); // mm -> m
  wrapper.add(object3D);
  wrapper.updateMatrixWorld(true);

  // Re-center the footprint on X/Z and rest the base on the ground plane
  // (Y=0), computed from the actual transformed bounds rather than assumed
  // from the source mesh's own authoring symmetry. AR anchors the model's
  // origin at the tapped surface point, so any pivot drift here is exactly
  // what makes a model "place behind where I point" -- this also keeps the
  // optional lay-flat tip above resting on the ground instead of sinking
  // through it (tipping about the origin would otherwise leave half the
  // model below Y=0).
  const box = new THREE.Box3().setFromObject(wrapper);
  if (isFinite(box.min.x)) {
    const center = box.getCenter(new THREE.Vector3());
    wrapper.position.set(-center.x, -box.min.y, -center.z);
    wrapper.updateMatrixWorld(true);
  }
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
 * when `fillGroup` is given, merges a clone of it in too -- so the AR model
 * can be viewed either empty or loaded with product, matching the in-app 3D
 * view. `fillGroup` is passed in explicitly by the caller (built fresh via
 * fill.js's buildFillGroup()) rather than read from viewer.fillGroup: the
 * live viewport's fill overlay is only populated while the main viewport's
 * OWN "Fill" toggle is on, which is a separate, unrelated control from the
 * AR panel's "Show product fill" toggle -- reading viewer.fillGroup here
 * meant AR fill silently stayed empty whenever the viewport toggle happened
 * to be off, even with the AR toggle on. */
function buildTrayExportScene(viewer, fillGroup) {
  if (!viewer.meshGroup.children.length) throw new Error("No tray built yet");
  const scene = new THREE.Group();
  scene.add(viewer.meshGroup.clone(true));
  if (fillGroup) scene.add(fillGroup.clone(true));
  return scene;
}

export async function exportTrayGLB(viewer, fillGroup = null, layFlat = false) {
  return toGLBBlob(wrapForExport(buildTrayExportScene(viewer, fillGroup), { layFlat }));
}

export async function exportTrayUSDZ(viewer, fillGroup = null, layFlat = false) {
  return toUSDZBlob(wrapForExport(buildTrayExportScene(viewer, fillGroup), { layFlat }));
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

export async function exportProductGLB(spec, layFlat = false) {
  const mesh = buildProductMesh(spec);
  const blob = await toGLBBlob(wrapForExport(mesh, { layFlat, layFlatAxis: "y" }));
  mesh.geometry.dispose();
  mesh.material.dispose();
  return blob;
}

export async function exportProductUSDZ(spec, layFlat = false) {
  const mesh = buildProductMesh(spec);
  const blob = await toUSDZBlob(wrapForExport(mesh, { layFlat, layFlatAxis: "y" }));
  mesh.geometry.dispose();
  mesh.material.dispose();
  return blob;
}
