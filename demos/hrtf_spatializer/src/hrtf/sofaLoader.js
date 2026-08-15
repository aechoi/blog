import { ready, FS, File } from "h5wasm";

let fileCounter = 0;

// SOFA's azimuth (AES69 convention: 0°=front, increasing toward the LEFT
// ear) runs opposite to this app's azimuth (0°=front, increasing
// clockwise toward the RIGHT ear — see polarView.js/headView.js).
// Confirmed empirically against this project's own SOFA file: a
// measurement at SOFA az≈89° converts to a Cartesian point sitting almost
// entirely on the +Y side, and +Y is the side ReceiverPosition puts the
// left-ear receiver on. Converting here means every consumer of this
// loader's output only ever deals in this app's own az convention.
function sofaAzToAppAz(sofaAzDeg) {
  const az = -sofaAzDeg;
  return ((az + 180) % 360 + 360) % 360 - 180;
}

// Parses a SimpleFreeFieldHRIR SOFA file (the only convention this reads;
// SOFA also defines conventions for e.g. directional loudspeakers or
// general TF measurements that this project has no use for) into the
// az/el/r + left/right FIR data the interpolation and convolution pieces
// will need. `bytes` is the raw file content (from fetch or a file input).
export async function loadSofaFile(bytes, { name = "sofa-file" } = {}) {
  await ready;

  const path = `/sofa_${fileCounter++}_${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  FS.writeFile(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  let h5file;
  try {
    h5file = new File(path, "r");

    const convention = h5file.attrs.SOFAConventions?.value;
    if (convention !== "SimpleFreeFieldHRIR") {
      throw new Error(`Unsupported SOFA convention "${convention}" — only SimpleFreeFieldHRIR is supported`);
    }

    const sourcePositionDataset = h5file.get("SourcePosition");
    if (sourcePositionDataset.attrs.Type?.value !== "spherical") {
      throw new Error(`Unsupported SourcePosition type "${sourcePositionDataset.attrs.Type?.value}" — only spherical is supported`);
    }
    const [measurementCount] = sourcePositionDataset.shape;
    const sourcePositionValues = sourcePositionDataset.value;

    const receiverPositionValues = h5file.get("ReceiverPosition").value; // flat [2,3,1]: r0x,r0y,r0z,r1x,r1y,r1z
    // SOFA's +Y axis points toward the left ear; whichever receiver has
    // the larger Y is the left one.
    const leftReceiverIndex = receiverPositionValues[1] > receiverPositionValues[4] ? 0 : 1;
    const rightReceiverIndex = leftReceiverIndex === 0 ? 1 : 0;

    const irDataset = h5file.get("Data.IR");
    const [irMeasurementCount, irReceiverCount, irLength] = irDataset.shape;
    if (irMeasurementCount !== measurementCount || irReceiverCount !== 2) {
      throw new Error("Data.IR shape doesn't match SourcePosition/ReceiverPosition");
    }
    const irValues = irDataset.value; // flat [M, 2, N]

    const sampleRate = h5file.get("Data.SamplingRate").value[0];

    const positions = new Array(measurementCount);
    const leftIRs = new Array(measurementCount);
    const rightIRs = new Array(measurementCount);
    for (let m = 0; m < measurementCount; m++) {
      positions[m] = {
        az: sofaAzToAppAz(sourcePositionValues[m * 3]),
        el: sourcePositionValues[m * 3 + 1],
        r: sourcePositionValues[m * 3 + 2],
      };

      const measurementBase = m * irReceiverCount * irLength;
      const leftStart = measurementBase + leftReceiverIndex * irLength;
      const rightStart = measurementBase + rightReceiverIndex * irLength;
      leftIRs[m] = Float32Array.from(irValues.subarray(leftStart, leftStart + irLength));
      rightIRs[m] = Float32Array.from(irValues.subarray(rightStart, rightStart + irLength));
    }

    return { name, measurementCount, irLength, sampleRate, positions, leftIRs, rightIRs };
  } finally {
    h5file?.close();
    try {
      FS.unlink(path);
    } catch {
      // best-effort cleanup of the scratch virtual-FS file
    }
  }
}

export async function loadSofaFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const name = url.split("/").pop() ?? url;
  return loadSofaFile(bytes, { name });
}
