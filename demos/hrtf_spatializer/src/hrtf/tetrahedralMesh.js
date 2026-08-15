import triangulate from "https://esm.sh/delaunay-triangulate@1.1.6";
import { azElRToXYZ } from "./coords.js";

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    [(e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [(f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
  ];
}

function applyMatVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function faceKey(a, b, c) {
  return [a, b, c].sort((x, y) => x - y).join(",");
}

// Builds a tetrahedral mesh over a set of {az, el, r} measurement
// positions, for barycentric interpolation of the nearest 4 measurements
// to any query direction/distance.
//
// Most HRTF sets are measured at a single distance, which makes a plain 3D
// Delaunay triangulation degenerate: co-spherical points lift to a
// hyperplane under the standard paraboloid-lifting construction that
// Delaunay-via-convex-hull algorithms use, collapsing every "tetrahedron"
// to zero volume. The fix — the same one the old Python prototype used —
// is to duplicate every point outward by a small radial offset
// ("meanFreePath", sized to roughly match the points' own angular spacing
// so the resulting tetrahedra have a sane aspect ratio), so the
// triangulation runs over two concentric shells instead of one flat one.
// The outer shell is literally a copy of the same measurements — it
// exists only to give the tetrahedra real volume to search/interpolate
// within, not to add new directions.
//
// A handful of sets (near-field HRTFs) are genuinely measured at several
// distances instead, and that needs the opposite treatment: they already
// have real 3D structure, so duplicating every point outward on top of
// that doesn't fix a degeneracy that isn't there — it was found
// empirically to actively cause one instead (every tetrahedron computing
// as zero-volume, 100% of the time, tested against a real multi-distance
// SOFA file). The likely mechanism: near-field sets typically reuse the
// same angular grid at every measured distance, so for any one direction
// there are already several real points stacked along a single ray from
// the origin; adding a synthetic outer copy of each of those (also along
// that same ray) piles on much more of that collinear structure, which
// is exactly what tips a numerically-sensitive Delaunay implementation
// into degeneracy. Detecting "does r actually vary" and skipping the
// duplication for that case — using a small random jitter instead, just
// to break any incidental exact coplanarity/collinearity between shells
// — avoids the problem rather than working around its symptoms.
//
// `cullFactor` keeps every Nth point before building the mesh. Full
// density (cullFactor: 1) is the most faithful to the measured data, but
// the triangulation is a one-time, synchronous, distinctly-not-fast
// operation (seconds, on a several-thousand-point mesh) — culling trades
// some of that angular resolution for a proportionally faster build.
//
// Returns plain, structured-cloneable data only (no closures) — this is
// deliberate so the expensive part can run inside a Web Worker and the
// result posted straight back via postMessage. Wrap the result with
// `createMeshQuery` to get the actual search/lookup functions.
export function buildTetrahedralMeshData(positions, { cullFactor = 2, onProgress } = {}) {
  const report = (stage) => onProgress?.(stage);

  report("preparing-points");
  const culledPositions = [];
  const originalIndexByCulled = [];
  for (let i = 0; i < positions.length; i++) {
    if (i % cullFactor === 0) {
      culledPositions.push(positions[i]);
      originalIndexByCulled.push(i);
    }
  }
  const M = culledPositions.length;

  const radii = culledPositions.map((p) => p.r);
  const minR = Math.min(...radii);
  const maxR = Math.max(...radii);
  const meanR = (minR + maxR) / 2;
  // 2% tolerance comfortably covers ordinary measurement noise around a
  // single nominal distance while still catching genuine near-field sets,
  // whose distances typically differ by 2x or more.
  const isSingleShell = meanR === 0 || (maxR - minR) / meanR < 0.02;

  let points;
  if (isSingleShell) {
    const meanFreePath = (4 * maxR) / Math.sqrt(M);
    points = new Float64Array(2 * M * 3);
    for (let m = 0; m < M; m++) {
      const p = culledPositions[m];
      const inner = azElRToXYZ(p.az, p.el, p.r);
      const outer = azElRToXYZ(p.az, p.el, p.r + meanFreePath);
      points[m * 3] = inner.x;
      points[m * 3 + 1] = inner.y;
      points[m * 3 + 2] = inner.z;
      points[(M + m) * 3] = outer.x;
      points[(M + m) * 3 + 1] = outer.y;
      points[(M + m) * 3 + 2] = outer.z;
    }
  } else {
    // meanFreePath here is repurposed as a rough spacing estimate — the
    // jitter only needs to be big enough to break exact numerical ties,
    // not to add real volume, so it's scaled far smaller (1/1000th).
    const jitterScale = ((4 * maxR) / Math.sqrt(M)) * 1e-3;
    points = new Float64Array(M * 3);
    for (let m = 0; m < M; m++) {
      const p = culledPositions[m];
      const xyz = azElRToXYZ(p.az, p.el, p.r);
      points[m * 3] = xyz.x + (Math.random() - 0.5) * jitterScale;
      points[m * 3 + 1] = xyz.y + (Math.random() - 0.5) * jitterScale;
      points[m * 3 + 2] = xyz.z + (Math.random() - 0.5) * jitterScale;
    }
  }
  const pointCount = points.length / 3;

  report("triangulating");
  const pointList = new Array(pointCount);
  for (let i = 0; i < pointCount; i++) pointList[i] = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  const tets = triangulate(pointList);

  // Face-adjacency: neighbors[t][k] = the tet sharing the face opposite
  // vertex k of tet t (i.e. built from the other 3 vertices), or -1 at the
  // hull boundary. This matches the convention scipy.spatial.Delaunay
  // uses, which is what the tet-walk search relies on: at each hop it
  // moves across the face opposite whichever vertex has the most negative
  // barycentric weight.
  report("computing-adjacency");
  const faceMap = new Map();
  for (let ti = 0; ti < tets.length; ti++) {
    const verts = tets[ti];
    for (let excl = 0; excl < 4; excl++) {
      const face = verts.filter((_, i) => i !== excl);
      const key = faceKey(face[0], face[1], face[2]);
      let entry = faceMap.get(key);
      if (!entry) faceMap.set(key, (entry = []));
      entry.push([ti, excl]);
    }
  }
  const neighbors = tets.map(() => [-1, -1, -1, -1]);
  for (const entries of faceMap.values()) {
    if (entries.length === 2) {
      const [[ti0, e0], [ti1, e1]] = entries;
      neighbors[ti0][e0] = ti1;
      neighbors[ti1][e1] = ti0;
    }
  }

  // Precompute the barycentric-coordinate matrix per tet so each hop
  // during search is a matrix-vector multiply, not a linear solve.
  // Vertices [v0,v1,v2,v3] -> weights [g1,g2,g3,g4] with
  // point = g1*v0 + g2*v1 + g3*v2 + g4*v3, g4 = 1-g1-g2-g3.
  report("precomputing-interpolation-matrices");
  const tetTinv = new Array(tets.length);
  for (let ti = 0; ti < tets.length; ti++) {
    const [ia, ib, ic, id] = tets[ti];
    const v0 = pointList[ia];
    const v1 = pointList[ib];
    const v2 = pointList[ic];
    const v3 = pointList[id];
    const T = [
      [v0[0] - v3[0], v1[0] - v3[0], v2[0] - v3[0]],
      [v0[1] - v3[1], v1[1] - v3[1], v2[1] - v3[1]],
      [v0[2] - v3[2], v1[2] - v3[2], v2[2] - v3[2]],
    ];
    tetTinv[ti] = invert3x3(T);
  }

  report("done");
  return { tets, neighbors, tetTinv, points, originalIndexByCulled, measurementCount: M };
}

// Wraps the plain data from buildTetrahedralMeshData with the actual
// query functions. Cheap and synchronous — meant to run wherever the data
// ends up (e.g. the main thread, after receiving it from a worker).
export function createMeshQuery(data) {
  const { tets, neighbors, tetTinv, points, originalIndexByCulled, measurementCount } = data;

  function vertexAt(i) {
    return [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  }

  function barycentricIn(ti, point) {
    const inv = tetTinv[ti];
    if (!inv) return null;
    const id = tets[ti][3];
    const g = applyMatVec(inv, subtract(point, vertexAt(id)));
    return [g[0], g[1], g[2], 1 - g[0] - g[1] - g[2]];
  }

  // Walks the adjacency graph from `startTet` toward the tetrahedron
  // containing `point`, moving each step across the face with the most
  // negative barycentric weight (the direction the point is "outside"
  // that tet the most). Seeding from the previously found tet is what
  // makes this cheap for continuous motion — see hrtfInterpolator.js.
  // A point outside the whole mesh (e.g. r far beyond the measured shell)
  // walks to the hull boundary and stops there, using that boundary tet's
  // (partly invalid, but direction-dominated) weights as a best effort
  // rather than failing.
  function search(point, startTet = 0, maxIterations = 10000) {
    let ti = Math.max(0, Math.min(tets.length - 1, startTet));
    for (let iter = 0; iter < maxIterations; iter++) {
      const weights = barycentricIn(ti, point);
      if (!weights) {
        const fallback = neighbors[ti].find((n) => n >= 0);
        if (fallback === undefined) return { tetIndex: ti, weights: null, iterations: iter };
        ti = fallback;
        continue;
      }
      let worst = 0;
      for (let k = 1; k < 4; k++) if (weights[k] < weights[worst]) worst = k;
      if (weights[worst] >= -1e-9) return { tetIndex: ti, weights, iterations: iter };
      const next = neighbors[ti][worst];
      if (next < 0) return { tetIndex: ti, weights, iterations: iter };
      ti = next;
    }
    return { tetIndex: ti, weights: barycentricIn(ti, point), iterations: maxIterations };
  }

  // Combined-point index (into however many shells the mesh has — 2 for
  // the single-shell/sheath case, 1 for genuine multi-distance data) ->
  // index into the *original* (uncalled) positions array the mesh was
  // built from, so callers can map a tet's vertices straight back to
  // whatever data they key by measurement. Every shell repeats the same
  // M culled points in the same order, so this is just wraparound.
  function originalIndexOf(combinedIndex) {
    const culledIndex = combinedIndex % measurementCount;
    return originalIndexByCulled[culledIndex];
  }

  return { tets, neighbors, tetCount: tets.length, measurementCount, search, originalIndexOf };
}
