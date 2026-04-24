# WASM Tessellation Migration Plan

Status: draft — September 2024
Owner: modeller / CAD kernel
Scope: move the entire Tessellator2 pipeline (`js/cad/Tessellator2/`) into the
AssemblyScript kernel (`assembly/kernel/`) so that per-face tessellation runs
end-to-end in WASM and returns a ready-to-render vertex/index buffer with
zero JS-side curve/surface evaluation.

## 1. Why

Today the hot path is:

```
JS: BRepTopology → Tessellator2 → EdgeSampler ─┐
                                     │         │  surface.evaluate(u,v)
                                     ├─────────┼──── curve.tessellate()
                                     │         │  closestPointUV()
                                     ▼         ▼
                           FaceTriangulator → WASM-JS boundary
                                     │
                                     ▼
                                MeshStitcher
```

Every call to `surface.evaluate` / `surface.normal` /
`surface.closestPointUV` / `curve.tessellate` is a JS→WASM (or JS-only
fallback) trampoline that serializes `{u, v}` / 3D points through the shared
heap. A single mid-complexity face produces thousands of such calls (Step 3
adaptive subdivision + Steiner grid + boundary sampling). For a 100-face
body we already measure > 500k boundary crossings per tessellation, with
object allocations on both sides each call.

Pulling the pipeline into WASM removes the per-point serialization cost,
keeps NURBS state (knot vectors, control points) resident across
evaluations, enables SIMD/loop-vectorization in subdivision hot loops, and
frees the JS event loop for UI work.

## 2. Current Pipeline Inventory (JS side to move)

File → responsibility → WASM target module

| JS file                                                 | Role                                                  | WASM target                        |
| ------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| `Tessellator2/index.js`                                 | Dispatcher, fast paths (sphere pole, periodic strips) | `assembly/kernel/tessellator.ts`   |
| `Tessellator2/EdgeSampler.js`                           | Uniform / curve edge sampling + cache                 | `assembly/kernel/edge-sampler.ts`  |
| `Tessellator2/FaceTriangulator.js`                      | Planar / analytic / NURBS CDT + subdivision           | `assembly/kernel/face-triangulator.ts` |
| `Tessellator2/MeshStitcher.js`                          | Vertex dedup, per-face → per-body merge               | `assembly/kernel/mesh-stitcher.ts` |
| `Tessellator2/GeometryEvaluator.js` (thin shim)         | `evalSurface` wrapper                                 | inlined into `face-triangulator.ts`|
| `js/cad/NurbsCurve.js`, `NurbsSurface.js`               | NURBS evaluators (already dual JS/WASM)               | Use existing `assembly/nurbs.ts`   |
| `js/cad/toolkit/CDT.js` (`constrainedTriangulate`)      | Sweep-line / Bowyer–Watson CDT                        | `assembly/kernel/cdt.ts`           |
| `js/cad/toolkit/Vec3Utils.js` (fmtCoord, edgeKeyFromVerts) | Hashing, key helpers                                | `assembly/kernel/vec3-utils.ts`    |

What stays in JS:

- **TopoBody construction** (`BRepTopology.js`, `BRepChamfer.js`,
  `BRepFillet.js`): authored by feature operators; too intertwined with the
  feature tree to move now.
- **Tessellator entry point** in `js/cad/Tessellator2/index.js` becomes a
  thin shim that (a) marshals the TopoBody into a packed WASM struct, (b)
  calls `tessellateBodyWASM(bodyPtr)`, (c) decodes the returned mesh.
- **Rendering** (`js/wasm-renderer.js`, `js/webgl-executor.js`): already
  operates on Float32Array vertex/index buffers, so once we emit those in
  WASM we can pass them through without decoding.

## 3. Boundary Representation in WASM

We need a stable, side-effect-free snapshot of the TopoBody that WASM can
read. Define a packed binary layout (AssemblyScript-friendly, no GC
pressure):

```
TopoBodyBlob {
  u32  magic          = 'TPBD'
  u32  version
  u32  numVertices
  u32  numEdges
  u32  numCoEdges
  u32  numLoops
  u32  numFaces
  u32  numShells
  Vertex[numVertices]     // {f64 x,y,z; u32 id}
  Curve[numEdges]         // tagged union; see below
  Edge[numEdges]          // {u32 id; u32 startV; u32 endV; u32 curveIdx; f32 tMin; f32 tMax}
  CoEdge[numCoEdges]      // {u32 edgeIdx; u8 sameSense; u32 loopIdx}
  Surface[numFaces]       // tagged union
  Loop[numLoops]          // {u32 firstCoEdge; u32 coEdgeCount; u32 faceIdx}
  Face[numFaces]          // {u32 id; u32 outerLoopIdx; u32 firstInnerLoop; u32 innerLoopCount;
                          //  u32 surfaceIdx; u8 surfaceTypeTag; u8 sameSense; u16 flags}
  Shell[numShells]        // {u32 firstFace; u32 faceCount}
}

Curve = tag(u8) ∈ { LINE=0, CIRCLE_ARC=1, NURBS_CURVE=2 }
  LINE        → {f64 sx,sy,sz, ex,ey,ez}
  CIRCLE_ARC  → {f64 cx,cy,cz, ax,ay,az, ux,uy,uz, r, startAng, endAng}
  NURBS_CURVE → {u32 degree; u32 nCP; f64[] CP (4*n: wx,wy,wz,w); u32 nKnots; f64[] knots}

Surface = tag(u8) ∈ { PLANE=0, CYLINDER=1, CONE=2, SPHERE=3, TORUS=4, NURBS_SURFACE=5 }
  // packed similarly; existing assembly/nurbs.ts already holds the NURBS
  // layout, so we alias the CP/knot table pointers to save a copy.
```

Shared-memory strategy:

1. JS side allocates a `Uint8Array` (or `Float64Array` view) large enough to
   hold the blob, writes it directly, then calls `wasm.tessellateBody(ptr,
   len, optsPtr, optsLen)` with a WASM-owned memory pointer.
2. WASM side builds internal `StaticArray<Vertex>`, `StaticArray<Face>`, etc.
   from the blob (no heap churn per face).
3. Return path: WASM writes a `MeshBlob` to a second region; JS receives
   `{vertexPtr, vertexCount, facePtr, faceCount}` and wraps them as typed
   arrays (zero-copy view into WASM linear memory).

```
MeshBlob {
  u32  magic         = 'MESH'
  u32  numVertices
  u32  numTriangles
  u32  numFaceGroups
  f32[numVertices * 8]    // x,y,z, nx,ny,nz, u,v
  u32[numTriangles * 3]   // triangle vertex indices
  FaceGroup[numFaceGroups] // {u32 firstTri; u32 triCount; u32 topoFaceId; u8 flags}
}
```

The renderer already consumes an interleaved xyz+n+uv buffer, so no JS-side
repacking is required.

## 4. Phased Migration

Each phase is independently testable against the golden fixtures and can
ship behind a feature flag.

### Phase 0 — Baseline & parity harness (prerequisite)

- Capture golden tessellations for the full corpus currently exercised by
  `tests/test-tess-dihedral-sweep.js`, `tests/test-boolean-corpus.js`, and
  `tests/test-brep-*.js`. Store under
  `tests/fixtures/tess-golden/*.mesh.json` as `{vertices, indices,
  faceGroups}` with sha-256 content hashes.
- Add `tests/test-tess-parity.js` that runs BOTH the JS pipeline and the
  (future) WASM pipeline on the same `TopoBody`, asserts vertex-count,
  triangle-count, and max-point-deviation within `1e-9`, and snapshots the
  result.
- Add a feature flag `window.featureFlags.tess.wasm` (default `false`)
  consumed by `js/cad/Tessellator2/index.js`.
- Wire a micro-benchmark `tests/bench-tess.mjs` capturing (ms, triangles,
  faces) per fixture so regressions in either path are caught early.

### Phase 1 — EdgeSampler + line/arc sampling in WASM

Why first: EdgeSampler is pure, cacheable, and the single biggest source of
point allocations (thousands per body).

- Port `_sampleLinear` and analytic arc / line-curve detection to
  `assembly/kernel/edge-sampler.ts`.
- Reuse `assembly/kernel/nurbs.ts` for NURBS curve sampling — extend with a
  `sampleUniform(curve, nSegs, startPt, endPt, outPtrF64)` export.
- Build the edge-sample cache inside WASM, keyed on `(edgeId, segments)`
  with a compact hashmap (linear probing over `StaticArray<u32>`).
- JS entry point calls `wasm.sampleEdge(edgeIdx, segments, outPtr)` and
  receives the packed `f64[3*n]` sample array as a typed view.
- Keep the JS EdgeSampler as a shim so callers are unchanged; internally it
  delegates to WASM when the flag is on.
- Parity gate: `tests/test-tess-parity.js` with only Phase 1 enabled must
  match JS results vertex-for-vertex.

### Phase 2 — FaceTriangulator planar path in WASM

- Port `triangulatePlanar` (Newell normal, `projectTo2D`, ear-clipping-free
  CDT dispatch, `splitSkippedBoundaryChains`, `splitSkippedBoundaryMeshEdges`).
- Port the constrained Delaunay core from `js/cad/toolkit/CDT.js` to
  `assembly/kernel/cdt.ts`. This is the riskiest single step — the existing
  CDT has many correctness workarounds (sliver removal, zero-area triangle
  filters, robust predicates). Use a *direct* port, not a rewrite, and keep
  the JS implementation alongside for A/B parity.
- `boundaryEdgeSet` / `meshEdgeKey` become `Map<u64, u32>` (packed 3D-coord
  keys), no strings.
- Parity gate: planar faces must match 1:1 in triangle indices after
  deterministic sort.

### Phase 3 — Analytic surface path in WASM

- Port `triangulateAnalyticSurface` (`_makeAnalyticSurface`, cylinder /
  cone / sphere / torus closures) to
  `assembly/kernel/analytic-surfaces.ts`.
- Port `_normalizePeriodicLoop` and seam-jump rotation.
- Port `mapLoopToUV` — this is the single largest driver for WASM gains
  because it currently calls `surface.closestPointUV` ~N×8 per face.
- Parity gate: cylinder / cone / sphere fixtures match within `1e-10` after
  deterministic point ordering.

### Phase 4 — NURBS surface path (most complex)

- Port `triangulateSurface` (the 700-line function in `FaceTriangulator.js`),
  including: periodic detection, UV unwrap, UV-self-intersection check,
  Newell boundary normal vs surface normal, Steiner grid, 4-pass adaptive
  subdivision with deviation tolerance, fan-split boundary repair.
- `surfaceMidpoint` / `midpointUv` cache becomes a packed open-address
  hashmap keyed on `u32 (edgeKey)`.
- Subdivision triangle storage becomes `StaticArray<u32>` index lists
  instead of `[a,b,c]` tuples.
- Per-vertex normal compute (`surface.normal(u,v)` × 3 per triangle) batches
  into one WASM call that produces all normals for the final triangle
  list.
- Parity gate: NURBS fixtures match within `1e-8` for vertex positions and
  within `1e-6` for normals (small cos deviation allowed because the JS
  centroid-evaluation can take a different code path than WASM SIMD-evaluation).

### Phase 5 — MeshStitcher + return buffer in WASM

- Port `MeshStitcher.stitch` — vertex-dedup map becomes a robin-hood hash
  over `u64` coordinate keys.
- Emit the final `MeshBlob` directly into WASM memory.
- JS `tessellateBodyWASM` wraps the returned pointers with typed-array
  views and tags them with `{topoFaceId, fusedGroupId, isCorner, isFillet}`
  from a parallel `FaceGroup[]` table emitted alongside.
- Parity gate: full-body tessellation bit-exact with JS path for planar
  corpus and `<1e-9` for curved corpus.

### Phase 6 — Cleanup

- Delete the JS implementations (keep as historical reference tag
  `pre-wasm-tess` only).
- Flip `featureFlags.tess.wasm` default to `true`.
- Remove the parity harness or relegate it to a nightly job.

## 5. Risks & Mitigations

| Risk | Detail | Mitigation |
| ---- | ------ | ---------- |
| CDT correctness drift | The JS CDT has years of sliver / degeneracy fixes embedded in test-driven patches. A rewrite will reintroduce bugs. | *Direct port, not a rewrite*. Keep test-boolean-corpus green at every phase. Diff triangle index lists deterministically. |
| Floating-point divergence | JS uses f64 everywhere; WASM may use f64 ops that differ on transcendentals (sin/cos/sqrt) depending on compiler. | Lock tolerances explicitly in parity tests; prefer `Mathf` only where irrelevant (normal normalization). Never use f32 for UV / CDT predicates. |
| Memory management | Blob-based marshaling can leak if WASM panics. | Use a ring-buffer allocator per tessellation call; reset on completion. Add `tessellateBody_free(ptr)` export. |
| Shared-edge sample identity across faces | Today EdgeSampler returns the same JS array reference to both neighboring faces, which MeshStitcher relies on for dedup. | In WASM, share by edge *sample offset* in the blob, not by pointer identity. MeshStitcher dedups by `fmtCoord`-keyed hash which is already position-based, so identity reliance is implicit but safe. |
| Feature-flag regressions | Turning on the WASM path mid-session could change tessellation results in the middle of a user edit. | Flag reads `sessionStorage` on boot; switch requires reload. Parity harness runs on CI for each PR. |
| Fallback when WASM evaluator unavailable | The existing `[CAD-Fallback] evaluator:wasm-to-js` path exists because some environments cannot load the stack fallback WASM. | Keep the JS pipeline live until Phase 6. If WASM evaluator reports `unavailable`, the dispatcher auto-routes to JS. |

## 6. Out-of-scope for this plan (explicit)

- BRep kernel (fillet / chamfer / boolean) stays in JS. That is a separate,
  far larger port touching the FeatureTree.
- STEP import / export stays in JS.
- Incremental tessellation cache (`_incrementalTessellationCache`) — will
  need a parallel WASM-side cache store once Phase 5 lands. Deferred.

## 7. Success metrics

1. `tests/test-tess-parity.js` green across every phase.
2. `tests/bench-tess.mjs` shows ≥ 3× speedup on the `XYZ all fillet` corner
   fixture once Phase 5 lands (measured on v22 Node, Intel i7).
3. No regressions in the full `tests/index.js` suite at any phase.
4. Zero `[CAD-Fallback] evaluator:wasm-to-js` warnings when the WASM
   evaluator is actually available — today's code path pessimistically logs
   this even when WASM is loadable.

## 8. Estimated complexity (relative)

- Phase 0: S (fixtures + flag)
- Phase 1: S (EdgeSampler is ~200 lines)
- Phase 2: M (planar CDT port — careful)
- Phase 3: M (analytic surfaces — follows Phase 2 template)
- Phase 4: L (NURBS triangulate — the biggest function in the codebase)
- Phase 5: S (stitcher + blob plumbing)
- Phase 6: S (cleanup)

Total: roughly 3 L-weeks of focused kernel work with a parity harness that
pays for itself by catching regressions early.
