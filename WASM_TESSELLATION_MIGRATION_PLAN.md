# WASM Tessellation Migration Plan

Status: active — revised 2026-04-26
Owner: modeller / CAD kernel

## 1. Direction

The old migration target was to marshal a JS `TopoBody` blob into WASM, run a
native tessellator, and decode a mesh blob back in JS. That is no longer the
right architecture.

The runtime target is handle-resident tessellation:

```
Feature result / import / operation
        |
        v
WASM handle owns topology + geometry ranges
        |
        v
kernel/tessellation reads native pools in place
        |
        +-- CPU fallback: typed mesh buffers in WASM memory
        +-- GPU path: kernel-prepared std430 buffers -> WebGPU compute/render
```

JavaScript should pass opaque handle ids and small tessellation parameters.
It should not serialize live `TopoBody` graphs across the JS/WASM boundary for
routine in-session rendering, LoD refresh, mass-property fallback, or operation
preview. CBREP remains the deterministic persistence and cache-hydration format,
not the steady-state transport for every mesh rebuild.

## 2. Current State

Already landed:

- `assembly/kernel/core.ts` tracks handle allocation, residency, revisions, and
  per-handle vertex/edge/coedge/loop/face/shell/geometry ranges.
- `assembly/kernel/topology.ts` can append topology for a handle through
  `bodyBeginForHandle()` / `bodyEndForHandle()`.
- `assembly/kernel/interop.ts` supports `cbrepHydrateForHandle()` so CBREP can
  hydrate into a handle without clearing other resident bodies.
- `assembly/kernel/tessellation.ts` tessellates planes, cylinders, cones,
  spheres, tori, and NURBS surfaces from native topology/geometry pools.
- `tessBuildAllFaces(segsU, segsV)` remains for legacy global-body callers.
- `tessBuildHandleFaces(handleId, segsU, segsV)` tessellates only the resident
  handle's recorded face range.
- `js/cad/WasmBrepHandleRegistry.js` exposes `tessellateBody()`,
  `tessellateFace()`, and `tessellateHandle()`.
- `assembly/kernel/gpu.ts` exposes std430-shaped header/control/knot buffers;
  `js/render/nurbs-tess.wgsl.js` and `js/render/gpu-tess-pipeline.js` provide
  the first WebGPU compute scaffold.

Still not finished:

- `FeatureTree.tryFastRestoreFromCheckpoints()` still restores solids by
  decoding CBREP into a JS `TopoBody` and tessellating that body in JS.
- Production startup does not consistently instantiate and wire
  `WasmBrepHandleRegistry` plus `HandleResidencyManager`.
- Some render and LoD paths still operate on JS mesh/body results even when a
  resident handle exists.
- The GPU compute pipeline is scaffolded but not the production render path;
  CPU readback/debug plumbing still exists and must not become the normal path.
- Parametric feature execution still mostly produces JS topology, then hydrates
  or serializes afterward. The target is native handle-in, handle-out operation
  execution for supported features.

## 3. Runtime Rules

1. JS owns feature ordering, UI state, persistence metadata, and fallback
   routing.
2. WASM owns runtime exact topology, geometry pools, tessellation buffers, and
   native operation outputs for supported paths.
3. CBREP crosses the boundary only for persistence, cache restore, worker
   handoff, or explicit debug/export compatibility.
4. A resident body is addressed by handle id. Operations should read ranges from
   `kernel/core`, not infer ownership from global counters.
5. `hydrate(cbrep)` is compatibility glue for single-body callers.
   Runtime code should prefer `hydrateForHandle(handle, cbrep)`.
6. GPU acceleration consumes kernel-prepared data. The GPU path may accelerate
   NURBS basis evaluation, normals, and LoD mesh generation, but the exact body
   remains owned by the WASM kernel.
7. JS `TopoBody` materialization is allowed for tests, debug tools, legacy
   fallbacks, and file-format compatibility. It is not the desired production
   render/update path.

## 4. Phases

### Phase A — Resident Handle Tessellation API

Status: complete.

- Add `tessBuildHandleFaces(handleId, segsU, segsV)` in
  `assembly/kernel/tessellation.ts`.
- Validate handle allocation and `RESIDENCY_RESIDENT` before reading topology.
- Use `handleGetFaceStart()` / `handleGetFaceEnd()` to avoid global-body
  assumptions.
- Keep `tessBuildAllFaces()` routed through the same internal face-range helper
  so legacy behavior remains stable.
- Export through `assembly/kernel/index.ts`, `assembly/index.ts`, and the
  generated release WASM glue.
- Add `WasmBrepHandleRegistry.tessellateHandle()`.
- Test two co-resident handles to prove scoped tessellation does not mesh the
  combined global topology.

Validation:

- `node tests/test-wasm-tess-ops.js` — 32/32 passing.

### Phase B — Fast Restore Uses Resident Tessellation

Status: next.

`FeatureTree.tryFastRestoreFromCheckpoints()` should stop doing:

```
readCbrep(buffer) -> JS TopoBody -> deps.tessellateBody(topoBody)
```

Preferred flow:

```
allocate handle
hydrateForHandle(handle, cbrep)
set RESIDENT
tessellateHandle(handle, segsU, segsV)
attach mesh snapshot + handle metadata to result
```

The feature result may still keep CBREP bytes for persistence and future lazy
rehydration, but the runtime mesh should come from the resident handle.

Tests needed:

- Fast-restore checkpoint builds a mesh without calling `deps.readCbrep()` for
  supported solid results.
- A failed handle hydration falls back to the existing JS path.
- Restored results preserve `wasmHandleId`, residency, `irHash`, volume, bounds,
  and feature-edge metadata.

### Phase C — Production Registry And Residency Wiring

Status: pending.

- Instantiate `WasmBrepHandleRegistry` in the production app/part bootstrap path.
- Instantiate `HandleResidencyManager` and attach it to each `FeatureTree`.
- On `.cmod` load and undo/redo, restore metadata and CBREP first, then hydrate
  handles lazily when render, operation, export, or selection needs exact data.
- Ensure stale/replaced feature results release handles and residency entries.
- Add diagnostics that show resident count, hydration count, eviction count, and
  handle-scoped tessellation count.

### Phase D — Render And LoD Consume Handles

Status: pending.

- Route render refresh for resident solids through `tessellateHandle()`.
- Keep CPU typed-array output as the fallback for browsers without WebGPU.
- Preserve faceMap/topology id data so selection and highlighting remain stable.
- Avoid repeated JS mesh rebuilds when only tessellation density changes.
- Make LoD changes update segment parameters and re-run handle tessellation, not
  feature replay.

### Phase E — Parametric Handle-In, Handle-Out Operations

Status: pending.

The end goal is not just faster tessellation. Parametric and exact operations
must produce native result handles directly:

- sketches and constraints may remain UI-authored in JS while the solver/core
  math lives in WASM where practical;
- feature parameters cross the boundary as compact numeric structs;
- supported operations allocate a new output handle and append topology/geometry
  directly into kernel pools;
- unsupported operations explicitly fall back to the JS exact path and then
  hydrate the result handle from CBREP.

Initial candidates:

- transform/copy/move/rotate on resident handles;
- primitive/extrude/revolve generation into a new handle;
- boolean result allocation once trimmed classification is safe;
- chamfer/fillet slices only after the topology cases are proven by tests.

### Phase F — GPU Compute As Acceleration Layer

Status: pending/in progress.

- Build GPU batches from kernel-owned NURBS surfaces and tessellation settings.
- Initialize `GpuTessPipeline` from the production registry.
- Upload std430 buffers from WASM memory to WebGPU storage buffers without JS
  per-element packing.
- Dispatch compute for NURBS surface samples and normals.
- Feed compute output directly into render vertex buffers.
- Keep CPU readback only for diagnostics/tests, not normal rendering.
- Preserve the CPU WASM tessellator as the deterministic fallback and comparison
  baseline.

## 5. Success Metrics

1. Resident fast restore can rebuild display mesh without JS `TopoBody`
   materialization for supported CBREP results.
2. Multiple resident bodies can be hydrated and tessellated independently in one
   WASM instance.
3. Render LoD changes re-run handle tessellation without feature replay.
4. WebGPU NURBS tessellation can render without CPU readback when available.
5. JS tessellation remains only as legacy/test fallback, not the default route.
6. Existing topology and STEP regression suites remain green after each phase.

## 6. Open Risks

- The resident native pools are append-only today. Long sessions need compaction
  or reclamation once many handles are released.
- Some containment/classification paths still need trimmed-face boundary checks
  before broad native boolean execution is safe.
- GPU compute must not weaken exact-kernel ownership. It accelerates evaluation
  and rendering, while topology and persistent exact geometry stay in WASM CPU
  memory.
- Selection, highlighting, and diagnostics depend on stable face ids. Any
  handle-scoped render path must preserve faceMap semantics.
- Fallback paths must be explicit and observable so unsupported regimes do not
  silently reintroduce repeated serialization.
