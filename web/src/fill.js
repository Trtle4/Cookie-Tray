/**
 * three.js "product fill" overlay — visualization only, NEVER fused into the
 * exported solid. Draws the defined product (round cookies or rounded-edge
 * rectangular product, packed face-to-face down each channel) at true size
 * so overflow visibly means "doesn't fit."
 *
 * Every product's LOWEST point rests exactly at the cell floor (z = floor),
 * independent of cradle_r — a rounded cradle bottom that is tighter or
 * looser than the product's own cross-section must not make it float or
 * sink relative to the actual resting surface.
 */

import * as THREE from "three";

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
function rectProductGeometry(width, height, thickness, edgeRTop, edgeRBot) {
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
  const material = new THREE.MeshStandardMaterial({
    color: 0xd4a76a,
    transparent: true,
    opacity: 0.55,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });

  let geometry, packPitch, centerZOffset;
  if (productType === "rectangle") {
    packPitch = productThickness;
    centerZOffset = productHeight / 2; // bottom face at floor -> center_z = floor + height/2
    geometry = rectProductGeometry(productWidth, productHeight, productThickness, edgeRTop, edgeRBot);
  } else {
    packPitch = cookieThickness;
    centerZOffset = cookieDiameter / 2; // lowest point at floor -> center_z = floor + diameter/2
    geometry = new THREE.CylinderGeometry(cookieDiameter / 2, cookieDiameter / 2, cookieThickness, 48);
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
