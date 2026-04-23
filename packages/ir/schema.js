// packages/ir/schema.js — CBREP v0 binary format definition
//
// CBREP (Canonical Binary REPresentation) is a deterministic, versioned
// binary IR for TopoBody. It encodes exact topology and NURBS geometry
// needed to reconstruct a TopoBody byte-for-byte identically.
//
// ─── File layout ───────────────────────────────────────────────────
//
//   Offset  Size   Field
//   ──────  ─────  ──────────────────────────
//   0       4      Magic: 0x43 0x42 0x52 0x50  ("CBRP")
//   4       2      Version (uint16 LE) — 0 for v0
//   6       2      Feature flags (uint16 LE)
//   8       4      Header size in bytes (uint32 LE) — total header including section table
//   12      4      Number of sections (uint32 LE)
//
//   Section table (numSections × 12 bytes):
//     0     4      Section type (uint32 LE) — one of SectionType enum
//     4     4      Offset from file start (uint32 LE)
//     8     4      Length in bytes (uint32 LE)
//
//   Section data follows contiguously after the section table.
//
// All multi-byte values are little-endian.
// All floats are IEEE 754 float64 (8 bytes LE).
// Strings are UTF-8 with uint16 length prefix.
//
// ─── Forward compatibility ─────────────────────────────────────────
//
//   Readers MUST skip unknown section types gracefully.
//   Writers MUST NOT reorder known sections within the section table.
//   Feature flags reserve bits for future optional capabilities.

// Magic bytes: "CBRP" read as uint32 LE
export const CBREP_MAGIC = 0x50524243;
export const CBREP_VERSION = 0;

// Feature flags (bitmask)
//   HAS_SURFACE_INFOS_V2 — each surfaceInfo record also carries an optional
//   xDir unit vector. Without it, canonicalize → write → read loses the
//   analytic surface's parametric orientation (which edge is u=0), and the
//   STEP-import tessellator cannot reproduce the live mesh from a restored
//   body. Readers that don't know this flag must ignore the extra bytes.
export const FeatureFlag = Object.freeze({
  NONE: 0,
  HAS_SURFACE_INFOS: 1 << 0,
  HAS_SURFACE_INFOS_V2: 1 << 1,
});

// Section type identifiers
export const SectionType = Object.freeze({
  VERTICES:   0x0001,
  EDGES:      0x0002,
  COEDGES:    0x0003,
  LOOPS:      0x0004,
  FACES:      0x0005,
  SHELLS:     0x0006,
  CURVES:     0x0007,
  SURFACES:   0x0008,
  SURF_INFOS: 0x0009,
});

// Surface type enum → uint8 (matches SurfaceType in BRepTopology.js)
export const SurfTypeId = Object.freeze({
  'plane':      0,
  'cylinder':   1,
  'cone':       2,
  'sphere':     3,
  'torus':      4,
  'extrusion':  5,
  'revolution': 6,
  'bspline':    7,
  'unknown':    8,
});

// Reverse map: id → string
export const SurfTypeStr = Object.freeze(
  Object.fromEntries(Object.entries(SurfTypeId).map(([k, v]) => [v, k]))
);

// Header constants
export const HEADER_SIZE = 16; // magic(4) + version(2) + flags(2) + headerSize(4) + numSections(4)
export const SECTION_ENTRY_SIZE = 12; // type(4) + offset(4) + length(4)

// Sentinel for "no reference" in uint32 index fields
export const NULL_IDX = 0xFFFFFFFF;

// Analytic surface info type IDs
export const SurfInfoTypeId = Object.freeze({
  'plane':    0,
  'cylinder': 1,
  'cone':     2,
  'sphere':   3,
  'torus':    4,
});

export const SurfInfoTypeStr = Object.freeze(
  Object.fromEntries(Object.entries(SurfInfoTypeId).map(([k, v]) => [v, k]))
);

// Validation error class
export class CbrepError extends Error {
  constructor(message) {
    super(`CBREP: ${message}`);
    this.name = 'CbrepError';
  }
}
