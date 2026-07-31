/**
 * three.js "product fill" overlay — visualization only, NEVER fused into the
 * exported solid. Draws the defined product (round cookies or rounded-edge
 * rectangular product, packed face-to-face down each channel) at true size
 * so overflow visibly means "doesn't fit."
 *
 * Every product rests on the cell floor (z = floor), independent of
 * cradle_r — a rounded cradle bottom that is tighter or looser than the
 * product's own cross-section must not make it float or sink relative to
 * the actual resting surface. Lifted by RESTING_EPS (a few hundredths of a
 * mm — imperceptible) above exact floor contact so the product surface is
 * never exactly coincident with the cradle surface, which otherwise
 * z-fights/flickers wherever the two are geometrically tangent (most
 * visibly when cradle_r matches the product's own radius, the common case).
 */

import * as THREE from "three";

const RESTING_EPS = 0.05; // mm -- a hair off the cradle surface, kills z-fighting

/** 2D rounded-rectangle profile (in the shape's local X/Y), independent
 * top-corner and bottom-corner radii, centered at the origin. */
function roundedRectShape(width, height, rTop, rBot) {
  const hw = width / 2;
  const hh = height / 2;
  const maxR = Math.min(width, height) / 2;
  const rt = Math.min(Math.max(rTop, 0), maxR);
  const rb = Math.min(Math.max(rBot, 0), maxR);

  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh + rb);
  shape.absarc(-hw + rb, -hh + rb, rb, Math.PI, Math.PI * 1.5, false); // bottom-left
  shape.lineTo(hw - rb, -hh);
  shape.absarc(hw - rb, -hh + rb, rb, Math.PI * 1.5, Math.PI * 2, false); // bottom-right
  shape.lineTo(hw, hh - rt);
  shape.absarc(hw - rt, hh - rt, rt, 0, Math.PI * 0.5, false); // top-right
  shape.lineTo(-hw + rt, hh);
  shape.absarc(-hw + rt, hh - rt, rt, Math.PI * 0.5, Math.PI, false); // top-left
  shape.closePath();
  return shape;
}

/** Rounded-rectangle product geometry: cross-section in the Y-Z plane
 * (width x height, with independent top/bottom corner radii), extruded
 * along the channel axis (local X) by `thickness`. Centered at the origin
 * on all three axes, matching CylinderGeometry's own centering convention. */
export function rectProductGeometry(width, height, thickness, edgeRTop, edgeRBot) {
  const shape = roundedRectShape(width, height, edgeRTop, edgeRBot);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 12 });
  geometry.translate(0, 0, -thickness / 2);
  // local X (shape width) -> world Y, local Y (shape height) -> world Z, local Z (extrusion) -> world X.
  geometry.applyMatrix4(
    new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))
  );
  return geometry;
}

/**
 * @param {object} args
 * @param {object} args.params - resolved TrayParams (camelCase)
 * @param {number} args.cookiesPerCell
 * @param {"round"|"rectangle"} [args.productType]
 * @param {number} [args.cookieDiameter]
 * @param {number} [args.cookieThickness]
 * @param {number} [args.productWidth]
 * @param {number} [args.productHeight]
 * @param {number} [args.productThickness]
 * @param {number} [args.edgeRTop]
 * @param {number} [args.edgeRBot]
 * @param {number} args.endClearance
 */
export function buildFillGroup({
  params,
  cookiesPerCell,
  productType = "round",
  cookieDiameter,
  cookieThickness,
  productWidth,
  productHeight,
  productThickness,
  edgeRTop = 0,
  edgeRBot = 0,
  endClearance,
}) {
  const { nCells, cellWid, cellLen, wall, divider, floor, longAxis } = params;
  const pitch = cellWid + divider; // matches TrayParams.pitch: cell center-to-center spacing
  const topW = nCells * cellWid + 2 * wall + (nCells - 1) * divider;

  const group = new THREE.Group();
  // Solid/opaque (not translucent): overlapping products and the cradle
  // surface previously caused z-fighting/sorting artifacts under three.js's
  // per-object transparent-pass sorting. Fully opaque routes rendering
  // through the normal per-pixel depth-tested pass instead, which resolves
  // overlapping geometry correctly regardless of draw order.
  const material = new THREE.MeshStandardMaterial({
    color: 0xd4a76a,
    transparent: false,
    opacity: 1,
    roughness: 0.6,
    side: THREE.DoubleSide,
    depthWrite: true,
  });

  // A small visible gap between consecutive products (viz-only): each
  // product's own RENDERED thickness is shaved slightly thinner than the
  // pack pitch it occupies, so a packed row reads as discrete pieces
  // instead of one continuous log. Centers/pitch/count/positions below are
  // still keyed on the true packPitch, untouched -- only the individual
  // mesh's thickness axis (extrusion depth / cylinder height) shrinks,
  // symmetrically, so it stays centered in its slot.
  const DIVIDER_GAP_FRACTION = 0.12;
  const MAX_DIVIDER_GAP = 0.8; // mm -- caps the gap so thick packs don't read as a missing piece

  let geometry, packPitch, centerZOffset;
  if (productType === "rectangle") {
    packPitch = productThickness;
    centerZOffset = productHeight / 2 + RESTING_EPS; // bottom face at floor (+ a hair)
    const gap = Math.min(MAX_DIVIDER_GAP, packPitch * DIVIDER_GAP_FRACTION);
    const renderThickness = Math.max(packPitch - gap, packPitch * 0.5);
    geometry = rectProductGeometry(productWidth, productHeight, renderThickness, edgeRTop, edgeRBot);
  } else {
    packPitch = cookieThickness;
    centerZOffset = cookieDiameter / 2 + RESTING_EPS; // lowest point at floor (+ a hair)
    const gap = Math.min(MAX_DIVIDER_GAP, packPitch * DIVIDER_GAP_FRACTION);
    const renderThickness = Math.max(packPitch - gap, packPitch * 0.5);
    geometry = new THREE.CylinderGeometry(cookieDiameter / 2, cookieDiameter / 2, renderThickness, 48);
  }

  // Build in the canonical (long axis = X) frame, then rotate the whole
  // group exactly like buildTray does for longAxis === "Y" — keeps the fill
  // guaranteed consistent with the actual solid instead of hand-swapping x/y.
  for (let j = 0; j < nCells; j++) {
    const cy = -topW / 2 + wall + cellWid / 2 + j * pitch;
    for (let k = 0; k < cookiesPerCell; k++) {
      const x = -cellLen / 2 + endClearance / 2 + packPitch * (k + 0.5);
      const mesh = new THREE.Mesh(geometry, material);
      if (productType === "round") {
        mesh.rotation.z = Math.PI / 2; // cylinder axis default is Y -> rotate onto X
      }
      mesh.position.set(x, cy, floor + centerZOffset);
      group.add(mesh);
    }
  }

  if (longAxis === "Y") {
    group.rotation.z = Math.PI / 2; // same rotation buildTray applies to the solid
  }

  return group;
}
