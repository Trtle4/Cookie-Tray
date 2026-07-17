/**
 * three.js scene: camera, controls, lighting, and rendering of the replicad
 * mesh (+ crisp edges) returned by the worker. Visualization only.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f4f6);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(250, -300, 220);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;

    // Cross-section clipping state. The plane is applied (or not) to both
    // the tray mesh material and every product-fill material.
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.clippingEnabled = false;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;

    const grid = new THREE.GridHelper(600, 30, 0xaaaaaa, 0xdddddd);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(1, -1, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, 1, 1);
    this.scene.add(fill);

    this.meshGroup = new THREE.Group();
    this.scene.add(this.meshGroup);

    this.fillGroup = new THREE.Group();
    this.scene.add(this.fillGroup);

    this._resize();
    window.addEventListener("resize", () => this._resize());
    this._animate();
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Replace the displayed solid with a fresh replicad mesh + edge set. */
  setShape({ mesh, edges }) {
    for (const child of [...this.meshGroup.children]) {
      child.geometry.dispose();
      child.material.dispose();
      this.meshGroup.remove(child);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
    geometry.setIndex(mesh.triangles);

    const material = new THREE.MeshStandardMaterial({
      color: 0xd6dbe2,
      metalness: 0.05,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    this.meshGroup.add(new THREE.Mesh(geometry, material));

    if (edges && edges.lines && edges.lines.length) {
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edges.lines, 3));
      const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2b2f36 });
      this.meshGroup.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
    }

    this._frame(geometry);
    this._applyClipping();
  }

  _frame(geometry) {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere || !isFinite(sphere.radius) || sphere.radius === 0) return;
    const dist = sphere.radius * 2.6;
    const dir = new THREE.Vector3(1, -1.1, 0.85).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.controls.target.copy(sphere.center);
    this.camera.near = Math.max(dist / 200, 0.1);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
  }

  /** Replace the product-fill overlay group (or clear it if `group` is null). */
  setFillGroup(group) {
    for (const child of [...this.fillGroup.children]) {
      this.fillGroup.remove(child);
    }
    if (group) this.fillGroup.add(group);
    this._applyClipping();
  }

  // ---- Camera view buttons ----

  /** Union bounding box of everything currently displayed (tray + fill), in world space.
   * Traverses recursively — the fill overlay is a Group of Meshes nested one
   * level under fillGroup, not direct children. */
  _combinedBoundingBox() {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let has = false;
    for (const group of [this.meshGroup, this.fillGroup]) {
      group.traverse((child) => {
        if (!child.geometry) return;
        child.geometry.computeBoundingBox();
        if (!child.geometry.boundingBox) return;
        const b = child.geometry.boundingBox.clone();
        b.applyMatrix4(child.matrixWorld);
        if (!has) {
          box.copy(b);
          has = true;
        } else {
          box.union(b);
        }
      });
    }
    return has ? box : null;
  }

  /** Snap the camera to a named view (top/bottom/front/side/iso), re-fit to
   * the current model bounds. Orbit controls stay interactive afterward.
   * Eases into position (respects prefers-reduced-motion). */
  setCameraView(view) {
    const box = this._combinedBoundingBox();
    if (!box) return;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    if (!isFinite(sphere.radius) || sphere.radius === 0) return;

    const dist = sphere.radius * 2.6;
    let dir, up;
    switch (view) {
      case "top":
        dir = new THREE.Vector3(0, 0, 1);
        up = new THREE.Vector3(0, 1, 0);
        break;
      case "bottom":
        dir = new THREE.Vector3(0, 0, -1);
        up = new THREE.Vector3(0, 1, 0);
        break;
      case "front":
        dir = new THREE.Vector3(0, -1, 0);
        up = new THREE.Vector3(0, 0, 1);
        break;
      case "side":
        dir = new THREE.Vector3(1, 0, 0);
        up = new THREE.Vector3(0, 0, 1);
        break;
      case "iso":
      default:
        dir = new THREE.Vector3(1, -1.1, 0.85).normalize();
        up = new THREE.Vector3(0, 0, 1);
        break;
    }

    this.camera.near = Math.max(dist / 200, 0.1);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();

    const targetPos = sphere.center.clone().addScaledVector(dir, dist);
    this._animateCameraTo(targetPos, sphere.center.clone(), up);
  }

  /** Ease the camera from its current position/target to a new one over a
   * short duration (ease-out cubic). Skips straight to the end state when
   * the user has requested reduced motion. `up` is switched immediately
   * (interpolating it mid-flight reads as an unwanted roll). */
  _animateCameraTo(targetPos, targetLookAt, targetUp, duration = 350) {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.camera.up.copy(targetUp);

    if (reduceMotion) {
      this.camera.position.copy(targetPos);
      this.controls.target.copy(targetLookAt);
      this.controls.update();
      return;
    }

    if (this._camAnimFrame) cancelAnimationFrame(this._camAnimFrame);
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const t0 = performance.now();

    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(startPos, targetPos, eased);
      this.controls.target.lerpVectors(startTarget, targetLookAt, eased);
      this.controls.update();
      this._camAnimFrame = t < 1 ? requestAnimationFrame(step) : null;
    };
    this._camAnimFrame = requestAnimationFrame(step);
  }

  /** Bounding box of the tray SOLID only (not the product-fill overlay) --
   * used for dimension callouts, which describe the exported tray itself,
   * not incidentally-oversized product visualization. */
  getTrayBoundingBox() {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let has = false;
    this.meshGroup.traverse((child) => {
      if (!child.geometry) return;
      child.geometry.computeBoundingBox();
      if (!child.geometry.boundingBox) return;
      const b = child.geometry.boundingBox.clone();
      b.applyMatrix4(child.matrixWorld);
      if (!has) {
        box.copy(b);
        has = true;
      } else {
        box.union(b);
      }
    });
    return has ? box : null;
  }

  /** Project a world-space point to CSS-pixel coordinates relative to the
   * canvas's own bounding rect, for HTML/SVG overlays positioned atop the
   * WebGL canvas. Returns null if the point projects behind the camera. */
  projectToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return null;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((1 - v.y) / 2) * rect.height,
    };
  }

  // ---- Cross-section ----

  /** Enable/disable the clipping plane on both tray and product materials. */
  setSectionEnabled(enabled) {
    this.clippingEnabled = enabled;
    this._applyClipping();
  }

  /** Position the clipping plane: `axis` is "X"/"Y"/"Z" (plane normal), and
   * `fraction` (0..1) is the cut position across the current model bounds
   * along that axis. Keeps the low-coordinate half visible. */
  setSectionPlane(axis, fraction) {
    const box = this._combinedBoundingBox();
    if (!box) return;
    const axisKey = axis === "Y" ? "y" : axis === "Z" ? "z" : "x";
    const min = box.min[axisKey];
    const max = box.max[axisKey];
    const pos = min + (max - min) * fraction;

    const normal = new THREE.Vector3(
      axisKey === "x" ? -1 : 0,
      axisKey === "y" ? -1 : 0,
      axisKey === "z" ? -1 : 0
    );
    this.clipPlane.normal.copy(normal);
    this.clipPlane.constant = pos;
    this._applyClipping();
  }

  _applyClipping() {
    const planes = this.clippingEnabled ? [this.clipPlane] : [];
    for (const group of [this.meshGroup, this.fillGroup]) {
      group.traverse((child) => {
        if (!child.material) return;
        child.material.clippingPlanes = planes;
        if (this.clippingEnabled) child.material.side = THREE.DoubleSide;
      });
    }
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.renderer.dispose();
  }
}
