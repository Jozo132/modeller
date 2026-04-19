// kernel/core — handle registry, revision tracking, lifetime management
//
// Every native B-Rep body in WASM is referenced by an opaque u32 handle id.
// The HandleRegistry owns allocation, lookup, and disposal of handles.
// Revision ids change whenever exact geometry changes structurally.

// ---------- constants ----------

/** Maximum number of live handles. Sized for large assemblies. */
const MAX_HANDLES: u32 = 4096;

/** Sentinel for "no handle". */
export const HANDLE_NONE: u32 = 0;

// ---------- residency states ----------

export const RESIDENCY_UNMATERIALIZED: u8 = 0;
export const RESIDENCY_HYDRATING: u8 = 1;
export const RESIDENCY_RESIDENT: u8 = 2;
export const RESIDENCY_STALE: u8 = 3;
export const RESIDENCY_DISPOSED: u8 = 4;

// ---------- handle entry ----------

/**
 * Per-handle metadata stored in flat arrays for cache-friendly access.
 * The actual body data is stored separately in kernel/topology structures
 * and referenced by the handle id.
 */

// Flat arrays — one slot per handle id (1-based; slot 0 unused)
// Using StaticArrays for fixed allocation, no GC pressure during hot paths.

/** Whether each slot is currently allocated. */
const allocated = new StaticArray<u8>(MAX_HANDLES + 1);

/** Residency state per handle. */
const residency = new StaticArray<u8>(MAX_HANDLES + 1);

/** Monotonic revision id per handle. Bumped on every structural change. */
const revisionId = new StaticArray<u32>(MAX_HANDLES + 1);

/** Reference count: owner (1) + active jobs borrowing the handle. */
const refCount = new StaticArray<u32>(MAX_HANDLES + 1);

/** Feature id associated with this handle (0 = unlinked). */
const featureId = new StaticArray<u32>(MAX_HANDLES + 1);

/** IR hash for deterministic CBREP (0 = not computed). */
const irHash = new StaticArray<u32>(MAX_HANDLES + 1);

// ---------- registry state ----------

/** Next handle id to try for allocation (simple bump allocator). */
let nextHandleId: u32 = 1;

/** Number of currently allocated handles. */
let liveCount: u32 = 0;

/** Global monotonic revision counter. */
let globalRevision: u32 = 0;

// ---------- exported API ----------

/** Allocate a new handle. Returns HANDLE_NONE if registry is full. */
export function handleAlloc(): u32 {
  if (liveCount >= MAX_HANDLES) return HANDLE_NONE;

  // Linear probe from nextHandleId to find a free slot
  let id = nextHandleId;
  for (let i: u32 = 0; i < MAX_HANDLES; i++) {
    if (id > MAX_HANDLES) id = 1;
    if (unchecked(allocated[id]) == 0) {
      unchecked(allocated[id] = 1);
      globalRevision++;
      unchecked(revisionId[id] = globalRevision);
      unchecked(residency[id] = RESIDENCY_UNMATERIALIZED);
      unchecked(refCount[id] = 1); // owner ref
      unchecked(featureId[id] = 0);
      unchecked(irHash[id] = 0);
      liveCount++;
      nextHandleId = id + 1;
      return id;
    }
    id++;
  }
  return HANDLE_NONE;
}

/** Release a handle. Actual disposal happens when refCount reaches 0. */
export function handleRelease(id: u32): void {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return;
  if (unchecked(allocated[id]) == 0) return;
  const rc = unchecked(refCount[id]);
  if (rc <= 1) {
    // Fully dispose
    unchecked(allocated[id] = 0);
    unchecked(residency[id] = RESIDENCY_DISPOSED);
    unchecked(refCount[id] = 0);
    unchecked(featureId[id] = 0);
    unchecked(irHash[id] = 0);
    liveCount--;
  } else {
    unchecked(refCount[id] = rc - 1);
  }
}

/** Increment ref count (for job borrowing). */
export function handleAddRef(id: u32): void {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return;
  if (unchecked(allocated[id]) == 0) return;
  unchecked(refCount[id] = unchecked(refCount[id]) + 1);
}

/** Check if a handle is currently allocated. */
export function handleIsValid(id: u32): bool {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return false;
  return unchecked(allocated[id]) != 0;
}

/** Get the residency state of a handle. */
export function handleGetResidency(id: u32): u8 {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return RESIDENCY_DISPOSED;
  return unchecked(residency[id]);
}

/** Set the residency state. */
export function handleSetResidency(id: u32, state: u8): void {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return;
  if (unchecked(allocated[id]) == 0) return;
  unchecked(residency[id] = state);
}

/** Get the revision id of a handle. */
export function handleGetRevision(id: u32): u32 {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return 0;
  return unchecked(revisionId[id]);
}

/** Bump the revision (called when exact geometry changes). */
export function handleBumpRevision(id: u32): u32 {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return 0;
  if (unchecked(allocated[id]) == 0) return 0;
  globalRevision++;
  unchecked(revisionId[id] = globalRevision);
  return globalRevision;
}

/** Link a handle to a feature id. */
export function handleSetFeatureId(id: u32, fid: u32): void {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return;
  unchecked(featureId[id] = fid);
}

/** Get the feature id linked to a handle. */
export function handleGetFeatureId(id: u32): u32 {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return 0;
  return unchecked(featureId[id]);
}

/** Set the IR hash for a handle. */
export function handleSetIrHash(id: u32, hash: u32): void {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return;
  unchecked(irHash[id] = hash);
}

/** Get the IR hash for a handle. */
export function handleGetIrHash(id: u32): u32 {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return 0;
  return unchecked(irHash[id]);
}

/** Get ref count (for diagnostics). */
export function handleGetRefCount(id: u32): u32 {
  if (id == HANDLE_NONE || id > MAX_HANDLES) return 0;
  return unchecked(refCount[id]);
}

/** Get the number of currently live handles. */
export function handleLiveCount(): u32 {
  return liveCount;
}

/** Get the global revision counter. */
export function handleGlobalRevision(): u32 {
  return globalRevision;
}

/** Release all handles. Used on project close / clear. */
export function handleReleaseAll(): void {
  for (let i: u32 = 1; i <= MAX_HANDLES; i++) {
    unchecked(allocated[i] = 0);
    unchecked(residency[i] = RESIDENCY_DISPOSED);
    unchecked(revisionId[i] = 0);
    unchecked(refCount[i] = 0);
    unchecked(featureId[i] = 0);
    unchecked(irHash[i] = 0);
  }
  liveCount = 0;
  nextHandleId = 1;
}
