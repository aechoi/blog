import { buildTetrahedralMeshData } from "./tetrahedralMesh.js";

self.onmessage = (event) => {
  const { positions, cullFactor } = event.data;
  try {
    const data = buildTetrahedralMeshData(positions, {
      cullFactor,
      onProgress: (stage) => self.postMessage({ type: "progress", stage }),
    });
    // Transfer the big point-coordinate buffer instead of copying it.
    self.postMessage({ type: "done", data }, [data.points.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};
