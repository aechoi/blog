import * as THREE from "three";
import { azElRToXYZ } from "../hrtf/coords.js";

// All sizes here are in scene units, unrelated to the audio "r" range
// (meters) — the head is always radius 1, and source distance is
// remapped into a fixed display range so it's always framed nicely
// regardless of the actual r value. This is a schematic view, not a
// to-scale one — consistent with the polar plot and sliders, which
// don't render true distance either.
const HEAD_RADIUS = 1;
const DISPLAY_R_MIN = 1.4;
const DISPLAY_R_MAX = 4;

// Standard X=red/Y=green/Z=blue convention, not the az/el/r palette
// used elsewhere — these are Cartesian components, not those channels.
const AXIS_X_COLOR = 0xe6403f;
const AXIS_Y_COLOR = 0x2e9e5b;
const AXIS_Z_COLOR = 0x3b6ea5;
const MARKER_COLOR = 0xe8562c; // matches the "now" marker used elsewhere

const INITIAL_CAMERA_RADIUS = Math.hypot(4.8, 8.3);
const INITIAL_CAMERA_PHI = Math.acos(4.8 / INITIAL_CAMERA_RADIUS); // from +Y axis
const INITIAL_CAMERA_THETA = 0; // starts directly behind (+Z)
const MIN_PHI = (5 * Math.PI) / 180;
const MAX_PHI = (175 * Math.PI) / 180;
const ORBIT_SENSITIVITY = 0.006;

// Sprites are always camera-facing in three.js (billboards) — exactly
// what "legible no matter how the model orbits" needs, no extra work.
function makeLabelSprite(text, color) {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 46px system-ui, sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
  sprite.scale.set(0.45, 0.45, 1);
  return sprite;
}

export function createHeadView(canvas, { store, rMin, rMax }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  const scene = new THREE.Scene();

  // Camera orbits (middle-mouse drag) around the head at a fixed
  // distance, tracked in spherical coordinates. Starts behind (+Z,
  // since front is -Z) and above the head, matching the original fixed
  // framing; pulled back further than a "natural" distance so the head
  // reads as smaller in the viewport without shrinking the geometry
  // itself — every other size in the scene stays in the same
  // proportion to the head as before.
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  let cameraTheta = INITIAL_CAMERA_THETA;
  let cameraPhi = INITIAL_CAMERA_PHI;

  function updateCameraFromSpherical() {
    const r = INITIAL_CAMERA_RADIUS;
    camera.position.set(
      r * Math.sin(cameraPhi) * Math.sin(cameraTheta),
      r * Math.cos(cameraPhi),
      r * Math.sin(cameraPhi) * Math.cos(cameraTheta)
    );
    camera.lookAt(0, 0, 0);
  }
  updateCameraFromSpherical();

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(2, 4, 3);
  scene.add(keyLight);

  const grid = new THREE.GridHelper(14, 14, 0xcccccc, 0xe8e8e8);
  scene.add(grid);

  const headGroup = new THREE.Group();
  const headMaterial = new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.85 });
  const featureMaterial = new THREE.MeshStandardMaterial({ color: 0x3a2e28, roughness: 0.6 });

  headGroup.add(new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 32, 24), headMaterial));

  const earGeometry = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 16);
  const leftEar = new THREE.Mesh(earGeometry, headMaterial);
  leftEar.rotation.z = Math.PI / 2;
  leftEar.position.set(-HEAD_RADIUS, 0, 0);
  headGroup.add(leftEar);

  const rightEar = new THREE.Mesh(earGeometry, headMaterial);
  rightEar.rotation.z = Math.PI / 2;
  rightEar.position.set(HEAD_RADIUS, 0, 0);
  headGroup.add(rightEar);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 16), headMaterial);
  nose.rotation.x = -Math.PI / 2; // point the cone's tip toward -Z (front)
  nose.position.set(0, -0.05, -HEAD_RADIUS + 0.1);
  headGroup.add(nose);

  // Rudimentary face on the front (az=0) of the head: two eye dots and
  // a flattened mouth bar, placed via the same az/el convention as
  // everything else so "front" is unambiguous.
  function facePoint(az, el) {
    const { x, y, z } = azElRToXYZ(az, el, HEAD_RADIUS + 0.03);
    return new THREE.Vector3(x, y, z);
  }
  const eyeGeometry = new THREE.SphereGeometry(0.09, 12, 10);
  const leftEye = new THREE.Mesh(eyeGeometry, featureMaterial);
  leftEye.position.copy(facePoint(-18, 12));
  headGroup.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeometry, featureMaterial);
  rightEye.position.copy(facePoint(18, 12));
  headGroup.add(rightEye);

  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.05), featureMaterial);
  mouth.position.copy(facePoint(0, -22));
  headGroup.add(mouth);

  // L/R ear labels — sprites always face the camera, so these stay
  // legible through any orbit angle without extra tracking logic.
  const leftLabel = makeLabelSprite("L", "#2e2e2e");
  leftLabel.position.set(-(HEAD_RADIUS + 0.4), 0, 0);
  headGroup.add(leftLabel);

  const rightLabel = makeLabelSprite("R", "#2e2e2e");
  rightLabel.position.set(HEAD_RADIUS + 0.4, 0, 0);
  headGroup.add(rightLabel);

  scene.add(headGroup);

  // Source position as a color-coded X -> Y -> Z component path from
  // the head center, plus a marker dot at the source itself. The
  // position buffer is preallocated and written into directly on every
  // render() (see setLineEndpoints below) instead of rebuilding the
  // geometry from fresh Vector3s each frame — this runs on every
  // playhead tick during playback, so avoiding three new Vector3s +  a
  // new backing array per line, per frame, cuts a steady stream of
  // GC churn that repeated at 60+ times a second otherwise. Skips
  // automatic bounding-sphere recomputation too, so frustum culling is
  // turned off for these — cheap to leave always-visible in a scene this
  // small anyway.
  function makeLine(color) {
    const positions = new Float32Array(6); // 2 endpoints * xyz
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
    line.frustumCulled = false;
    return line;
  }
  function setLineEndpoints(line, x0, y0, z0, x1, y1, z1) {
    const pos = line.geometry.attributes.position.array;
    pos[0] = x0;
    pos[1] = y0;
    pos[2] = z0;
    pos[3] = x1;
    pos[4] = y1;
    pos[5] = z1;
    line.geometry.attributes.position.needsUpdate = true;
  }
  const xLine = makeLine(AXIS_X_COLOR);
  const yLine = makeLine(AXIS_Y_COLOR);
  const zLine = makeLine(AXIS_Z_COLOR);
  scene.add(xLine, yLine, zLine);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshBasicMaterial({ color: MARKER_COLOR })
  );
  scene.add(marker);

  function displaySourcePosition() {
    if (!store.state.path) return azElRToXYZ(0, 0, DISPLAY_R_MIN);
    const pos = store.getPositionAt(store.state.playhead);
    const frac = (Math.min(rMax, Math.max(rMin, pos.r)) - rMin) / (rMax - rMin);
    return azElRToXYZ(pos.az, pos.el, DISPLAY_R_MIN + frac * (DISPLAY_R_MAX - DISPLAY_R_MIN));
  }

  let lastWidth = 0;
  let lastHeight = 0;
  function resizeToDisplaySize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width !== lastWidth || height !== lastHeight) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }
    return { width, height };
  }

  function render() {
    const { width, height } = resizeToDisplaySize();
    if (width <= 1 || height <= 1) return;

    const { x, y, z } = displaySourcePosition();
    setLineEndpoints(xLine, 0, 0, 0, x, 0, 0);
    setLineEndpoints(yLine, x, 0, 0, x, y, 0);
    setLineEndpoints(zLine, x, y, 0, x, y, z);
    marker.position.set(x, y, z);

    renderer.render(scene, camera);
  }

  store.subscribe((event) => {
    if (
      event.type === "audio-loaded" ||
      event.type === "playhead-changed" ||
      event.type === "play-state-changed" ||
      event.type === "path-changed"
    ) {
      render();
    }
  });

  // Orbit: middle-mouse drag only, so it doesn't compete with any
  // future left/right-click interaction on this view. Distance is
  // fixed — only the viewing angle changes.
  let orbiting = false;
  let lastClientX = 0;
  let lastClientY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // suppress the browser's middle-click autoscroll
    orbiting = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!orbiting) return;
    const deltaX = e.clientX - lastClientX;
    const deltaY = e.clientY - lastClientY;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    cameraTheta -= deltaX * ORBIT_SENSITIVITY;
    cameraPhi = Math.min(MAX_PHI, Math.max(MIN_PHI, cameraPhi - deltaY * ORBIT_SENSITIVITY));
    updateCameraFromSpherical();
    render();
  });

  function endOrbit(e) {
    if (!orbiting) return;
    orbiting = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be gone; nothing to clean up
    }
  }
  canvas.addEventListener("pointerup", endOrbit);
  canvas.addEventListener("pointercancel", endOrbit);
  window.addEventListener("blur", () => {
    orbiting = false;
  });

  new ResizeObserver(render).observe(canvas);
  render();
}
