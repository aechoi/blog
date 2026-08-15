// az/el/r -> Cartesian, shared by everything that needs this app's spatial
// convention: front (az=0) = -Z, right (az=90) = +X, up (el=90) = +Y.
export function azElRToXYZ(az, el, r) {
  const azRad = (az * Math.PI) / 180;
  const elRad = (el * Math.PI) / 180;
  return {
    x: r * Math.cos(elRad) * Math.sin(azRad),
    y: r * Math.sin(elRad),
    z: -r * Math.cos(elRad) * Math.cos(azRad),
  };
}
