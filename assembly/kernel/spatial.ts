// kernel/spatial — octree for broadphase spatial queries
//
// Used by boolean operations to find candidate intersecting face pairs
// in O(n log n) instead of O(n²) linear AABB scan.
//
// The octree is built from face AABBs and returns candidate pairs
// whose bounding boxes overlap.

// ---------- constants ----------

/** Max nodes in the octree (pre-allocated). */
const MAX_NODES: u32 = 65536;

/** Max items (face ids) stored across all leaf nodes. */
const MAX_ITEMS: u32 = 131072;

/** Max depth of the octree. */
const MAX_DEPTH: u8 = 12;

/** Max items per leaf before subdivision. */
const LEAF_CAPACITY: u32 = 8;

/** Max candidate pairs returned from a query. */
const MAX_PAIRS: u32 = 65536;

// ---------- node storage (SoA layout) ----------

// Each node is either a leaf or an internal node with 8 children.
// Children of node i are at indices childStart[i]..childStart[i]+7.

/** AABB per node: 6 f64 (minX, minY, minZ, maxX, maxY, maxZ). */
const nodeAABB = new StaticArray<f64>(MAX_NODES * 6);

/** First child index (0 = leaf). */
const nodeChildStart = new StaticArray<u32>(MAX_NODES);

/** For leaf nodes: offset into items array. */
const nodeItemStart = new StaticArray<u32>(MAX_NODES);

/** For leaf nodes: number of items. */
const nodeItemCount = new StaticArray<u32>(MAX_NODES);

let nodeCount: u32 = 0;

// ---------- items storage ----------

/** Flat array of face ids stored in leaf nodes. */
const items = new StaticArray<u32>(MAX_ITEMS);
let itemCount: u32 = 0;

// ---------- candidate pairs output ----------

/** Output buffer for candidate pairs (face id A, face id B). */
const pairsOut = new StaticArray<u32>(MAX_PAIRS * 2);
let pairCount: u32 = 0;

// ---------- face AABB input ----------

/** Input face AABBs for building: 6 f64 per face. */
const faceAABBs = new StaticArray<f64>(16384 * 6);
let faceAABBCount: u32 = 0;

// ---------- build API ----------

/** Reset the octree for a new build. */
export function octreeReset(): void {
  nodeCount = 0;
  itemCount = 0;
  pairCount = 0;
  faceAABBCount = 0;
}

/** Add a face AABB before building. */
export function octreeAddFaceAABB(
  faceId: u32,
  minX: f64, minY: f64, minZ: f64,
  maxX: f64, maxY: f64, maxZ: f64
): void {
  if (faceAABBCount >= 16384) return;
  const off = faceId * 6;
  unchecked(faceAABBs[off] = minX);
  unchecked(faceAABBs[off + 1] = minY);
  unchecked(faceAABBs[off + 2] = minZ);
  unchecked(faceAABBs[off + 3] = maxX);
  unchecked(faceAABBs[off + 4] = maxY);
  unchecked(faceAABBs[off + 5] = maxZ);
  if (faceId >= faceAABBCount) faceAABBCount = faceId + 1;
}

/** Allocate a new node. Returns node index or 0xFFFFFFFF. */
function allocNode(
  minX: f64, minY: f64, minZ: f64,
  maxX: f64, maxY: f64, maxZ: f64
): u32 {
  if (nodeCount >= MAX_NODES) return 0xFFFFFFFF;
  const id = nodeCount;
  const off = id * 6;
  unchecked(nodeAABB[off] = minX);
  unchecked(nodeAABB[off + 1] = minY);
  unchecked(nodeAABB[off + 2] = minZ);
  unchecked(nodeAABB[off + 3] = maxX);
  unchecked(nodeAABB[off + 4] = maxY);
  unchecked(nodeAABB[off + 5] = maxZ);
  unchecked(nodeChildStart[id] = 0);
  unchecked(nodeItemStart[id] = 0);
  unchecked(nodeItemCount[id] = 0);
  nodeCount++;
  return id;
}

/** Check if two AABBs overlap. */
@inline
function aabbOverlap(
  aMinX: f64, aMinY: f64, aMinZ: f64, aMaxX: f64, aMaxY: f64, aMaxZ: f64,
  bMinX: f64, bMinY: f64, bMinZ: f64, bMaxX: f64, bMaxY: f64, bMaxZ: f64
): bool {
  return aMinX <= bMaxX && aMaxX >= bMinX &&
         aMinY <= bMaxY && aMaxY >= bMinY &&
         aMinZ <= bMaxZ && aMaxZ >= bMinZ;
}

// Temporary buffer for collecting face ids during build
const tempFaces = new StaticArray<u32>(16384);

/**
 * Build the octree from all registered face AABBs.
 * Call after all octreeAddFaceAABB() calls.
 */
export function octreeBuild(): void {
  nodeCount = 0;
  itemCount = 0;

  if (faceAABBCount == 0) return;

  // Compute world AABB
  let wMinX: f64 = Infinity, wMinY: f64 = Infinity, wMinZ: f64 = Infinity;
  let wMaxX: f64 = -Infinity, wMaxY: f64 = -Infinity, wMaxZ: f64 = -Infinity;

  for (let i: u32 = 0; i < faceAABBCount; i++) {
    const off = i * 6;
    const x0 = unchecked(faceAABBs[off]);
    const y0 = unchecked(faceAABBs[off + 1]);
    const z0 = unchecked(faceAABBs[off + 2]);
    const x1 = unchecked(faceAABBs[off + 3]);
    const y1 = unchecked(faceAABBs[off + 4]);
    const z1 = unchecked(faceAABBs[off + 5]);
    if (x0 < wMinX) wMinX = x0;
    if (y0 < wMinY) wMinY = y0;
    if (z0 < wMinZ) wMinZ = z0;
    if (x1 > wMaxX) wMaxX = x1;
    if (y1 > wMaxY) wMaxY = y1;
    if (z1 > wMaxZ) wMaxZ = z1;
  }

  // Collect all face ids
  for (let i: u32 = 0; i < faceAABBCount; i++) {
    unchecked(tempFaces[i] = i);
  }

  buildNode(wMinX, wMinY, wMinZ, wMaxX, wMaxY, wMaxZ, 0, faceAABBCount, 0);
}

/**
 * Recursive octree build.
 * faceStart/faceEnd index into tempFaces.
 */
function buildNode(
  minX: f64, minY: f64, minZ: f64,
  maxX: f64, maxY: f64, maxZ: f64,
  faceStart: u32, faceEnd: u32,
  depth: u32
): u32 {
  const count = faceEnd - faceStart;
  const nodeId = allocNode(minX, minY, minZ, maxX, maxY, maxZ);
  if (nodeId == 0xFFFFFFFF) return nodeId;

  // Leaf: store items directly
  if (count <= LEAF_CAPACITY || depth >= <u32>MAX_DEPTH) {
    const iStart = itemCount;
    for (let i = faceStart; i < faceEnd; i++) {
      if (itemCount < MAX_ITEMS) {
        unchecked(items[itemCount] = unchecked(tempFaces[i]));
        itemCount++;
      }
    }
    unchecked(nodeItemStart[nodeId] = iStart);
    unchecked(nodeItemCount[nodeId] = itemCount - iStart);
    return nodeId;
  }

  // Internal: subdivide into 8 octants
  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  const midZ = (minZ + maxZ) * 0.5;

  // Reserve 8 child slots
  const childBase = nodeCount;
  unchecked(nodeChildStart[nodeId] = childBase);

  // For each octant, collect overlapping faces and recurse
  for (let oct: u32 = 0; oct < 8; oct++) {
    const oMinX = (oct & 1) != 0 ? midX : minX;
    const oMaxX = (oct & 1) != 0 ? maxX : midX;
    const oMinY = (oct & 2) != 0 ? midY : minY;
    const oMaxY = (oct & 2) != 0 ? maxY : midY;
    const oMinZ = (oct & 4) != 0 ? midZ : minZ;
    const oMaxZ = (oct & 4) != 0 ? maxZ : midZ;

    // Partition: collect face ids that overlap this octant
    // Use a secondary region in tempFaces (after faceEnd) as scratch
    let childCount: u32 = 0;
    const scratchStart = faceEnd; // safe: we only read faceStart..faceEnd

    for (let i = faceStart; i < faceEnd; i++) {
      const fid = unchecked(tempFaces[i]);
      const fOff = fid * 6;
      if (aabbOverlap(
        oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ,
        unchecked(faceAABBs[fOff]),     unchecked(faceAABBs[fOff + 1]), unchecked(faceAABBs[fOff + 2]),
        unchecked(faceAABBs[fOff + 3]), unchecked(faceAABBs[fOff + 4]), unchecked(faceAABBs[fOff + 5])
      )) {
        if (scratchStart + childCount < 16384) {
          unchecked(tempFaces[scratchStart + childCount] = fid);
          childCount++;
        }
      }
    }

    if (childCount > 0) {
      buildNode(oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ,
                scratchStart, scratchStart + childCount, depth + 1);
    } else {
      // Empty octant: still allocate a node to keep child indices contiguous
      allocNode(oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ);
    }
  }

  return nodeId;
}

// ---------- query: find overlapping pairs ----------

/**
 * Find all pairs of face ids from body A and body B whose AABBs overlap.
 * Both bodies must have their face AABBs registered.
 * Result written to pairsOut. Returns number of pairs.
 *
 * For self-intersection (same body), pass the same face range.
 */
export function octreeQueryPairs(
  aFaceStart: u32, aFaceEnd: u32,
  bFaceStart: u32, bFaceEnd: u32
): u32 {
  pairCount = 0;

  for (let a = aFaceStart; a < aFaceEnd; a++) {
    const aOff = a * 6;
    const aMinX = unchecked(faceAABBs[aOff]);
    const aMinY = unchecked(faceAABBs[aOff + 1]);
    const aMinZ = unchecked(faceAABBs[aOff + 2]);
    const aMaxX = unchecked(faceAABBs[aOff + 3]);
    const aMaxY = unchecked(faceAABBs[aOff + 4]);
    const aMaxZ = unchecked(faceAABBs[aOff + 5]);

    // Walk the octree built from B's faces
    queryNode(0, a, aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ,
              bFaceStart, bFaceEnd);
  }

  return pairCount;
}

/** Recursive octree traversal for a single query AABB. */
function queryNode(
  nodeId: u32,
  queryFaceId: u32,
  qMinX: f64, qMinY: f64, qMinZ: f64,
  qMaxX: f64, qMaxY: f64, qMaxZ: f64,
  bFaceStart: u32, bFaceEnd: u32
): void {
  if (nodeId >= nodeCount) return;

  // Check against node AABB
  const nOff = nodeId * 6;
  if (!aabbOverlap(
    qMinX, qMinY, qMinZ, qMaxX, qMaxY, qMaxZ,
    unchecked(nodeAABB[nOff]),     unchecked(nodeAABB[nOff + 1]), unchecked(nodeAABB[nOff + 2]),
    unchecked(nodeAABB[nOff + 3]), unchecked(nodeAABB[nOff + 4]), unchecked(nodeAABB[nOff + 5])
  )) return;

  const childStart = unchecked(nodeChildStart[nodeId]);
  if (childStart == 0) {
    // Leaf: test against all items
    const iStart = unchecked(nodeItemStart[nodeId]);
    const iCount = unchecked(nodeItemCount[nodeId]);
    for (let i: u32 = 0; i < iCount; i++) {
      const bFace = unchecked(items[iStart + i]);
      if (bFace < bFaceStart || bFace >= bFaceEnd) continue;
      if (bFace == queryFaceId) continue; // skip self

      // Verify actual AABB overlap
      const bOff = bFace * 6;
      if (aabbOverlap(
        qMinX, qMinY, qMinZ, qMaxX, qMaxY, qMaxZ,
        unchecked(faceAABBs[bOff]),     unchecked(faceAABBs[bOff + 1]), unchecked(faceAABBs[bOff + 2]),
        unchecked(faceAABBs[bOff + 3]), unchecked(faceAABBs[bOff + 4]), unchecked(faceAABBs[bOff + 5])
      )) {
        if (pairCount < MAX_PAIRS) {
          const pOff = pairCount * 2;
          unchecked(pairsOut[pOff] = queryFaceId);
          unchecked(pairsOut[pOff + 1] = bFace);
          pairCount++;
        }
      }
    }
  } else {
    // Internal: recurse into children
    for (let c: u32 = 0; c < 8; c++) {
      queryNode(childStart + c, queryFaceId,
                qMinX, qMinY, qMinZ, qMaxX, qMaxY, qMaxZ,
                bFaceStart, bFaceEnd);
    }
  }
}

// ---------- output access ----------

export function getOctreePairsPtr(): usize { return changetype<usize>(pairsOut); }
export function octreeGetPairCount(): u32 { return pairCount; }
export function octreeGetNodeCount(): u32 { return nodeCount; }
