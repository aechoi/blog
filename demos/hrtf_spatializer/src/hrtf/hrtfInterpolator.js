import { createMeshQuery } from "./tetrahedralMesh.js";
import { azElRToXYZ } from "./coords.js";

// Runs the (slow, synchronous) tetrahedral mesh build in a Web Worker so
// it doesn't freeze the page, and so real progress-by-stage can be
// reported back while it runs.
function buildMeshInWorker(positions, cullFactor, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tetrahedralMesh.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "progress") {
        onProgress?.(msg.stage);
      } else if (msg.type === "done") {
        worker.terminate();
        resolve(msg.data);
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ positions, cullFactor });
  });
}

// Wraps a loaded SOFA dataset (from sofaLoader.js) with the tetrahedral
// mesh + barycentric search, exposing getIR(az, el, r): the left/right
// impulse responses blended from the nearest 4 measurements by their
// barycentric weights.
//
// Keeps the last tetrahedron found across calls and seeds the next search
// there. For continuous motion — the normal case, since this tracks one
// source moving frame to frame rather than jumping to arbitrary points —
// that resolves in 0-1 hops instead of walking the mesh from scratch each
// time (confirmed empirically: a 720-step continuous sweep averaged 0.48
// hops per query).
export async function createHrtfInterpolator(hrtf, { cullFactor = 2, onProgress } = {}) {
  const meshData = await buildMeshInWorker(hrtf.positions, cullFactor, onProgress);
  const mesh = createMeshQuery(meshData);
  let lastTet = 0;

  function getIR(az, el, r) {
    const p = azElRToXYZ(az, el, r);
    const { tetIndex, weights } = mesh.search([p.x, p.y, p.z], lastTet);
    lastTet = tetIndex;

    const left = new Float32Array(hrtf.irLength);
    const right = new Float32Array(hrtf.irLength);
    if (!weights) return { left, right }; // no usable tet found; silence rather than garbage

    const verts = mesh.tets[tetIndex];
    for (let k = 0; k < 4; k++) {
      const w = weights[k];
      if (w === 0) continue;
      const origIndex = mesh.originalIndexOf(verts[k]);
      const leftSource = hrtf.leftIRs[origIndex];
      const rightSource = hrtf.rightIRs[origIndex];
      for (let s = 0; s < hrtf.irLength; s++) {
        left[s] += w * leftSource[s];
        right[s] += w * rightSource[s];
      }
    }
    return { left, right };
  }

  return { getIR, mesh };
}
