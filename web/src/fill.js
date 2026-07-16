/**
 * three.js "product fill" overlay — visualization only, NEVER fused into the
 * exported solid. Draws the defined product (round cookies, packed
 * face-to-face down each channel) at true size so overflow visibly means
 * "doesn't fit."
 */

import * as THREE from "three";

/**
 * @param {object} args
 * @param {object} args.params - resolved TrayParams (camelCase)
 * @param {number} args.cookiesPerCell
 * @param {number} args.cookieDiameter
 * @param {number} args.cookieThickness
 * @param {number} args.endClearance
 */
export function buildFillGroup({ params, cookiesPerCell, cookieDiameter, cookieThickness, endClearance }) {
  const { nCells, cellWid, cellLen, wall, floor, cradleR, longAxis } = params;
  const R = Math.min(cradleR, cellWid / 2);
  const topW = nCells * cellWid + (nCells + 1) * wall;

  const group = new THREE.Group();
  const geometry = new THREE.CylinderGeometry(cookieDiameter / 2, cookieDiameter / 2, cookieThickness, 48);
  const material = new THREE.MeshStandardMaterial({
    color: 0xd4a76a,
    transparent: true,
    opacity: 0.55,
    roughness: 0.6,
  });

  // Build in the canonical (long axis = X) frame, then rotate the whole
  // group exactly like buildTray does for longAxis === "Y" — keeps the fill
  // guaranteed consistent with the actual solid instead of hand-swapping x/y.
  for (let j = 0; j < nCells; j++) {
    const cy = -topW / 2 + wall + cellWid / 2 + j * (cellWid + wall);
    for (let k = 0; k < cookiesPerCell; k++) {
      const x = -cellLen / 2 + endClearance / 2 + cookieThickness * (k + 0.5);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.z = Math.PI / 2; // cylinder axis default is Y -> rotate onto X
      mesh.position.set(x, cy, floor + R);
      group.add(mesh);
    }
  }

  if (longAxis === "Y") {
    group.rotation.z = Math.PI / 2; // same rotation buildTray applies to the solid
  }

  return group;
}
