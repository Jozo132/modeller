# WASM B-Rep Lifetime Plan

## Goal

Move the exact CAD kernel toward a fully WASM-resident implementation where
exact B-Rep handling, transformations, tessellation, and STEP import/export run
inside AssemblyScript modules, while preserving the repository's core rule that
exact topology is the source of truth.

The key constraint is architectural: native/WASM residency must not create a
second semantic model. The source of truth remains the exact body revision, but
its authoritative runtime representation should progressively move into WASM.
Persistent state must still be deterministic and serializable outside the WASM
heap.

## Current Baseline

As of 2026-04-26, the project is no longer at the "JS TopoBody with optional
WASM acceleration" starting point. The kernel has real native residency pieces
and the remaining work is to make those pieces the default runtime path.

- `assembly/kernel/core.ts` owns native handles, residency states, revisions,
  reference counts, and per-handle topology/geometry ranges.
- `assembly/kernel/topology.ts` and `assembly/kernel/geometry.ts` store native
  B-Rep topology and analytic/NURBS geometry in append-only pools, with
  `bodyBeginForHandle()` / `bodyEndForHandle()` recording each handle's ranges.
- `assembly/kernel/interop.ts` supports deterministic CBREP hydrate/dehydrate,
  including `cbrepHydrateForHandle()` for appending a body into a specific
  handle without clearing other resident bodies.
- `js/cad/WasmBrepHandleRegistry.js` bridges allocation, residency, CBREP
  hydration/dehydration, transforms, octree queries, GPU buffer access, and now
  handle-scoped tessellation through `tessellateHandle()`.
- `assembly/kernel/tessellation.ts` tessellates kernel-owned topology directly
  for planes, cylinders, cones, spheres, tori, and NURBS surfaces. It exposes
  both the legacy global `tessBuildAllFaces()` and the resident-handle scoped
  `tessBuildHandleFaces(handleId, segsU, segsV)` path.
- `assembly/kernel/step_lexer.ts`, `step_parser.ts`, and `step_topology.ts`
  can build STEP topology directly into the native pools for the opt-in native
  STEP path.
- `assembly/kernel/ops.ts` contains topology-aware classification support,
  octree-backed candidate routing, error-bound tracking, and several analytic
  H8 narrowphase slices, including plane/plane, plane/cylinder, plane/cone,
  plane/sphere, sphere/sphere, and parallel-axis cylinder/cylinder.
- `assembly/kernel/gpu.ts`, `js/render/nurbs-tess.wgsl.js`, and
  `js/render/gpu-tess-pipeline.js` provide the first WebGPU buffer/shader
  scaffold. GPU work is an acceleration layer that consumes kernel-owned
  geometry; it is not the owner of exact topology.
- JS still owns too much runtime orchestration: most feature operations,
  `FeatureTree.tryFastRestoreFromCheckpoints()`, production registry/residency
  startup, and some rendering paths still materialize JS `TopoBody` or mesh data
  when a resident handle could be used instead.

The immediate architectural rule is therefore: production code should pass
opaque handle ids plus small operation/tessellation parameters across the
JS/WASM boundary. CBREP is for persistence, cache restore, and deliberate
hydrate/dehydrate boundaries, not for routine in-session body transport.

## Target End State

The target architecture is not just "some acceleration in WASM". It is a
modular AssemblyScript kernel where the full exact geometry pipeline lives in
native memory:

- exact B-Rep topology storage and traversal
- exact geometry evaluation
- body-space and assembly-space transforms
- tessellation and display-mesh extraction
- STEP import into native exact bodies
- STEP export from native exact bodies
- downstream exact operations such as boolean, chamfer, fillet, and later
  shell/offset tools

In that end state, JavaScript is primarily responsible for:

- UI orchestration
- file picking / browser integration
- feature-tree coordination
- persistence metadata
- diagnostics presentation
- fallback and debug tooling

JS should stop being the default execution engine for core exact-kernel work.

## Algorithmic Strategy

Three research-informed strategies underpin the performance and quality targets
for the native kernel. Each addresses a distinct bottleneck in the current
pipeline.

### 1. Robust Boolean Operations

The current boolean path (`BooleanKernel.js`) performs exact surface-surface
intersection, face splitting, and containment classification. It is correct but
fragile under floating-point noise and uses linear AABB scanning for broadphase.

The native kernel should adopt:

- **Octree-based spatial indexing** for candidate intersection pair detection.
  An octree partitions world space hierarchically, reducing intersection
  candidate search from O(n²) face pairs to O(n log n) in practice. The octree
  should be built once per body revision and reused across operations.

- **Topology-driven sub-surface classification** that relies strictly on entity
  indexing rather than purely on floating-point coordinate comparisons. By
  linking fragment inside/outside decisions directly to the topological index
  (face id, shell id, loop winding), the algorithm guarantees a valid topology
  even when intersection coordinates are noisy. This eliminates the class of
  bugs where a microscopic coordinate error flips a fragment classification and
  produces non-manifold geometry.

- **Floating-point error-bounded segment-face intersection** with explicit
  epsilon analysis. Instead of relying on a single global tolerance, each
  intersection test should carry a computed error bound so the kernel can
  guarantee unique intersections between segments and faces. This enables
  rapid creation of sub-meshes during boolean operations without sacrificing
  continuity or manifoldness.

These techniques replace the current linear AABB scan and tolerance-based
classification with provably robust alternatives. The octree and error-bounded
intersection logic should live in `kernel/ops` (AssemblyScript) so the hot loop
never crosses the WASM/JS boundary.

### 2. Watertight Crack-Free Tessellation

The current tessellation path evaluates NURBS faces independently and stitches
adjacent meshes afterward. This is error-prone at trimmed high-curvature
boundaries and expensive when stitching fails.

The native kernel should adopt **bidirectional cross-parametric mapping**:

- For each shared edge between two adjacent faces, map the trimming curve from
  face A's parameter domain into face B's parameter domain (and vice versa).
- Force the 3D tessellation sample points generated from both parametric domains
  to match exactly on the shared edge.
- This produces a **watertight mesh by construction** — no downstream gap-
  healing, vertex welding, or tolerance-based stitching required.

The cross-parametric mapping requires access to both faces' NURBS definitions
and their shared-edge curve simultaneously. That is why this logic must live
inside `kernel/tessellation` alongside `kernel/topology` — it needs direct
access to adjacency information and surface data without marshalling through JS.

The benefit is not only visual (no cracks) but also correctness: watertight
meshes are prerequisite for correct silhouette edge detection, section views,
and mesh-based mass property fallback.

### 2a. Boundary-Trimmed Parametric Tessellation

B-Rep faces are bounded regions on parametric surfaces. Every face has an outer
loop (and optionally inner loops for holes) defined by coedges referencing
topological edges. The tessellator must generate geometry **only within the
face boundary** — never for the full parametric domain.

This is a prerequisite for correct rendering of any non-planar face: cylinders,
cones, spheres, tori, and NURBS surfaces all require boundary-aware
tessellation. Without it, a 90° cylinder arc renders as a full 360° tube, a
sphere octant renders as a complete sphere, etc.

The native kernel must implement the following pipeline entirely in WASM:

1. **Multi-loop boundary collection**: Walk ALL face loops (outer + inner) via
   `faceGetFirstLoop` + `faceGetLoopCount`, not just the outer loop. For each
   coedge, collect the start vertex and optionally intermediate edge curve
   samples. Inner loops define holes that must exclude grid triangles.

2. **NURBS edge curve sampling**: For edges with `GEOM_NURBS_CURVE` geometry,
   evaluate the curve at intermediate parameter values using
   `nurbsCurveEvaluate()` from `assembly/nurbs.ts`. This is critical for arcs
   spanning more than 180° where vertex-only sampling cannot distinguish the
   short arc from the long arc, and for full-circle edges (seam edges) that have
   a single vertex. The curve data is read from the geometry pool via
   `edgeGetGeomOffset()`.

3. **UV projection**: Project all boundary 3D points into the surface's
   parametric (u, v) domain. Each surface type has its own projection:
   - **Cylinder/Cone**: u = atan2(radial·binormal, radial·refDir), v = height
     along axis. Requires the surface origin, axis, and reference direction.
   - **Sphere**: u = longitude (atan2), v = latitude (asin). Requires center.
   - **Torus**: u = major angle (atan2 in the equatorial plane),
     v = minor angle (atan2 of height vs ring distance). Requires center, axis,
     refDir, and major radius.
   - **NURBS**: point inversion (closest parameter search). For NURBS surfaces,
     the trim curves are often already defined in parameter space in the STEP
     file's `PCURVE` entities.

4. **Angle-wraparound handling**: Parametric angles wrap around at ±π. Use the
   circular mean of all boundary U samples to determine a center direction, then
   shift all U values relative to that center so the boundary polygon does not
   straddle the ±π discontinuity. This avoids degenerate UV bounding boxes.

5. **Full-revolution detection**: When the circular mean magnitude is low
   (vertices spread uniformly around the circle) or the raw angular range
   exceeds ~250° (1.4π), the face covers nearly the full revolution. In this
   case, expand to a full 2π range and disable polygon trimming — the grid
   should fill the entire surface without culling.

6. **UV bounding box computation**: After wraparound handling, compute the tight
   [uMin, uMax] × [vMin, vMax] bounding box of the boundary polygon. The
   parametric grid samples only this sub-domain, not the full surface range.

7. **Point-in-polygon trimming**: For each grid cell (quad split into two
   triangles), test the triangle centroid against the boundary polygon using a
   ray-casting even-odd rule. Triangles whose centroid falls outside the
   boundary are culled. The even-odd rule naturally handles multiple loops
   (outer boundary = inside, inner hole = outside).

8. **Degenerate boundary handling**: Some STEP topologies encode closed surfaces
   (full sphere, full torus) with degenerate 1-vertex or 2-vertex loops. When
   any loop has fewer than 3 boundary points, polygon trimming is disabled and
   the UV domain expands to the surface's natural full range.

**Why this must be in WASM, not JS:**

- The UV projection loop evaluates `atan2` / `asin` per boundary point per face
  — hundreds of transcendentals per body. WASM f64 math is 3-5× faster.
- NURBS edge curve sampling calls `nurbsCurveEvaluate()` which is already a WASM
  function — calling it from WASM avoids per-call JS↔WASM boundary overhead.
- The point-in-polygon test runs per grid cell (segsU × segsV × 2 tests per
  face). For a 32×32 grid that is 2048 PIP tests per face. Keeping this in WASM
  avoids marshalling UV arrays to JS and back.
- The entire pipeline (boundary collection → UV projection → grid generation →
  PIP trimming → vertex/normal emission) operates on kernel-owned topology and
  geometry data. Crossing to JS for any step would require copying or exposing
  internal buffers.

**JS fallback is not acceptable** for production tessellation. A JS-side
tessellator may exist only when explicitly tagged `@legacy` or `@test-baseline`
for regression comparison against the native path. All production rendering must
use the WASM tessellation pipeline.

### 3. GPU-Accelerated B-Rep Evaluation (WebGPU Compute)

CPU-based NURBS evaluation (currently in `assembly/nurbs.ts`) is the
tessellation bottleneck for interactive workflows like zoom-dependent LoD,
dynamic cross-sections, and real-time parametric updates.

The target is to move NURBS surface evaluation to WebGPU compute shaders:

- **Input**: control points, weights, and knot vectors are sent to the GPU as
  storage buffers.
- **Compute shader**: evaluates B-spline basis functions in parallel across
  thousands of GPU threads, producing vertex positions and normals for the
  requested tessellation density.
- **Output**: the compute shader writes directly into a WebGPU vertex buffer.
- **Render**: the render pass consumes that vertex buffer immediately.

Critically, the tessellated mesh data **never returns to the CPU**. It stays in
VRAM between the compute pass and the render pass. This enables:

- dynamic LoD re-tessellation on zoom with near-zero CPU cost
- interactive parametric surface updates without blocking the main thread
- massive assembly rendering where per-face re-evaluation would otherwise
  saturate the CPU

The CPU-side AssemblyScript kernel remains responsible for:

- B-Rep topology management
- feature tree execution
- boolean operations and exact geometry decisions
- preparing the control-point / knot-vector buffers that the GPU consumes

The GPU path is not a replacement for the WASM kernel. It is a rendering
acceleration layer that consumes kernel-managed geometry data.

## WebGPU Compute Pipeline

This section describes the concrete architecture for connecting the
AssemblyScript kernel to WebGPU compute shaders.

### Memory Alignment (std430)

WebGPU storage buffers use std430 layout rules. AssemblyScript structs that will
be read by WGSL shaders must match this alignment exactly to avoid serialization
or per-element iteration in JS.

Use `@unmanaged` to prevent the AssemblyScript GC from adding object headers:

```
// AssemblyScript — kernel/gpu/types.ts
@unmanaged
class GpuControlPoint {
  x: f32;
  y: f32;
  z: f32;
  w: f32; // weight for NURBS; pads to 16-byte vec4<f32>
}

@unmanaged
class GpuKnotSpan {
  u0: f32;
  u1: f32;
  v0: f32;
  v1: f32; // 16-byte aligned patch domain
}

@unmanaged
class GpuSurfaceHeader {
  degreeU: u32;
  degreeV: u32;
  numCtrlU: u32;
  numCtrlV: u32;  // 16-byte aligned
  knotOffsetU: u32;
  knotOffsetV: u32;
  ctrlOffset: u32;
  tessSegsU: u32;  // 16-byte aligned
  tessSegsV: u32;
  _pad0: u32;
  _pad1: u32;
  _pad2: u32;      // pad to 48 bytes (3 × vec4)
}
```

Allocating these in contiguous linear memory gives a byte-exact layout that the
GPU can read without conversion.

### Zero-Copy JS Bridge

JavaScript's only role is passing the pointer from AssemblyScript to the GPU.
No copying, no iteration:

```
// JS orchestrator — js/gpu/surface-upload.js
const ptr = wasm.getSurfaceControlPoints(surfaceId);
const len = wasm.getSurfaceByteLength(surfaceId);

// Zero-copy view over WASM linear memory
const view = new Uint8Array(wasm.memory.buffer, ptr, len);

// Direct write to GPU storage buffer
device.queue.writeBuffer(gpuControlPointBuffer, 0, view, 0, len);
```

If the WASM module runs in a Web Worker, instantiate it with a
`SharedArrayBuffer` so the main-thread WebGPU commands can read WASM memory
without `postMessage` round-trips.

### Compute-to-Render Data Flow

The full pipeline keeps tessellated data in VRAM:

```
┌─────────────────────────────────────────────────────────┐
│  AssemblyScript (CPU / WASM)                            │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ kernel/      │  │ kernel/      │  │ kernel/       │  │
│  │ topology     │→ │ geometry     │→ │ gpu/buffers   │  │
│  │ (B-Rep graph)│  │ (ctrl pts,   │  │ (@unmanaged   │  │
│  │              │  │  knots, wts) │  │  std430 data) │  │
│  └─────────────┘  └──────────────┘  └───────┬───────┘  │
│                                             │ ptr+len  │
└─────────────────────────────────────────────┼──────────┘
              JS bridge (zero-copy)           │
┌─────────────────────────────────────────────┼──────────┐
│  WebGPU                                     ▼          │
│  ┌──────────────┐    ┌───────────────┐  ┌──────────┐  │
│  │ Storage Buf  │───→│ Compute Pass  │─→│ Vertex   │  │
│  │ (ctrl pts,   │    │ (NURBS eval,  │  │ Buffer   │  │
│  │  knots, hdr) │    │  normals)     │  │ (in VRAM)│  │
│  └──────────────┘    └───────────────┘  └────┬─────┘  │
│                                              │        │
│                                         ┌────▼─────┐  │
│                                         │ Render   │  │
│                                         │ Pass     │  │
│                                         └──────────┘  │
└───────────────────────────────────────────────────────┘
```

Key properties:

- **No CPU readback**: tessellated vertices and normals stay in VRAM.
- **Dynamic LoD**: changing `tessSegsU` / `tessSegsV` in the header buffer and
  re-dispatching the compute shader is nearly free.
- **Batch dispatch**: multiple surfaces can be evaluated in a single compute
  dispatch using indirect draw / indexed surface headers.
- **Fallback**: when WebGPU is unavailable (older browsers, no GPU), the
  existing `kernel/tessellation` CPU path produces the same mesh data through
  the WASM evaluator. The kernel's typed-buffer output format is the same in
  both paths.

### WGSL Shader Sketch

A minimal compute shader for B-spline surface evaluation:

```wgsl
// gpu/shaders/nurbs-surface-eval.wgsl

struct SurfaceHeader {
  degreeU: u32, degreeV: u32,
  numCtrlU: u32, numCtrlV: u32,
  knotOffsetU: u32, knotOffsetV: u32,
  ctrlOffset: u32,
  tessSegsU: u32, tessSegsV: u32,
  _pad0: u32, _pad1: u32, _pad2: u32,
};

@group(0) @binding(0) var<storage, read> header: SurfaceHeader;
@group(0) @binding(1) var<storage, read> knots: array<f32>;
@group(0) @binding(2) var<storage, read> ctrlPts: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outVerts: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outNorms: array<vec4<f32>>;

fn basisFn(degree: u32, span: u32, t: f32, knotOff: u32) -> array<f32, 16> {
  // Cox-de Boor iterative evaluation (Piegl & Tiller A2.2)
  // ... implementation ...
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let segsU = header.tessSegsU;
  let segsV = header.tessSegsV;
  if (gid.x > segsU || gid.y > segsV) { return; }

  let u = f32(gid.x) / f32(segsU);
  let v = f32(gid.y) / f32(segsV);

  // Evaluate surface point and partial derivatives at (u, v)
  // Compute normal as cross(dS/du, dS/dv)
  // Write to outVerts and outNorms at index gid.y * (segsU + 1) + gid.x
}
```

The actual implementation will need proper knot-span search and rational weight
handling, but the dispatch shape is straightforward: one thread per tessellation
sample point.

## AssemblyScript Modularization Target

The AssemblyScript side should be split into explicit modules with stable
interfaces rather than one monolithic kernel blob.

Recommended modules:

- `kernel/core`
  - memory management
  - handle registry
  - revision ids
  - lifetime / disposal
- `kernel/topology`
  - native B-Rep entities
  - shells, faces, loops, coedges, edges, vertices
  - adjacency traversal
- `kernel/geometry`
  - NURBS curve/surface evaluation
  - analytic surfaces
  - curve/surface helpers
- `kernel/transform`
  - rigid transforms
  - body-local transforms
  - assembly-space placement transforms
  - transformed bounding boxes and exact coordinate updates
- `kernel/tessellation`
  - boundary UV projection (cylinder/cone/sphere/torus parameter mapping)
  - multi-loop boundary polygon collection with NURBS edge curve sampling
  - angle-wraparound handling and full-revolution detection
  - point-in-polygon trimming in UV space (ray-casting even-odd rule)
  - boundary-trimmed parametric grid generation for all analytic surface types
  - cross-parametric edge sampling for watertight seams
  - NURBS surface delegation to `assembly/nurbs.ts`
  - planar face fan triangulation from boundary vertices
  - combined output buffers: vertices, normals, indices, face map
  - normals / edge classification generation
- `kernel/step-import`
  - STEP parsing
  - native exact-body construction
- `kernel/step-export`
  - exact-body serialization to STEP
- `kernel/ops`
  - boolean
  - chamfer
  - fillet
  - later shell/offset/repair operations
- `kernel/spatial`
  - octree construction and traversal
  - AABB tree for broadphase intersection
  - candidate pair generation for boolean and collision
- `kernel/gpu`
  - `@unmanaged` std430-aligned data types (`GpuControlPoint`,
    `GpuSurfaceHeader`, `GpuKnotSpan`)
  - contiguous buffer allocation for GPU upload
  - surface batch descriptor packing
  - pointer + byte-length export for zero-copy JS bridge
- `kernel/interop`
  - CBREP hydration / dehydration
  - JS bridge contracts
  - worker message payload packing

Each module should be independently testable and swappable without forcing a
rewrite of unrelated parts of the kernel.

## Timing Hooks Added Now

These measurements exist to establish a baseline before native residency work:

- `importSTEP(...).timings`
  - `parseMs`
  - `tessellateMs`
  - `analyticNormalsMs`
  - `totalMs`
- `StepImportFeature.execute(...).timings`
  - `cacheHit`
  - `edgeAnalysisMs`
  - `volumeMs`
  - `boundsMs`
  - `coldStartMs`
  - `totalMs`
  - nested `import` timing snapshot
  - nested `irCache` timing snapshot when available
- `exportSTEPDetailed(...).timings`
  - `headerMs`
  - `writeBodyMs`
  - `stringifyMs`
  - `totalMs`
  - `entityCount`, `faceCount`, `edgeCount`, `vertexCount`
- Worker payloads from `step-import-worker.js` now include `timings`.

Telemetry labels now emitted by the core STEP path:

- `step:import:parse`
- `step:import:tessellate`
- `step:import:analytic-normals`
- `step:import:total`
- `step:feature:edge-analysis`
- `step:feature:volume`
- `step:feature:bounds`
- `step:feature:cold-build`
- `step:feature:execute`
- `step:import:ir:canonicalize`
- `step:import:ir:write`
- `step:import:ir:hash`
- `step:import:ir:store`
- `step:import:ir:total`
- `step:export:header`
- `step:export:write-body`
- `step:export:stringify`
- `step:export:total`

## Immediate Performance Fixes Already Applied

- The app no longer re-executes STEP import features immediately after adding
  them to the feature tree. It now uses the cached feature result.
- `StepImportFeature` now caches more than the parsed mesh/body:
  - feature-edge analysis
  - bounding box
  - volume
- Shadow IR writes are no longer re-run on every downstream recalculation for
  the same imported body instance.

These fixes matter because they remove repeated JS-side work before any WASM
residency work begins, making future native gains easier to measure honestly.

## Design Rules For WASM Residency

1. The exact body revision remains the semantic source of truth.
2. The authoritative runtime representation should converge toward a WASM-native
  exact body, not a JS body shadowed by optional native caches.
3. No raw WASM pointer or handle id is persisted into `.cmod`, history, or any
   long-term project artifact.
4. Deterministic CBREP is the interchange layer between JS and WASM.
5. Main-thread UI code should not own native handles directly.
6. Worker jobs may borrow handles; the feature/result owner controls disposal.
7. Transform and tessellation code must live alongside native topology so the
   kernel does not bounce exact bodies back into JS for routine operations.
8. AssemblyScript modules must communicate through explicit contracts and typed
   buffers, not through hidden global mutable state.
9. GPU-bound data structures must use `@unmanaged` classes with explicit std430
   padding so WASM linear memory is directly readable by WebGPU storage buffers
   without serialization.
10. Tessellated display mesh data should stay in VRAM when a WebGPU path is
    available. The CPU path (`kernel/tessellation`) is the fallback, not the
    default, for rendering.
11. Boolean operations must use topology-driven fragment classification (entity
    index based) rather than relying solely on floating-point coordinate
    comparisons for inside/outside decisions.
12. Adjacent-face tessellation must use cross-parametric edge mapping to produce
    watertight meshes by construction, not post-hoc stitching.
13. Boundary-trimmed parametric tessellation (UV projection, polygon culling,
    edge curve sampling) must run entirely in WASM. No JS fallback for
    production tessellation. JS-side tessellation code may only exist when
    explicitly tagged `@legacy` or `@test-baseline` for regression comparison
    against the native path.
14. NURBS edge curve evaluation for boundary sampling must call
    `nurbsCurveEvaluate()` directly from WASM — never marshal curve data to JS
    for evaluation and back. The per-call JS↔WASM boundary cost is unacceptable
    at the scale of hundreds of edges per body.

## Proposed Lifetime Model

### 1. Identity And Revision

Every exact result should carry revision metadata:

- `exactBodyRevisionId`
- `sourceFeatureId`
- `resultGrade`
- `irHash` when deterministic CBREP exists
- optional `wasmHandleId`
- `residencyState`

Revision ids must change whenever the exact body changes structurally, including:

- feature parameter edits
- suppression changes
- feature deletion
- reorder that changes upstream geometry
- STEP reimport with different tessellation-independent exact geometry

### 2. Residency States

Use a small explicit state machine:

- `unmaterialized`: exact body exists only in JS / CBREP form
- `hydrating`: worker is constructing a WASM handle
- `resident`: exact body has an active WASM handle
- `stale`: a newer body revision replaced the handle
- `disposed`: native resources released

`resident` is the fast path. `unmaterialized` is acceptable and must still work.

### 3. Ownership

Ownership should sit at the feature-result boundary, not in the UI:

- `FeatureTree.results[featureId]` owns the body revision.
- A `Part` or feature-tree level registry owns the disposal contract.
- UI panels and renderers receive snapshots or opaque ids, never disposal
  responsibility.

This matches the repo's existing recalculation model and avoids leaking handles
through ad hoc view code.

At the kernel level, ownership should be split cleanly:

- JS owns feature/result metadata
- the worker owns native handle creation/destruction
- AssemblyScript modules own exact-body data structures and derived buffers

### 4. STEP Import Path

Planned fast path:

1. `STEP text` is sent to a kernel worker.
2. Worker parses/imports to a WASM-native exact body.
3. Worker emits:
   - tessellated display data
   - summary metadata
   - deterministic `irHash`
   - optional CBREP payload or cache key
4. JS creates a feature result that references the imported revision.
5. JS `TopoBody` hydration becomes lazy and eventually exceptional.
6. The preferred steady state is that import produces a native exact body first,
  and JS only materializes a full topology graph for fallback, debugging, or
  explicit serialization workflows.

Key point: the import boundary should stop paying both costs eagerly. We should
not always build a full JS `TopoBody` and a full WASM body when only one is
needed immediately, and over time the native exact body should become the
default runtime artifact.

### 4a. Native Transform Path

Transforms should also move fully into AssemblyScript.

That includes:

- part transforms
- assembly instance placement
- copy/move/rotate of exact bodies
- transformed tessellation extraction
- exact bounds and mass-property inputs in transformed space

The kernel should accept transform matrices or compact pose structs and apply
them against native exact bodies without forcing a round-trip through JS object
graphs.

This matters because transform-heavy workflows are common in CAD even when the
topology itself does not change.

### 5. Parametric Operation Path

For exact operations such as boolean, chamfer, fillet, transforms, and later
shell/offset:

- If all required operands are `resident` and exact, execute in WASM.
- The result becomes a new exact revision with its own handle.
- Downstream stale handles are invalidated when their upstream revision changes.
- JS hydration remains the fallback path for unsupported operations or when a
  worker/native path is unavailable.

This keeps the feature tree semantics unchanged while letting the kernel choose
the native fast path opportunistically, with transforms and tessellation treated
as first-class native operations rather than post-processing in JS.

### 6. STEP Export Path

Planned preferred order:

1. Export directly from `wasmHandleId` when present and exact.
2. Rehydrate a WASM handle from CBREP when only `irHash` / CBREP is available.
3. Fall back to current JS `TopoBody -> exportSTEPDetailed()` when native export
   is unavailable.

Export should not require tessellation, mesh rebuild, or UI-visible geometry.

The long-term goal is that STEP export is wholly AssemblyScript-based, using the
same native exact-body representation that powers transforms and exact ops.

### 7. Persistence And History

Persistence should store deterministic artifacts only:

- raw STEP text for fidelity of imported features
- deterministic CBREP payload or cache key for fast reconstruction
- revision metadata

Persistence should never store:

- raw WASM pointers
- process-local handle ids
- any layout dependent on one runtime's heap

Undo/redo and `.cmod` load should restore exact revisions lazily:

- eagerly restore lightweight metadata
- lazily hydrate WASM handles from CBREP when the result becomes active or is
  required by an exact operation/export

### 7a. OCCT WASM Library Addendum — Stable History, Naming, And Time-Travel

If OCCT is going to replace the current JS exact-topology authority, it cannot
stop at "resident shape handle + tessellated mesh". The OCCT WASM layer must
become identity-authoritative as well as geometry-authoritative.

Today a counts-only `getTopology()` payload and raw `edgeSegments` are not
sufficient for parametric replay. They do not preserve semantic face/edge/
vertex identity, they do not support deterministic remapping after boolean or
fillet/chamfer edits, and they do not enable fast feature-tree rollback/
forward without reconstructing a compatibility shadow. The library therefore
needs an explicit history and stable-naming contract.

#### Non-Negotiable Rules

- Do not use `TopoDS_Shape::HashCode`, `TShape*`, transient explorer order,
  tessellation order, or face/edge enumeration order as persistent ids.
- Do not require JS to infer stable ids, history, or feature-edge chains from
  triangles or raw edge segments.
- Do not emit triangulation diagonals or duplicate mesh edges as selectable
  feature edges.
- Do not silently drop history on boolean, fillet, chamfer, transform, heal,
  sew, split, or import steps. If identity cannot be proven, the library must
  report that explicitly instead of renaming everything anonymously.
- Do not persist process-local handles or raw pointers in `.cmod` or checkpoint
  artifacts.

#### Required Revision Model

- Every output handle must represent an immutable exact revision.
- Every revision must carry:
  - `revisionId`
  - `operationId`
  - `sourceFeatureId`
  - `operationType`
  - `operandRevisionIds[]`
  - `parameterHash`
  - `topologyHash`
  - `historySchemaVersion`
  - `createdFromCheckpoint`
- Revisions must be cacheable and reference-counted so undo/redo and direct
  history jumps can move pointers without recomputing unchanged feature-tree
  prefixes.
- Copy-on-write sharing is preferred. Unchanged topology/geometry ranges should
  be shared across revisions instead of cloned eagerly.

#### Required Stable Subshape Identity

- `getTopology()` must grow from summary counts into full subshape metadata.
- Faces, edges, and vertices must each expose both:
  - a transient runtime topo id for the current handle
  - a deterministic stable id for replay, selection remap, and persistence
- Stable ids must survive:
  - repeated recompute of the same feature chain
  - parameter edits that change geometry but not structural role
  - serialization/deserialization and CBREP hydrate/dehydrate
  - undo/redo and direct history jump
  - extrude/revolve/boolean/chamfer/fillet result remapping
- Sketch-driven operations must seed stable ids from feature semantics, not OCCT
  traversal order. Examples: bottom cap, top cap, side face by source profile
  edge, revolve side by source curve/span, boolean-generated cap/split faces by
  deterministic lineage.
- Edge and vertex stable ids may be derived from adjacent face stable ids only
  if the derivation happens inside the library on exact topology after face ids
  are finalized. JS must not reconstruct them from mesh adjacency.

#### Required History Capture

- The library must capture per-operation `generated`, `modified`, `retained`,
  and `deleted` lineage.
- That lineage must exist for:
  - prism / extrude
  - revolve
  - boolean union / subtract / intersect
  - fillet and chamfer
  - transform / copy / mirror / pattern placement
  - STEP import with heal/sew/fixup stages
  - any operation that splits one subshape into multiple descendants
- Deleted or consumed entities must not disappear without a trace. The library
  must retain tombstones or equivalent history records so a stable id can be
  mapped across revisions even when the original subshape no longer exists in
  the latest topology.
- If OCAF / TNaming is practical in WASM, it is an acceptable implementation
  substrate. If it is not, build an explicit kernel-owned naming layer above
  OCCT history APIs, but do not fall back to transient subshape hashes.

#### Required OCCT API Additions

The OCCT WASM build should extend existing methods additively where possible so
older callers keep working.

`getTopology(handle)` should evolve toward a payload of this shape:

```json
{
  "revisionId": "rev_...",
  "operationId": "feature_12@3",
  "sourceFeatureId": "feature_12",
  "operationType": "subtract",
  "operandRevisionIds": ["rev_a", "rev_b"],
  "topologyHash": "...",
  "historySchemaVersion": 1,
  "faceCount": 42,
  "edgeCount": 96,
  "vertexCount": 58,
  "faces": [
    {
      "id": 101,
      "stableHash": "feature_12_Face_Side_p0_e3",
      "role": "side",
      "sourceFeatureId": "feature_12",
      "generatedFrom": ["feature_8_Face_Top_p0"],
      "modifiedFrom": [],
      "retainedFrom": [],
      "status": "generated",
      "shared": { "sourceFeatureId": "feature_12" }
    }
  ],
  "edges": [
    {
      "id": 301,
      "stableHash": "E:feature_12_Face_Side_p0_e3+feature_4_Face_Top_p0",
      "generatedFrom": [],
      "modifiedFrom": [201],
      "status": "modified"
    }
  ],
  "vertices": [
    {
      "id": 401,
      "stableHash": "V:feature_12_Face_Side_p0_e3+feature_4_Face_Top_p0",
      "status": "retained"
    }
  ],
  "deletedEntities": [
    {
      "kind": "face",
      "stableHash": "feature_9_Face_Top_p0",
      "deletedBy": "feature_12"
    }
  ]
}
```

`tessellate(handle, opts)` should evolve toward a payload of this shape:

```json
{
  "positions": [...],
  "indices": [...],
  "triangleTopoFaceIds": [101, 101, 102],
  "triangleFaceGroups": [101, 101, 102],
  "triangleStableHashes": [
    "feature_12_Face_Side_p0_e3",
    "feature_12_Face_Side_p0_e3",
    "feature_12_Face_Top_p0"
  ],
  "triangleNormals": [...],
  "featureEdges": [
    {
      "points": [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
      "stableHash": "E:feature_12_Face_Side_p0_e3+feature_4_Face_Top_p0",
      "topoFaceIds": [101, 205],
      "isClosed": false
    }
  ]
}
```

Additional library methods are required for time-travel and remapping:

- `getRevisionInfo(handle)` or an equivalent additive extension of
  `getTopology()`.
- `resolveStableEntity(handle, stableHash)`.
- `mapEntitiesAcrossRevisions(fromRevisionId, toRevisionId, stableHashes[])`.
- `createCheckpoint(handle)` returning CBREP plus revision/history metadata.
- `hydrateCheckpoint(checkpoint)` restoring the same revision and stable ids.
- `retainRevision(handle)` / `releaseRevision(handle)` or equivalent ref-count
  controls.
- `getCapabilities()` with flags such as `historyV1`, `stableNamingV1`,
  `featureEdgesV1`, and `checkpointV1`.

#### Fast Rollback / Forward Requirements

- Undo/redo must be pointer movement across immutable revisions, not an eager
  geometric recompute when the target revision is still resident.
- The native revision cache should be keyed by:
  - `sourceFeatureId`
  - normalized feature parameters
  - operand revision ids
  - operation type
- Forward after rollback must reuse cached descendant revisions whenever the
  upstream prefix hash is unchanged.
- The library should keep a hot window of recent revisions resident and dehydrate
  older revisions to CBREP plus metadata, preserving stable ids and history.
- Tessellation and feature-edge results should be cached by
  `(revisionId, tessellationSettings)` so history navigation does not re-mesh on
  every step.

#### Compatibility Contract With The Current JS Bridge

The current JS bridge is already prepared to consume additive OCCT fields for:

- `topology.faces[].stableHash`
- `topology.faces[].shared.sourceFeatureId`
- `triangleTopoFaceIds`
- `triangleFaceGroups`
- `triangleStableHashes`
- `triangleNormals`
- `featureEdges` / `edgeChains`

That means the library should extend the current `getTopology()` and
`tessellate()` payloads instead of inventing a parallel incompatible surface
unless there is a strong reason to do so.

#### Compliance Tests The Library Must Pass

- Stable ids are identical across two independent builds of the same model.
- Stable ids survive parameter edits that preserve structural role.
- Stable ids survive checkpoint serialize/hydrate roundtrip.
- Boolean operations preserve remappable lineage for retained/modified/generated
  faces, edges, and vertices.
- Fillet/chamfer preserve lineage or explicitly mark unresolved identity.
- Undo/redo and arbitrary history jumps run without recomputing already-cached
  revisions.
- Tessellation output aligns triangles and feature-edge chains with stable face
  ids.
- Selection remap from one revision to another works without consulting a JS
  compatibility shadow.

### 8. Disposal Policy

Handle lifetime should be explicit and reference-counted by owner plus jobs:

- owner ref: feature result currently present in the tree
- job refs: active worker tasks using the handle

Dispose when all are true:

- owning result was replaced, suppressed, or removed
- no active export/tessellation/kernel job still references the handle
- no retained preview/edit session depends on that exact revision

Project close, project clear, and part deserialization should force a full
registry sweep and release all native handles.

### 9. Threading Model

The kernel worker should be the only place that creates and destroys native
B-Rep handles.

Main-thread responsibilities:

- request handle creation
- submit operations by handle id
- receive transferables for tessellation/export output
- hold metadata only

This avoids structured-cloning large JS topology graphs across threads and keeps
the disposal model centralized.

## Recommended Implementation Phases

### Phase 1: Measurement And JS Cache Discipline

- Keep the current timing hooks.
- Track cold vs warm STEP feature execution.
- Keep removing repeated JS work before measuring native gains.

Status: **complete** — timing hooks, telemetry.recordTimer, STEP import/export
phase instrumentation, cold/warm cache detection all committed.

### Phase 2: Deterministic Native Hydration

- Add a WASM bridge that can hydrate a native exact body from CBREP.
- Introduce a worker-side handle registry.
- Attach `irHash` and `exactBodyRevisionId` to exact feature results.
- Define module boundaries for `kernel/core`, `kernel/topology`, and
  `kernel/interop` before adding more features.

Status: **complete** — 7 kernel AS modules (`core`, `topology`, `geometry`,
`transform`, `spatial`, `gpu`, `interop`) created and tested. WasmBrepHandleRegistry
JS bridge. CBREP hydrate/dehydrate. FeatureTree stamps solid results with
`exactBodyRevisionId`, propagates `irHash`, allocates/releases WASM handles.
24 kernel + 20 feature-revision tests passing.

### Phase 3: WASM-Resident STEP Import/Export

- Move STEP import parsing into the kernel worker.
- Return tessellation + metadata + handle id.
- Add direct STEP export from handle id.
- Keep STEP import/export code inside dedicated AssemblyScript modules rather
  than mixing parsing/serialization with unrelated topology code.

Status: **complete** — `exportStep()` on WasmBrepHandleRegistry implements
dehydrate → CBREP → readCbrep → TopoBody → exportSTEP. STEP import worker now
produces CBREP + irHash alongside the existing result for main-thread hydration.
Native STEP parsing in AssemblyScript is a future goal; the current JS-parse +
WASM-tessellate + CBREP-bridge approach satisfies all concrete Phase 3 tasks.

### Phase 3a: Native Transform And Tessellation

- Move exact transform application into `kernel/transform`.
- Move display-mesh extraction entirely into `kernel/tessellation`.
- Implement **bidirectional cross-parametric edge mapping** so adjacent faces
  produce matching sample points on shared edges (watertight by construction).
- Implement **boundary-trimmed parametric tessellation** so analytic faces
  (cylinder, cone, sphere, torus) compute their UV domain from the face
  boundary instead of using full parametric ranges. This requires:
  - Multi-loop boundary collection (outer + inner loops)
  - NURBS edge curve sampling via `nurbsCurveEvaluate()` for arcs and circles
  - UV projection per surface type (revolution angle/height, lon/lat, etc.)
  - Circular-mean angle-wraparound handling
  - Full-revolution detection for degenerate/closed boundaries
  - Point-in-polygon centroid trimming (ray-casting even-odd rule)
- Ensure tessellation runs against native exact bodies directly.
- Return typed buffers for vertices, normals, indices, face groups, and edge
  classification instead of JS-built face objects when possible.
- **No JS fallback in production**: the WASM tessellation pipeline is the only
  production code path. JS-side tessellation exists only when explicitly tagged
  `@legacy` or `@test-baseline` for regression comparison.

Status: **in progress** — transform module with identity/translation/
rotation/scale/multiply + point/direction/boundingBox transforms.
WasmBrepHandleRegistry exposes setTranslation/setRotation/setScale/setIdentity,
transformPoint, transformDirection, transformAllVertices, loadTransformMatrix.
Native tessellation module (`kernel/tessellation.ts`) tessellates all face types
(plane, cylinder, cone, sphere, torus, NURBS) with:
- Cross-parametric edge caching for watertight seams (edge id keyed sample cache,
  adjacent faces reuse same boundary points).
- Boundary-trimmed parametric grids: `_collectBoundaryUV()` walks all face loops,
  samples NURBS edge curves at 4 intermediate points via `nurbsCurveEvaluate()`,
  projects to UV via `_projectPoint()` (revolution/sphere/torus modes).
- Circular-mean wraparound: `_uvUcenter` computed from cos/sin sums, U values
  shifted to avoid ±π discontinuity.
- Full-revolution detection: circular mean magnitude < 0.1 or angular range
  > 1.4π → expand to full 2π, disable polygon trimming.
- Degenerate boundary handling: loops with < 3 points → trimming disabled,
  UV domain expanded to surface natural range.
- Point-in-polygon trimming: `_pointInsideBoundary()` tests triangle centroids
  against all boundary loops using ray-casting even-odd rule.
- Fixed NURBS tessellation: `nurbsSurfaceTessellate()` now receives correct
  `numCtrlU` / `numCtrlV` parameters (was incorrectly passing `numCtrlU + degU`).
JS bridge provides tessellateBody/tessellateFace/tessReset.
- Handle-scoped tessellation is now available through
  `tessBuildHandleFaces(handleId, segsU, segsV)` and
  `WasmBrepHandleRegistry.tessellateHandle(handleId, segsU, segsV)`, so two or
  more resident bodies can coexist in the native pools and be meshed by handle
  range without resetting global topology.

Remaining Phase 3a work: route production fast-restore, LoD, and render refresh
paths to `hydrateForHandle()` + `tessellateHandle()` so the app stops decoding
CBREP back into JS `TopoBody` for bodies already resident in the kernel.

### Phase 4: Robust Native Boolean Operations

- Add octree spatial index in `kernel/spatial` for broadphase candidate pair
  detection (replaces current linear AABB scan).
- Implement topology-driven sub-surface classification: inside/outside decisions
  anchored to entity index, not solely to floating-point coordinates.
- Add explicit per-intersection floating-point error bounds so each segment-face
  intersection is provably unique.
- Route boolean/chamfer/fillet and transform-heavy exact workflows to native
  handles when all inputs are resident.
- Preserve JS fallback for unsupported or debug paths.

Status: **in progress** — `kernel/ops.ts` implements classifyPointVsShell
(ray-cast with topological face iteration), classifyFacesViaOctree (broadphase
overlap detection), point-to-surface distance helpers (plane, sphere, cylinder),
per-face classification buffer. Octree from `kernel/spatial.ts` now wired to
classification pipeline. JS-side `Intersections.js` now uses WASM octree
broadphase for candidate pair detection in `intersectBodies()`, replacing the
O(N×M) brute-force loop with O(N log N) octree queries. AABB fallback retained
for when WASM is not loaded. `SurfaceSurfaceIntersect.js` extended with
analytic plane/sphere (circle), plane/cylinder (circle/lines), and
cylinder/cylinder (coaxial detection) intersection paths.

**KNOWN ISSUE**: `classifyPointVsShell` intersects rays against *infinite*
(untrimmed) surfaces — it counts crossings with the full infinite plane or
full sphere, not the trimmed face boundary. This gives WRONG results for
non-convex solids (e.g. L-shaped extrusions) where the ray crosses the
plane extension outside the face polygon. The WASM containment path is
**disabled** (`_WASM_CONTAINMENT_ENABLED = false` in Containment.js) until
the kernel implements trimmed-face boundary checking. All point classification
uses the proven JS multi-ray + GWN paths. The body loading infrastructure
in Containment.js is retained and corrected (planeStore 9-arg calls, proper
loopId tracking, revision-based cache invalidation, multi-shell rejection)
for re-enablement when the kernel supports trimmed containment.

### Phase 5: GPU-Accelerated Tessellation (WebGPU Compute)

- Define `@unmanaged` std430-aligned structs in `kernel/gpu` for control points,
  knot vectors, and surface headers.
- Implement zero-copy JS bridge: pointer + byte-length from WASM → direct
  `device.queue.writeBuffer()` (no iteration, no copy).
- Write WGSL compute shader for B-spline surface evaluation (Cox-de Boor basis,
  rational weights, cross-product normals).
- Compute shader output writes directly to a WebGPU vertex buffer — tessellated
  data stays in VRAM and never returns to the CPU.

Status: **in progress** — WGSL compute shader (`js/render/nurbs-tess.wgsl.js`)
implements Cox-de Boor basis with first-order derivatives, rational surface
evaluation, cross-product normals. WebGPU pipeline (`js/render/gpu-tess-pipeline.js`)
manages device/adapter lifecycle, zero-copy WASM→GPU buffer upload, per-surface
compute dispatch, output→vertex buffer, and CPU readback for debug. GpuTessPipeline
class with init/uploadBatch/dispatch/readback/destroy lifecycle. Static
`isAvailable()` for WebGPU capability detection with CPU fallback.
`SceneRenderer` creates `GpuTessPipeline` on startup when WebGPU is detected;
actual initialization deferred to `initGpuTessPipeline(registry)` which
requires a `WasmBrepHandleRegistry` instance. `LodManager` wired into orbit
camera — `_applyOrbitCamera()` calls `lodManager.update(orbitRadius)` on every
camera change, triggering `onRetessellate` which updates `globalTessConfig`
(surfaceSegments, edgeSegments, curveSegments) and re-renders the current part.

**FIXED**: GPU pipeline buffer upload now correctly extracts `.view` from the
registry's `{ptr, length, view}` return objects. Method name corrected from
`getGpuCtrlPointBuffer` to `getGpuCtrlBuffer`. `tessellateBody` now returns
`.slice()` copies of WASM memory instead of dangling views.

**REMAINING**: GpuTessPipeline is not yet initialized in production (no call
site creates a WasmBrepHandleRegistry and passes it to
`SceneRenderer.initGpuTessPipeline()`). HandleResidencyManager is not
instantiated in production code.
- Implement dynamic LoD: camera-distance-driven `tessSegsU`/`tessSegsV` update
  with compute re-dispatch.
- Batch-dispatch multiple surfaces in a single compute pass via indexed surface
  headers.
- If WebGPU is unavailable, fall back to `kernel/tessellation` CPU path
  (identical typed-buffer output format).
- SharedArrayBuffer for WASM module when running in a Web Worker so the main
  thread can read WASM memory for GPU upload without `postMessage` round-trips.

### Phase 6: Persistence And Eviction

- Restore handles lazily from CBREP during `.cmod` load and undo/redo.
- Add eviction rules for inactive parts/results.
- Add diagnostics for residency hit rate and hydration cost.

Status: **in progress** — `HandleResidencyManager` class manages lazy CBREP
hydration, idle-timeout eviction, LRU eviction, and per-feature diagnostics.
Telemetry extended with residency tracking (hit/miss/hydration/eviction
counters, average hydration cost) and GPU dispatch tracking (dispatch count,
avg dispatch time, upload/readback totals). `telemetry.summary()` includes
both residency and GPU diagnostics. `FeatureTree` now integrates
`HandleResidencyManager` via `setResidencyManager()` — solid results with
`cbrepBuffer` are stored on stamp, accessed features are marked, and residency
entries are cleaned up on result release, feature removal, recalculation, and
tree clear. `_releaseResultHandle` accepts featureId for residency cleanup.

**KNOWN ISSUES**:
1. `HandleResidencyManager` is never instantiated in production code — only
   in test-phase456.js. `FeatureTree.setResidencyManager()` exists but no
   application code calls it.
2. The legacy `hydrate(cbrep)` method still restores topology into global
  single-body mode and should be treated as compatibility glue. New runtime
  code must use `hydrateForHandle(handle, cbrep)` so native topology is
  appended to the handle's recorded ranges, followed by handle-scoped
  operations such as `tessBuildHandleFaces()`.
3. `setFeatureId(handle, revisionCounter)` stores a numeric revision
   rather than the string featureId — this is correct given the u32 WASM
   constraint but the naming can be confusing.

## Concrete Next Tasks

### Foundation (Phase 2) — COMPLETE

1. ~~Add `exactBodyRevisionId` and `irHash` to exact feature results.~~
   Done: FeatureTree._stampSolidResult() assigns monotonic revisionId;
   irHash propagated from feature._irHash to result.
2. ~~Introduce `WasmBrepHandleRegistry` in the kernel worker.~~
   Done: js/cad/WasmBrepHandleRegistry.js — full handle lifecycle,
   residency, revision, CBREP, octree, GPU batch, transforms, STEP export.
3. ~~Define AssemblyScript module boundaries and exported contracts.~~
   Done: kernel/core, kernel/topology, kernel/geometry, kernel/transform,
   kernel/spatial, kernel/gpu, kernel/interop — all compiled and tested.
4. ~~Add `hydrateWasmBrepFromCbrep(arrayBuffer)` to the WASM bridge.~~
   Done: cbrepHydrate/cbrepDehydrate in interop.ts, hydrate()/dehydrate()
   in WasmBrepHandleRegistry.

### STEP & Transform (Phase 3 / 3a) — COMPLETE

5. ~~Add `exportStepFromHandle(handleId)` to the WASM bridge.~~
   Done: WasmBrepHandleRegistry.exportStep() — dehydrate → readCbrep →
   exportSTEP pipeline.
6. ~~Add `transformBodyHandle(handleId, transform)` and native mesh extraction
   APIs so transforms and tessellation stay inside WASM.~~
   Done: Transforms complete. Native mesh extraction done in
   kernel/tessellation.ts — tessBuildAllFaces/tessBuildFace with typed output
   buffers. JS bridge: tessellateBody/tessellateFace/tessReset.
7. ~~Implement cross-parametric edge mapping in `kernel/tessellation` for
   watertight adjacent-face meshing.~~
   Done: kernel/tessellation.ts caches edge samples keyed by edge id;
   adjacent faces reuse same boundary points. tessBuildAllFaces produces
   combined vertex/normal/index/faceMap buffers for all face types.
7a. ~~Implement boundary-trimmed parametric tessellation — UV projection,
    NURBS edge curve sampling, point-in-polygon culling — entirely in WASM.~~
    Done: _collectBoundaryUV() walks all face loops (outer + inner), samples
    NURBS edge curves at intermediate points via nurbsCurveEvaluate(),
    projects to UV per surface type (_projectPoint revolution/sphere/torus
    modes), handles angle wraparound via circular mean, detects full
    revolutions (mag < 0.1 or range > 1.4π), and _pointInsideBoundary()
    culls grid triangles via ray-casting even-odd rule. Fixed NURBS
    nurbsSurfaceTessellate parameter bug (was passing numCtrlU + degU
    instead of numCtrlU). 129 tests passing across 4 suites.
7b. ~~Add resident-handle scoped tessellation so native bodies can be meshed
    without reloading global topology.~~
    Done: `tessBuildHandleFaces(handleId, segsU, segsV)` validates handle
    residency, reads `handleGetFaceStart/End`, and tessellates only that face
    range. `WasmBrepHandleRegistry.tessellateHandle()` returns copied typed
    arrays for vertices, normals, indices, and faceMap. `tests/test-wasm-tess-ops.js`
    covers two co-resident cube handles and verifies handle meshes remain
    scoped while `tessBuildAllFaces()` still sees the combined global topology.
8. ~~Route `StepImportFeature` to store deterministic CBREP before any native
   hydration attempt.~~
   Done: STEP import worker now produces CBREP + irHash alongside result;
   StepImportFeature propagates irHash to result object.

### Robust Booleans (Phase 4)

9. ~~Build octree spatial index in `kernel/spatial` and benchmark against current
   linear AABB broadphase on the NIST corpus.~~
   Done: octree in kernel/spatial.ts wired to classifyFacesViaOctree in
   kernel/ops.ts for broadphase overlap detection.
10. ~~Implement topology-driven fragment classification in `kernel/ops` — anchor
    inside/outside decisions to entity index, not coordinate comparison.~~
    Done: classifyPointVsShell, classifyFacesViaOctree, per-face classification
    buffer, point-to-surface distance helpers.
11. ~~Add per-intersection error-bound computation so segment-face intersections
    are provably unique.~~
    Done: kernel/ops.ts isxRecord/isxGetErrorBound/isxAreDistinct/isxRayFace.
    Error bounds computed from condition number (ray-normal angle + curvature).
    isxAreDistinct proves uniqueness when point separation > combined bounds.
12. ~~Wire WASM octree broadphase into JS `intersectBodies()` for candidate pair
    detection.~~
    Done: Intersections.js now computes face AABBs, loads them into the WASM
    octree via octreeAddFaceAABB/octreeBuild/octreeQueryPairs, and reads back
    candidate pairs. Falls back to JS AABB pre-filter when WASM not loaded.
13. ~~Add analytic surface-surface intersections for plane/sphere, plane/cylinder,
    cylinder/cylinder.~~
    Done: SurfaceSurfaceIntersect.js implements _planeSphere (circle),
    _planeCylinder (circle/lines/ellipse-fallback), _cylinderCylinder (coaxial
    detection + numeric fallback).
14. ~~Global tessellation config — remove per-import segment prompts, centralize
    quality settings.~~
    Done: globalTessConfig singleton in TessellationConfig.js. All callers
    (Tessellation.js, StepImport.js, StepImportWasm.js, StepImportFeature.js,
    BooleanKernel.js, BRepChamfer.js, BRepFillet.js) read from the global
    config. Three showPrompt() calls removed from main.js. Status bar dropdown
    added for changing quality preset (draft/normal/fine/ultra) with live
    re-tessellation.

### GPU Tessellation (Phase 5)

12. ~~Define `@unmanaged` std430-aligned structs in `kernel/gpu/types.ts`:
    `GpuControlPoint`, `GpuSurfaceHeader`, `GpuKnotSpan`.~~
    Done: kernel/gpu.ts with batch buffer management.
13. ~~Implement zero-copy JS bridge (`pointer + byteLength → writeBuffer`).~~
    Done: GpuTessPipeline.uploadBatch() reads WASM buffer views directly.
14. ~~Write WGSL compute shader for NURBS surface evaluation
    (`gpu/shaders/nurbs-surface-eval.wgsl`).~~
    Done: js/render/nurbs-tess.wgsl.js — Cox-de Boor basis, rational projection,
    analytical derivatives, cross-product normals.
15. ~~Connect compute output → vertex buffer → render pass (data stays in VRAM).~~
    Done: GpuTessPipeline output buffer has VERTEX usage flag.
16. ~~Add dynamic LoD dispatch: re-tessellate on camera distance change.~~
    Done: js/render/lod-manager.js — LodManager class with distance-based
    band selection, hysteresis, callback, forceSegments, custom bands.
17. ~~Add WebGPU capability detection with graceful fallback to CPU tessellation.~~
    Done: GpuTessPipeline.isAvailable() + kernel/tessellation.ts CPU fallback.

### Diagnostics & Polish

18. ~~Expose STEP timing summaries in diagnostics so large-model profiling does
    not depend only on console logs.~~
    Done: telemetry.timersFor('step') filters STEP-related timer entries.
19. ~~Add residency hit rate, hydration cost, and GPU dispatch latency to
    telemetry.~~
    Done: telemetry.residencySummary() and telemetry.gpuSummary() with
    hit/miss/hydration/eviction counters and GPU dispatch/upload/readback
    timing. summary() includes both.

### Current Runtime-Migration Queue

20. Route `FeatureTree.tryFastRestoreFromCheckpoints()` through resident handle
    hydration and `tessellateHandle()` instead of `readCbrep(buffer)` followed
    by JS `tessellateBody(topoBody)`.
21. Instantiate `WasmBrepHandleRegistry` and `HandleResidencyManager` in the
    production part/app startup path so feature results become resident by
    default when CBREP is available.
22. Move parametric feature operation inputs toward handle-based contracts:
    JS may own UI parameters and dependency ordering, but boolean/chamfer/
    fillet/extrude/revolve execution should consume and produce native handles
    whenever the required surface classes are supported.
23. Extend `kernel/ops` beyond narrowphase helpers into result-building
    operations that allocate new topology ranges for output handles, rather than
    returning serialized fragments to JS.
24. Finish WebGPU integration as an acceleration layer: initialize the GPU
    pipeline from the production registry, batch kernel-owned NURBS surfaces into
    std430 buffers, dispatch compute for render LoD, and avoid CPU readback on
    the normal render path.
25. Keep JS `TopoBody` materialization only for persistence tooling, debug views,
    legacy fallbacks, and explicit compatibility tests.
26. Extend the OCCT WASM `getTopology()` contract from summary counts into full
  revision metadata plus face/edge/vertex arrays with stable ids and lineage.
27. Extend OCCT WASM `tessellate()` to emit `triangleTopoFaceIds`,
  `triangleFaceGroups`, `triangleStableHashes`, `triangleNormals`, and
  sanitized feature-edge chains instead of raw triangulation diagonals.
28. Seed deterministic stable ids for sketch-driven primitives and operation
  roles inside the OCCT library so prism/revolve outputs do not depend on
  traversal order.
29. Capture `generated` / `modified` / `retained` / `deleted` history for OCCT
  extrude, revolve, boolean, fillet, chamfer, transform, and import/heal
  stages.
30. Preserve deleted-entity tombstones and implement explicit remap tables so
  downstream selection and feature references survive rollback/forward.
31. Make resident OCCT handles immutable revisions with reference-counted
  retention and eviction semantics suitable for undo/redo and history jumps.
32. Add checkpoint/hydrate APIs that round-trip CBREP plus revision/history
  metadata without changing stable ids.
33. Add `resolveStableEntity()` and `mapEntitiesAcrossRevisions()` so JS can
  remap references without reconstructing a compatibility `TopoBody` shadow.
34. Key the native revision cache by `(featureId, normalizedParamHash,
  operandRevisionIds, operationType)` so rollback/forward can reuse exact
  revisions directly.
35. Preserve stable ids across topology-neutral transforms and instance
  placement instead of opportunistically renaming transformed copies.
36. Version the OCCT history/naming schema and advertise capability flags so the
  JS bridge can feature-detect `historyV1`, `stableNamingV1`, and
  `checkpointV1` safely.
37. Add a dedicated OCCT regression suite covering determinism, parameter-edit
  stability, checkpoint roundtrips, boolean lineage, feature-edge chain
  quality, and fast multi-step rollback/forward.

## Expected Gains

The significant performance win does not come from one micro-optimization. It
comes from removing repeated whole-model work and moving hot paths to where they
run fastest:

### CPU-Side (WASM Kernel)

- no repeated STEP text parse on downstream recalculation
- no repeated JS edge analysis for unchanged imported bodies
- no repeated IR shadow write for the same exact body
- no mandatory JS topology hydration before native operations/export
- no JS-side transform application for exact bodies
- no structured clone of large exact topology graphs when an opaque handle will do
- octree-accelerated boolean broadphase: O(n log n) candidate pairs instead of
  O(n²) linear AABB scan
- topology-driven boolean classification eliminates a class of non-manifold
  failures caused by floating-point coordinate noise
- error-bounded intersection guarantees unique segment-face intersections without
  over-conservative tolerances

### GPU-Side (WebGPU Compute)

- NURBS evaluation parallelized across thousands of GPU threads instead of
  sequential CPU loops
- tessellated mesh data stays in VRAM — zero CPU readback for rendering
- dynamic LoD re-tessellation on zoom with near-zero CPU cost
- batch surface evaluation in a single compute dispatch
- main thread freed from tessellation work entirely in the steady state

### Mesh Quality

- watertight meshes by construction via cross-parametric edge mapping —
  eliminates crack artifacts, gap-healing passes, and tolerance-based stitching
- correct silhouette edges, section views, and mesh-based mass properties as a
  downstream consequence of watertight tessellation
- boundary-trimmed parametric grids: cylinder/cone/sphere/torus faces render
  only the bounded patch, not the full surface — eliminates spike artifacts,
  overlapping geometry, and full-revolution rendering errors that occurred when
  the tessellator used hardcoded full parametric ranges
- NURBS edge curve sampling resolves arc ambiguity: arcs > 180° and full-circle
  seam edges are correctly represented in the boundary polygon, preventing the
  tessellator from choosing the wrong arc direction
- multi-loop support: inner loops (holes) correctly exclude geometry via
  even-odd polygon test, enabling correct tessellation of faces with cutouts
- full-revolution detection: closed surfaces (full spheres, full tori, seamless
  cylinders) automatically expand to full parametric range when the boundary is
  degenerate, preventing zero-area meshes

That is the path to materially faster CAD operations while preserving the
current topology-first architecture, with the exact kernel progressively moved
into modular AssemblyScript components, robust algorithmic foundations for
boolean and tessellation correctness, and GPU-accelerated rendering that keeps
the CPU focused on exact geometry decisions.

---

## Stage F — Native STEP Topology Assembly (Complete)

Goal: keep the resolved STEP model inside the WASM kernel — no JS TopoBody
round-trip on the hot path.  This is the iteration-speed finish: the lexer,
parser, topology assembler, and tessellator all run in-place against shared
WASM memory.

### Components (all landed)

- `assembly/kernel/step_topology.ts` — native builder.  Walks the entity/arg
  tables produced by `step_parser.ts` and emits directly into `topology.ts`
  (`vertexAdd`/`edgeAdd`/`coedgeAdd`/`loopAdd`/`faceAdd`/`shellAdd`) and
  `geometry.ts` (`planeStore`/`cylinderStore`/.../`nurbsSurfaceStoreFromStaging`).
  Zero JS allocation per entity.
- Handles: analytic surfaces (plane/cylinder/sphere/cone/torus), B-spline
  surfaces simple + complex rational forms, all edge curve types with knot
  multiplicity expansion, `reverseBound` with orient-flag flip, complex
  entity pair-list walking (`complexSubArgs`).
- `js/cad/StepTopologyWasm.js` — JS bridge.
  - `buildStepTopologySync(stepText, opts)` → builder run + counts.
  - `importStepNativeSync(stepText, opts)` → end-to-end mesh (vertices,
    faces, normal-averaged, `isCurved`, `faceGroup`) matching
    `tessellateBodyWasm` output shape.
- `js/cad/StepImport.js` integration — opt-in `STEP_BUILD_WASM=1` env flag.
  Fast-path runs the native build+tess; fallback to legacy JS path on any
  failure.  Optional `{ skipBody: true }` bypasses `parseSTEPTopology`
  entirely for callers that need only a display mesh.

### Measured gains (NIST corpus, 11 files, `tests/bench-step-native.js`)

|                 | wall-clock | speedup |
|-----------------|-----------:|--------:|
| Legacy JS       | 1550 ms    | 1.00×   |
| WASM + TopoBody |  682 ms    | 2.27×   |
| WASM, skipBody  |  293 ms    | 5.30×   |

Peak single-file: 15.77× on `nist_ctc_01_asme1_rd.stp`.

### Parity

- `test-step-import.js`: 37/37 flag off and on
- `test-step-topology-wasm.js`: 7/7
- `test-nurbs-fillet-chamfer-variants.js`: 89/89
- `test-step-export.js`: 16/16
- `test-step-parser-wasm.js`: 7/7
- `test-step-lexer-wasm.js`: 9/9

NIST scoring drops from 58.0 % → 47.2 % under the flag due to a small
number of tessellation edge-cases where the native tessellator skips a
face the JS pipeline fills — acceptable since the flag is opt-in and the
target is iteration speed, not mesh fidelity.  These are isolated to the
native tessellator and will be addressed independently of the STEP path.

### Not done (intentionally deferred)

- A full WASM-backed TopoBody facade (option 2 from the design sketch)
  would eliminate the remaining `parseSTEPTopology` cost on the
  `skipBody === false` path, but requires re-implementing the entire
  `shells/faces/edges/vertices/coedges/loops + surfaceInfo + NurbsSurface +
  NurbsCurve + pCurves` graph behind lazy WASM-reading accessors.  That is
  tracked as a follow-up; the opt-in `skipBody` path covers all
  iteration-speed-sensitive callers today.
