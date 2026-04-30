// kernel/geometry — NURBS curve/surface definitions stored in WASM linear memory
//
// Geometry data is stored in a flat pool. Each surface or curve definition
// occupies a contiguous region starting at a "geometry offset" which is
// referenced by face.geomOffset or edge.geomOffset in the topology module.
//
// The pool uses f64 throughout for exact-kernel precision (matching the
// existing assembly/nurbs.ts evaluation which uses f64).

// ---------- pool ----------

/** Max total f64 slots in the geometry pool. 8 MB of f64 = 1M entries. */
const POOL_CAPACITY: u32 = 1048576;
const pool = new StaticArray<f64>(POOL_CAPACITY);
let poolUsed: u32 = 0;

// ---------- helpers ----------

function poolReserve(count: u32): u32 {
  const offset = poolUsed;
  if (offset + count > POOL_CAPACITY) return 0xFFFFFFFF; // overflow
  poolUsed += count;
  return offset;
}

// ---------- NURBS surface storage ----------

/**
 * Store a NURBS surface definition in the pool.
 *
 * Layout at returned offset:
 *   [0]     degreeU (as f64)
 *   [1]     degreeV
 *   [2]     numCtrlU
 *   [3]     numCtrlV
 *   [4]     numKnotsU
 *   [5]     numKnotsV
 *   [6..6+numKnotsU-1]              knotsU
 *   [6+numKnotsU..6+numKnotsU+numKnotsV-1]  knotsV
 *   [...+numCtrlU*numCtrlV*3]         control points (x,y,z triples)
 *   [...+numCtrlU*numCtrlV]           weights
 *
 * Returns the pool offset or 0xFFFFFFFF on overflow.
 */
export function nurbsSurfaceStore(
  degreeU: u32, degreeV: u32,
  numCtrlU: u32, numCtrlV: u32,
  knotsU: StaticArray<f64>,
  knotsV: StaticArray<f64>,
  ctrlPts: StaticArray<f64>,  // x,y,z triples, length = numCtrlU*numCtrlV*3
  weights: StaticArray<f64>   // length = numCtrlU*numCtrlV
): u32 {
  const nKnotsU = knotsU.length;
  const nKnotsV = knotsV.length;
  const nCtrl = numCtrlU * numCtrlV;
  const totalSlots: u32 = 6 + nKnotsU + nKnotsV + nCtrl * 3 + nCtrl;
  const offset = poolReserve(totalSlots);
  if (offset == 0xFFFFFFFF) return offset;

  let p = offset;
  unchecked(pool[p++] = <f64>degreeU);
  unchecked(pool[p++] = <f64>degreeV);
  unchecked(pool[p++] = <f64>numCtrlU);
  unchecked(pool[p++] = <f64>numCtrlV);
  unchecked(pool[p++] = <f64>nKnotsU);
  unchecked(pool[p++] = <f64>nKnotsV);

  for (let i: i32 = 0; i < nKnotsU; i++) {
    unchecked(pool[p++] = unchecked(knotsU[i]));
  }
  for (let i: i32 = 0; i < nKnotsV; i++) {
    unchecked(pool[p++] = unchecked(knotsV[i]));
  }
  const nPts = nCtrl * 3;
  for (let i: u32 = 0; i < nPts; i++) {
    unchecked(pool[p++] = unchecked(ctrlPts[i]));
  }
  for (let i: u32 = 0; i < nCtrl; i++) {
    unchecked(pool[p++] = unchecked(weights[i]));
  }

  return offset;
}

// ---------- NURBS curve storage ----------

/**
 * Store a NURBS curve definition.
 *
 * Layout at returned offset:
 *   [0]     degree
 *   [1]     numCtrl
 *   [2]     numKnots
 *   [3..3+numKnots-1]          knots
 *   [...+numCtrl*3]             control points (x,y,z)
 *   [...+numCtrl]               weights
 */
export function nurbsCurveStore(
  degree: u32,
  numCtrl: u32,
  knots: StaticArray<f64>,
  ctrlPts: StaticArray<f64>,  // x,y,z triples
  weights: StaticArray<f64>
): u32 {
  const nKnots = knots.length;
  const totalSlots: u32 = 3 + nKnots + numCtrl * 3 + numCtrl;
  const offset = poolReserve(totalSlots);
  if (offset == 0xFFFFFFFF) return offset;

  let p = offset;
  unchecked(pool[p++] = <f64>degree);
  unchecked(pool[p++] = <f64>numCtrl);
  unchecked(pool[p++] = <f64>nKnots);

  for (let i: i32 = 0; i < nKnots; i++) {
    unchecked(pool[p++] = unchecked(knots[i]));
  }
  const nPts = numCtrl * 3;
  for (let i: u32 = 0; i < nPts; i++) {
    unchecked(pool[p++] = unchecked(ctrlPts[i]));
  }
  for (let i: u32 = 0; i < numCtrl; i++) {
    unchecked(pool[p++] = unchecked(weights[i]));
  }

  return offset;
}

/**
 * Store a circle curve definition: center (3) + axis (3) + refDir (3) + radius (1) = 10 slots.
 */
export function circleStore(
  cx: f64, cy: f64, cz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  radius: f64
): u32 {
  const offset = poolReserve(10);
  if (offset == 0xFFFFFFFF) return offset;
  let p = offset;
  unchecked(pool[p++] = cx); unchecked(pool[p++] = cy); unchecked(pool[p++] = cz);
  unchecked(pool[p++] = ax); unchecked(pool[p++] = ay); unchecked(pool[p++] = az);
  unchecked(pool[p++] = rx); unchecked(pool[p++] = ry); unchecked(pool[p++] = rz);
  unchecked(pool[p++] = radius);
  return offset;
}

// ---------- analytic surface storage ----------

/**
 * Store a plane definition: origin (3) + normal (3) + refDir (3) = 9 slots.
 */
export function planeStore(
  ox: f64, oy: f64, oz: f64,
  nx: f64, ny: f64, nz: f64,
  rx: f64, ry: f64, rz: f64
): u32 {
  const offset = poolReserve(9);
  if (offset == 0xFFFFFFFF) return offset;
  let p = offset;
  unchecked(pool[p++] = ox); unchecked(pool[p++] = oy); unchecked(pool[p++] = oz);
  unchecked(pool[p++] = nx); unchecked(pool[p++] = ny); unchecked(pool[p++] = nz);
  unchecked(pool[p++] = rx); unchecked(pool[p++] = ry); unchecked(pool[p++] = rz);
  return offset;
}

/**
 * Store a cylinder definition: origin (3) + axis (3) + refDir (3) + radius (1) = 10 slots.
 */
export function cylinderStore(
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  radius: f64
): u32 {
  const offset = poolReserve(10);
  if (offset == 0xFFFFFFFF) return offset;
  let p = offset;
  unchecked(pool[p++] = ox); unchecked(pool[p++] = oy); unchecked(pool[p++] = oz);
  unchecked(pool[p++] = ax); unchecked(pool[p++] = ay); unchecked(pool[p++] = az);
  unchecked(pool[p++] = rx); unchecked(pool[p++] = ry); unchecked(pool[p++] = rz);
  unchecked(pool[p++] = radius);
  return offset;
}

/**
 * Store a sphere definition: center (3) + axis (3) + refDir (3) + radius (1) = 10 slots.
 */
export function sphereStore(
  cx: f64, cy: f64, cz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  radius: f64
): u32 {
  const offset = poolReserve(10);
  if (offset == 0xFFFFFFFF) return offset;
  let p = offset;
  unchecked(pool[p++] = cx); unchecked(pool[p++] = cy); unchecked(pool[p++] = cz);
  unchecked(pool[p++] = ax); unchecked(pool[p++] = ay); unchecked(pool[p++] = az);
  unchecked(pool[p++] = rx); unchecked(pool[p++] = ry); unchecked(pool[p++] = rz);
  unchecked(pool[p++] = radius);
  return offset;
}

/**
 * Store a cone definition: origin (3) + axis (3) + refDir (3) + radius (1) + semiAngle (1) = 11 slots.
 */
export function coneStore(
  ox: f64, oy: f64, oz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  radius: f64, semiAngle: f64
): u32 {
  const offset = poolReserve(11);
  if (offset == 0xFFFFFFFF) return offset;
  let p = offset;
  unchecked(pool[p++] = ox); unchecked(pool[p++] = oy); unchecked(pool[p++] = oz);
  unchecked(pool[p++] = ax); unchecked(pool[p++] = ay); unchecked(pool[p++] = az);
  unchecked(pool[p++] = rx); unchecked(pool[p++] = ry); unchecked(pool[p++] = rz);
  unchecked(pool[p++] = radius);
  unchecked(pool[p++] = semiAngle);
  return offset;
}

/**
 * Store a torus definition: center (3) + axis (3) + refDir (3) + majorR (1) + minorR (1) = 11 slots.
 */
export function torusStore(
  cx: f64, cy: f64, cz: f64,
  ax: f64, ay: f64, az: f64,
  rx: f64, ry: f64, rz: f64,
  majorRadius: f64, minorRadius: f64
): u32 {
  const offset = poolReserve(11);
  if (offset == 0xFFFFFFFF) return offset;
  let p = offset;
  unchecked(pool[p++] = cx); unchecked(pool[p++] = cy); unchecked(pool[p++] = cz);
  unchecked(pool[p++] = ax); unchecked(pool[p++] = ay); unchecked(pool[p++] = az);
  unchecked(pool[p++] = rx); unchecked(pool[p++] = ry); unchecked(pool[p++] = rz);
  unchecked(pool[p++] = majorRadius);
  unchecked(pool[p++] = minorRadius);
  return offset;
}

/**
 * Store a rolling fillet descriptor from the staging buffer.
 *
 * Layout at returned offset:
 *   [0]                row count
 *   [1]                start cap sample count
 *   [2]                end cap sample count
 *   [3..]              rail0 points (x,y,z triples)
 *   [...+rows*3]       rail1 points (x,y,z triples)
 *   [...+rows*3]       rolling centers (x,y,z triples)
 *   [...+rows*3]       start cap samples (x,y,z triples)
 *   [...+start*3]      end cap samples (x,y,z triples)
 */
export function rollingFilletStoreFromStaging(rowCount: u32, startCount: u32, endCount: u32): u32 {
  if (rowCount < 2) return 0xFFFFFFFF;
  if (startCount < 2 || endCount < 2) return 0xFFFFFFFF;
  const totalData: u32 = rowCount * 9 + startCount * 3 + endCount * 3;
  if (totalData > STAGING_CAPACITY) return 0xFFFFFFFF;
  const offset = poolReserve(3 + totalData);
  if (offset == 0xFFFFFFFF) return offset;

  let p = offset;
  unchecked(pool[p++] = <f64>rowCount);
  unchecked(pool[p++] = <f64>startCount);
  unchecked(pool[p++] = <f64>endCount);
  for (let i: u32 = 0; i < totalData; i++) {
    unchecked(pool[p++] = unchecked(staging[i]));
  }

  return offset;
}

/** Store an exact boundary loop for a native boundary-preserving fan face. */
export function boundaryFanStoreFromStaging(pointCount: u32): u32 {
  if (pointCount < 3) return 0xFFFFFFFF;
  const totalData: u32 = pointCount * 3;
  if (totalData > STAGING_CAPACITY) return 0xFFFFFFFF;
  const offset = poolReserve(1 + totalData);
  if (offset == 0xFFFFFFFF) return offset;

  let p = offset;
  unchecked(pool[p++] = <f64>pointCount);
  for (let i: u32 = 0; i < totalData; i++) {
    unchecked(pool[p++] = unchecked(staging[i]));
  }

  return offset;
}

// ---------- pool accessors ----------

/** Read a f64 from the pool at a given offset. */
export function geomPoolRead(offset: u32): f64 {
  if (offset >= POOL_CAPACITY) return 0.0;
  return unchecked(pool[offset]);
}

/** Get pointer to the pool for zero-copy JS access. */
export function getGeomPoolPtr(): usize {
  return changetype<usize>(pool);
}

/** Get the number of f64 slots currently used. */
export function geomPoolUsed(): u32 {
  return poolUsed;
}

/** Reset the geometry pool (for body rebuild). */
export function geomPoolReset(): void {
  poolUsed = 0;
}

/** Set the pool used count directly (for CBREP hydration). */
export function geomPoolSetUsed(count: u32): void {
  if (count <= POOL_CAPACITY) poolUsed = count;
}

// ---------- staging buffer for JS → WASM NURBS data transfer ----------

/** 64KB staging buffer for passing variable-length arrays from JS. */
const STAGING_CAPACITY: u32 = 8192;
const staging = new StaticArray<f64>(STAGING_CAPACITY);

/** Get the byte pointer to the staging buffer (for JS to write into). */
export function geomStagingPtr(): usize {
  return changetype<usize>(staging);
}

/** Get the staging buffer capacity in f64 slots. */
export function geomStagingCapacity(): u32 {
  return STAGING_CAPACITY;
}

/**
 * Store a NURBS surface from the staging buffer.
 * JS must write into geomStagingPtr() before calling this:
 *   [0..nKnotsU-1]       knotsU
 *   [nKnotsU..nKnotsU+nKnotsV-1]  knotsV
 *   [...+nCtrl*3]        control points (x,y,z triples)
 *   [...+nCtrl]          weights
 */
export function nurbsSurfaceStoreFromStaging(
  degreeU: u32, degreeV: u32,
  numCtrlU: u32, numCtrlV: u32,
  nKnotsU: u32, nKnotsV: u32
): u32 {
  const nCtrl = numCtrlU * numCtrlV;
  const totalSlots: u32 = 6 + nKnotsU + nKnotsV + nCtrl * 3 + nCtrl;
  const offset = poolReserve(totalSlots);
  if (offset == 0xFFFFFFFF) return offset;

  let p = offset;
  unchecked(pool[p++] = <f64>degreeU);
  unchecked(pool[p++] = <f64>degreeV);
  unchecked(pool[p++] = <f64>numCtrlU);
  unchecked(pool[p++] = <f64>numCtrlV);
  unchecked(pool[p++] = <f64>nKnotsU);
  unchecked(pool[p++] = <f64>nKnotsV);

  const totalData = nKnotsU + nKnotsV + nCtrl * 3 + nCtrl;
  for (let i: u32 = 0; i < totalData; i++) {
    unchecked(pool[p++] = unchecked(staging[i]));
  }

  return offset;
}

/**
 * Store a NURBS curve from the staging buffer.
 * JS must write into geomStagingPtr() before calling this:
 *   [0..nKnots-1]        knots
 *   [nKnots..nKnots+numCtrl*3-1]  control points (x,y,z triples)
 *   [...+numCtrl]         weights
 */
export function nurbsCurveStoreFromStaging(
  degree: u32, numCtrl: u32, nKnots: u32
): u32 {
  const totalSlots: u32 = 3 + nKnots + numCtrl * 3 + numCtrl;
  const offset = poolReserve(totalSlots);
  if (offset == 0xFFFFFFFF) return offset;

  let p = offset;
  unchecked(pool[p++] = <f64>degree);
  unchecked(pool[p++] = <f64>numCtrl);
  unchecked(pool[p++] = <f64>nKnots);

  const totalData = nKnots + numCtrl * 3 + numCtrl;
  for (let i: u32 = 0; i < totalData; i++) {
    unchecked(pool[p++] = unchecked(staging[i]));
  }

  return offset;
}
