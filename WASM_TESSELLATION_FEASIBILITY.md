# WebAssembly Migration & Global Tessellation Config — Feasibility Plan

## Problem Statement

Importing a medium-sized STEP file causes the UI to freeze for ~10 seconds. The entire
STEP→Topology parsing and Topology→Mesh tessellation pipeline runs synchronously on the
main thread in pure JavaScript, blocking all user interaction until complete.

Additionally, the tessellation segment count (curve/radius/arc resolution) is currently
configured per-feature (prompted during STEP import, set per-fillet, etc.) rather than
being a single global setting for the CAD scene. This creates an inconsistent UX and
makes it impossible to uniformly re-tessellate the scene at a different quality level.

This document evaluates two strategies:
1. **Migrating the compute-heavy pipeline into WebAssembly** for raw performance gains.
2. **Introducing a global tessellation segment config** that all features inherit.

---

## 1. Current Architecture Summary

### 1.1 STEP Import Pipeline (Pure JavaScript, Main Thread)

```
User drops .step file
  │
  ▼
main.js: showPrompt("Curve tessellation segments:", default=16)   ← per-import prompt
  │
  ▼
StepImportFeature.execute()
  │
  ├─► _parseEntities(stepString)        ~2,275 lines of JS string parsing
  ├─► _resolveEntities(entities)         Entity ID → object graph resolution
  ├─► _findShells(resolved)              Locate MANIFOLD_SOLID_BREP / CLOSED_SHELL
  ├─► _buildFaceTopology()               Build TopoBody with NurbsSurface per face
  │     └─► _buildNurbsSurface()         NURBS B-spline / cylinder / sphere / cone / torus
  │     └─► _buildNurbsCurve()           LINE / CIRCLE / ELLIPSE / B_SPLINE_CURVE
  │
  ▼
  Exact B-Rep Topology (TopoBody)        ← Architecture Rule 1: source of truth
  │
  ▼
tessellateBody(body, opts)               Tessellation.js — display mesh only
  ├─► tessellateFace(face, segments)     NURBS surface → triangles
  ├─► edge.tessellate(edgeSegments)      NURBS curve → polyline
  └─► ear-clipping for planar faces
  │
  ▼
Triangle Mesh (vertices[], faces[])      ← Architecture Rule 2: post-processing only
```

**Key files and sizes:**

| File | Lines | Role |
|------|-------|------|
| `js/cad/StepImport.js` | 2,275 | STEP parsing + topology building + face tessellation |
| `js/cad/NurbsSurface.js` | 869 | NURBS surface evaluation, closest-point, tessellate |
| `js/cad/NurbsCurve.js` | 399 | NURBS curve evaluation, tessellate |
| `js/cad/Tessellation.js` | 278 | Body-level tessellation orchestrator |
| `js/cad/CSG.js` | 4,527 | Boolean ops, fillet/chamfer (mesh-level) |
| `js/cad/BRepTopology.js` | 774 | Topology graph classes |

### 1.2 Where Time Is Spent (Estimated Breakdown for a Medium STEP File)

| Phase | Estimated % of 10s | Nature |
|-------|---------------------|--------|
| `_parseEntities` (regex/string parsing) | ~15% | String-heavy, allocation-heavy |
| `_resolveEntities` (reference linking) | ~5% | Object graph traversal |
| `_buildFaceTopology` + NURBS construction | ~25% | Numerical (knot vectors, control points) |
| `_tessellateFace` (surface tessellation) | ~40% | Heavy FP math (B-spline eval, subdivision) |
| `_tessellateLoop` (curve tessellation) | ~10% | FP math (Cox-de Boor, circle sampling) |
| Edge/face post-processing | ~5% | Array manipulation |

The tessellation phase dominates because it involves repeated B-spline basis function
evaluation, adaptive subdivision, and triangle generation — all floating-point intensive.

### 1.3 Existing WebAssembly Usage

The project already uses AssemblyScript-compiled WebAssembly (`assembly/` → `build/release.wasm`):

- **2D rendering** (`render2d.ts`, 567 lines)
- **Constraint solver** (`solver.ts`, 412 lines)
- **Geometry helpers** (`geometry.ts`, 250 lines)
- **Camera, scene, entities, math** utilities

Build system: `asconfig.json` → `asc assembly/index.ts --target release` (optimization level 3).
Output: ESM bindings, ~56 KB WASM binary.

**No Web Workers are used anywhere in the codebase.** All compute is on the main thread.

### 1.4 Current Segment Configuration (Per-Feature, Not Global)

| Feature | Default | Range | Where Configured |
|---------|---------|-------|-----------------|
| STEP import curves | 16 | 3+ | `showPrompt()` on every import |
| STEP surface tessellation | 8 | any | Hardcoded in `Tessellation.js` opts |
| STEP edge wireframe | 16 | any | Hardcoded in `Tessellation.js` opts |
| Fillet arcs | 8 | 2–32 | Per-feature UI parameter |
| Revolve segments | varies | any | Per-feature UI parameter |
| Chamfer | 1 | fixed | Hardcoded (flat cuts) |

---

## 2. WebAssembly Migration — STEP Parsing

### 2.1 What Would Be Migrated

**Phase 1 (STEP Text → Entity Graph):**
`_parseEntities()` and `_resolveEntities()` — string parsing, regex matching, entity
resolution. ~400 lines of JS.

**Phase 2 (Entity Graph → B-Rep Topology):**
`_buildFaceTopology()`, `_buildNurbsSurface()`, `_buildNurbsCurve()`, `_findShells()` —
constructing NurbsSurface/NurbsCurve objects from parsed STEP entities. ~800 lines of JS.

### 2.2 Pros

| Advantage | Detail |
|-----------|--------|
| **2–5× parsing speedup** | WASM's typed memory and compiled execution significantly outperform JS string parsing, especially for large files (>1 MB). Regex-heavy code benefits from linear-memory string scanning. |
| **Predictable performance** | No GC pauses during parsing. Large STEP files (50k+ entities) cause JS GC pressure from millions of small object allocations. WASM with linear memory avoids this. |
| **Existing infrastructure** | The project already has an AssemblyScript build pipeline (`asconfig.json`, `build/`). The tooling, ESM bindings, and deployment pattern are established. |
| **Offload to Web Worker** | WASM modules are trivially transferable to a Web Worker (`postMessage` with `SharedArrayBuffer` or transferable buffers). This would unblock the UI thread entirely — the real fix for the 10-second freeze. |
| **Future ecosystem leverage** | OpenCascade (OCCT) already has a mature WASM port (`opencascade.js`). If the project ever adopts it, WASM infrastructure would already be in place. |

### 2.3 Cons

| Disadvantage | Detail |
|--------------|--------|
| **String handling complexity** | STEP parsing is string-heavy (regex, substring, split). AssemblyScript's string support is limited and slower than JS for complex regex patterns. A C++/Rust port would be more suitable but adds a second toolchain. |
| **Large migration surface** | StepImport.js is 2,275 lines of intricate parsing logic with edge cases (malformed entities, optional fields, various STEP AP schemas). Porting this is error-prone and hard to test incrementally. |
| **Data marshalling overhead** | The parsed result is a complex object graph (TopoBody → TopoShell → TopoFace → NurbsSurface, etc.). Serializing this across the WASM/JS boundary (or Worker boundary) adds latency and complexity. For small-to-medium files, marshalling cost may negate the WASM speedup. |
| **Debugging difficulty** | WASM debugging is significantly harder than JS. STEP parsing has many edge cases (AP203, AP214, AP242 variations) that require interactive debugging. Source maps help but are not equivalent to JS DevTools. |
| **Maintenance burden** | Two codebases for the same logic (JS tests exist, WASM would need parallel tests). Any STEP parsing fix must be applied in both places during transition. |
| **Diminishing returns** | Parsing is only ~20% of the total import time. Even a 5× parsing speedup only reduces total time from 10s to ~8s. The bottleneck is tessellation, not parsing. |

### 2.4 Verdict: STEP Parsing

**Recommendation: Do NOT migrate STEP parsing to WASM as a first step.**

The cost/benefit ratio is unfavorable. Parsing is not the bottleneck, string handling in
WASM is painful, and the data marshalling overhead for the complex topology graph is
significant. Instead, **move STEP parsing to a Web Worker** (keeping it in JS) to unblock
the UI immediately. This provides 90% of the UX benefit at 10% of the migration cost.

---

## 3. WebAssembly Migration — Mesh Tessellation

### 3.1 What Would Be Migrated

The tessellation pipeline converts exact B-Rep topology (NurbsSurface, NurbsCurve) into
triangle meshes for rendering:

- `NurbsSurface.tessellate(uSegs, vSegs)` — B-spline surface → triangle grid
- `NurbsSurface.evaluate(u, v)` — Point + normal evaluation via basis functions
- `NurbsCurve.tessellate(segments)` — B-spline curve → polyline
- `_tessellateMultiArcPatch()` — Adaptive subdivision for spheres/cylinders
- `_subdivideBSplineTriangles()` — Adaptive triangle refinement
- Cox-de Boor B-spline basis evaluation (innermost hot loop)

### 3.2 Pros

| Advantage | Detail |
|-----------|--------|
| **5–10× tessellation speedup** | NURBS evaluation is pure floating-point arithmetic (knot spans, basis functions, weighted sums). This is WASM's strongest domain — typed f64 arrays, no boxing, SIMD potential. The innermost loop (Cox-de Boor recursion) runs millions of times per face. |
| **Targets the actual bottleneck** | Tessellation is ~50% of total import time and 100% of re-tessellation time. A 5× speedup here reduces import from 10s to ~5s, and re-tessellation (on segment count change) from 5s to ~1s. |
| **Simple data interface** | Input: flat arrays of control points (f64[]), knot vectors (f64[]), weights (f64[]). Output: flat arrays of vertices (f64[]) and face indices (u32[]). No complex object graphs to marshal — just typed arrays that transfer at zero cost between JS and WASM. |
| **SIMD opportunity** | B-spline evaluation involves repeated multiply-accumulate on 3D/4D vectors. WASM SIMD (128-bit) can process 2 f64 or 4 f32 values per instruction, potentially doubling throughput on supported browsers. |
| **AssemblyScript compatibility** | The NURBS evaluation math is straightforward numerical code (no string handling, no complex data structures). It maps naturally to AssemblyScript's typed-array paradigm and benefits most from its strict typing. |
| **Incremental migration path** | Individual surface types (plane, cylinder, sphere, B-spline) can be migrated one at a time. Each can be tested independently against the JS reference implementation. |
| **Re-tessellation enables global config** | Fast tessellation makes a "global segment count" practical — changing the count re-tessellates the entire scene in <1s instead of 5–10s. This directly enables the UX improvement described in the problem statement. |
| **Worker-friendly** | Like WASM parsing, tessellation can run in a Web Worker. Combined with WASM speed, this could make re-tessellation feel instant and fully non-blocking. |

### 3.3 Cons

| Disadvantage | Detail |
|--------------|--------|
| **Moderate migration effort** | ~1,500 lines of numerical code across NurbsSurface.js, NurbsCurve.js, StepImport.js tessellation functions, and Tessellation.js. Estimated 2–3 weeks for a complete port with tests. |
| **Adaptive subdivision complexity** | `_tessellateMultiArcPatch()` and `_subdivideBSplineTriangles()` use recursive adaptive refinement with dynamic array growth. This is harder to express efficiently in WASM's linear memory model than uniform grid tessellation. |
| **Numerical precision** | WASM f64 matches JS Number precision, but differences in evaluation order can cause last-bit differences. Need comprehensive regression tests comparing JS and WASM outputs to catch subtle precision bugs. |
| **Browser SIMD support** | WASM SIMD is supported in Chrome 91+, Firefox 89+, Safari 16.4+. Older browsers need a fallback path (standard WASM without SIMD). AssemblyScript SIMD support is experimental. |
| **Build complexity** | Adding NURBS tessellation to the existing WASM module increases binary size. May need a separate WASM module for tessellation vs. the existing 2D renderer to avoid loading unused code. |
| **Topology object mapping** | While the numerical arrays transfer cheaply, the TopoFace/TopoLoop structure that drives which surfaces and curves to tessellate still lives in JS. Need a thin JS orchestration layer that walks the topology and dispatches WASM calls per face/edge. |

### 3.4 Verdict: Mesh Tessellation

**Recommendation: YES — Migrate tessellation to WASM. This is the highest-impact change.**

The tessellation pipeline is the primary performance bottleneck and consists almost entirely
of numerical floating-point code that maps perfectly to WASM's strengths. The data interface
is clean (typed arrays in, typed arrays out), the existing AssemblyScript toolchain is ready,
and the migration can be done incrementally per surface type.

Combined with a Web Worker, this could reduce the perceived import time from 10s to near-zero
(non-blocking) and enable real-time global segment count changes.

---

## 4. Web Worker Strategy (Complementary to WASM)

Regardless of WASM migration, **moving the import pipeline to a Web Worker** is the single
most impactful change for UX and should be done first:

### 4.1 Proposed Architecture

```
┌─ Main Thread ──────────────────────────────────┐
│                                                 │
│  User drops STEP file                          │
│  ↓                                             │
│  Show progress spinner ("Importing...")         │
│  ↓                                             │
│  worker.postMessage({ stepData, segments })     │
│  ↓                                             │
│  ... UI remains responsive ...                 │
│  ↓                                             │
│  worker.onmessage = ({ vertices, faces, ... }) │
│  ↓                                             │
│  Update 3D view with received mesh             │
│                                                 │
└─────────────────────────────────────────────────┘

┌─ Web Worker ───────────────────────────────────┐
│                                                 │
│  onmessage = ({ stepData, segments }) =>       │
│    const body = parseSTEPTopology(stepData)    │  JS (keep as-is)
│    const mesh = tessellateBody(body, {         │  JS → WASM (migrate later)
│      surfaceSegments: segments,                │
│      edgeSegments: segments * 2,               │
│    })                                          │
│    postMessage(mesh, [mesh.vertices.buffer])   │  Transfer (zero-copy)
│                                                 │
└─────────────────────────────────────────────────┘
```

### 4.2 Implementation Effort

| Task | Effort | Impact |
|------|--------|--------|
| Create `step-import-worker.js` | 1 day | Wraps existing `importSTEP()` |
| Modify `StepImportFeature.execute()` to use Worker | 1 day | Async execution |
| Add progress/cancel UI | 1 day | Loading spinner, abort controller |
| **Total** | **~3 days** | **UI freeze → 0 seconds** |

This can be done **entirely in JavaScript** with no WASM changes, as a precursor to the
WASM tessellation migration.

---

## 5. Global Tessellation Segment Config

### 5.1 Current Problem

Segment counts are configured per-feature in at least 4 separate places:

1. **STEP import** — `showPrompt("Curve tessellation segments:", 16)` on every import
2. **Fillet** — `segments` property per FilletFeature (default 8, range 2–32)
3. **Revolve** — `segments` property per RevolveFeature
4. **Tessellation.js** — `surfaceSegments` (8) and `edgeSegments` (16) hardcoded defaults

This means:
- Users are asked about segments during STEP import (an implementation detail they shouldn't
  need to think about)
- Different features in the same scene can have different tessellation quality
- Changing resolution requires editing each feature individually
- There's no way to "re-mesh the whole scene at higher quality for export"

### 5.2 Proposed Solution

Introduce a **scene-level tessellation config** that all features inherit:

```javascript
// Scene or Part level
class TessellationConfig {
    constructor() {
        this.curveSegments = 16;      // Arcs, circles, ellipses, B-spline curves
        this.surfaceSegments = 8;     // NURBS surface U/V subdivisions
        this.edgeSegments = 16;       // Edge wireframe resolution
        this.adaptiveSubdivision = true;  // Enable/disable adaptive refinement
    }
}
```

**Key principles:**
- The config lives on the `Scene` or `Part` object (serialized with the project)
- All features read from this config during `execute()` — no per-feature segment storage
- Features that need more resolution (e.g., tiny fillets) can use a multiplier, but the
  base comes from the global config
- Changing the global config triggers a full scene re-tessellation (topology is preserved,
  only the display mesh is regenerated)
- The STEP import prompt for segments is **removed** — it uses the global config
- The fillet `segments` parameter is **removed** from the per-feature UI — it uses the
  global config

### 5.3 UI Changes

```
┌─────────────────────────────────┐
│  CAD Modeller Toolbar           │
│  ┌───────────────────────────┐  │
│  │ Tessellation Quality      │  │
│  │ ┌─────────┐               │  │
│  │ │ ◀ 16 ▶  │ Segments     │  │  ← Single global control
│  │ └─────────┘               │  │
│  │ ○ Draft (8)               │  │  ← Preset options
│  │ ● Normal (16)             │  │
│  │ ○ Fine (32)               │  │
│  │ ○ Ultra (64)              │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

**On change:**
1. Update `scene.tessellationConfig.curveSegments`
2. For each feature in the feature tree: `feature.execute()` (topology is cached, only
   re-tessellates)
3. Update 3D view

With WASM tessellation + Web Worker, this re-tessellation could complete in <1 second
for typical scenes.

### 5.4 Migration Path (Per-Feature → Global)

| Step | Change | Backward Compatibility |
|------|--------|----------------------|
| 1 | Add `tessellationConfig` to Scene/Part | Features still use own defaults if config absent |
| 2 | Thread config through `execute()` context | Features prefer config, fall back to own property |
| 3 | Remove STEP import segment prompt | Use `tessellationConfig.curveSegments` |
| 4 | Remove fillet `segments` from UI | Use `tessellationConfig.curveSegments` |
| 5 | Add global quality control to toolbar | Slider/preset buttons |
| 6 | On config change, re-execute all features | Only tessellation reruns (topology cached) |
| 7 | Remove per-feature `segments` from serialization | Migration: old files use defaults |

### 5.5 Compatibility with WASM Tessellation

The global config integrates naturally with the WASM tessellation approach:

```javascript
// In Web Worker with WASM tessellation:
onmessage = ({ type, data }) => {
    if (type === 'retessellate') {
        const { topoBodySerialized, config } = data;
        const mesh = wasmTessellate(topoBodySerialized, {
            curveSegments: config.curveSegments,
            surfaceSegments: config.surfaceSegments,
        });
        postMessage({ type: 'mesh', mesh }, [mesh.vertices.buffer]);
    }
};
```

Because the B-Rep topology is preserved (Architecture Rule 1), re-tessellation from the
exact geometry at any segment count is always possible without re-parsing the STEP file
or re-executing boolean operations.

---

## 6. Recommended Implementation Roadmap

### Phase 1: Web Worker + Global Config (2–3 weeks)
**Goal: Eliminate UI freeze, unify segment configuration**

- [ ] **1.1** Add `tessellationConfig` to Scene/Part with defaults `{ curveSegments: 16, surfaceSegments: 8 }`
- [ ] **1.2** Create `step-import-worker.js` wrapping existing JS `importSTEP()`
- [ ] **1.3** Modify `StepImportFeature` to dispatch to Worker, show progress UI
- [ ] **1.4** Remove per-import segment prompt — read from `tessellationConfig`
- [ ] **1.5** Thread `tessellationConfig` into `FilletFeature.execute()` and `RevolveFeature.execute()`
- [ ] **1.6** Remove per-feature segments from fillet UI — use global config
- [ ] **1.7** Add tessellation quality control to toolbar (Draft/Normal/Fine/Ultra presets)
- [ ] **1.8** On config change, re-tessellate all features (topology cached, mesh regenerated)

**Result:** UI never freezes. Single segment control for entire scene. No WASM changes yet.

### Phase 2: WASM Tessellation Core (3–4 weeks)
**Goal: 5–10× tessellation speedup**

- [ ] **2.1** Implement Cox-de Boor B-spline basis evaluation in AssemblyScript
- [ ] **2.2** Implement `NurbsSurface.evaluate(u, v)` → point + normal in WASM
- [ ] **2.3** Implement uniform grid tessellation (surface → triangle mesh) in WASM
- [ ] **2.4** Implement `NurbsCurve.evaluate(t)` and curve tessellation in WASM
- [ ] **2.5** Add JS↔WASM bridge: accept control points/knots as `Float64Array`, return mesh as `Float64Array` + `Uint32Array`
- [ ] **2.6** Benchmark against JS reference implementation, validate numerical accuracy
- [ ] **2.7** Integrate WASM tessellation into Web Worker pipeline
- [ ] **2.8** Add regression tests comparing WASM output to JS output for all test STEP files

**Result:** Tessellation 5–10× faster. Combined with Worker, import feels near-instant.

### Phase 3: Advanced Optimization (Optional, 2–3 weeks)
**Goal: Push performance further for large/complex models**

- [ ] **3.1** Add WASM SIMD for B-spline evaluation (2× speedup on supported browsers)
- [ ] **3.2** Implement adaptive subdivision in WASM (currently `_tessellateMultiArcPatch`)
- [ ] **3.3** Add progressive tessellation (coarse mesh first, refine in background)
- [ ] **3.4** Implement topology serialization for Worker transfer (avoid re-parsing)
- [ ] **3.5** Consider `SharedArrayBuffer` for zero-copy mesh transfer between Worker and main thread

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WASM tessellation produces different geometry than JS | Medium | High | Comprehensive comparison tests with tolerance thresholds |
| AssemblyScript can't express adaptive subdivision efficiently | Medium | Medium | Fall back to JS for adaptive cases, WASM for uniform grid |
| Web Worker serialization of TopoBody is too complex | Low | Medium | Keep topology in main thread, only send tessellation inputs to Worker |
| Global segment config breaks existing saved projects | Low | Low | Migration path: absent config → use feature defaults |
| Browser WASM SIMD support gaps | Low | Low | SIMD is optional optimization; base WASM works everywhere |

---

## 8. Summary

| Strategy | Effort | UI Freeze Fix | Perf Gain | Recommended? |
|----------|--------|--------------|-----------|--------------|
| **Web Worker (JS only)** | 3 days | ✅ Complete | 1× (same speed, non-blocking) | ✅ **Yes — do first** |
| **Global segment config** | 1 week | Partial (faster re-tess) | 1× | ✅ **Yes — do with Worker** |
| **WASM tessellation** | 3–4 weeks | ✅ (with Worker) | 5–10× | ✅ **Yes — do second** |
| **WASM STEP parsing** | 4–6 weeks | ✅ (with Worker) | 2–5× (parsing only) | ❌ **No — low ROI** |
| **WASM SIMD** | 1–2 weeks | N/A | 2× on top of WASM | ⚠️ **Optional Phase 3** |

**The recommended approach is:**
1. **Immediate (Phase 1):** Web Worker + Global Segment Config → eliminates UI freeze entirely
2. **Short-term (Phase 2):** WASM tessellation → makes re-tessellation fast enough for real-time quality adjustment
3. **Long-term (Phase 3):** SIMD + progressive tessellation → premium performance for large models

The STEP parsing should stay in JavaScript. The tessellation should move to WASM.
The segment count should be global to the scene, not per-feature.
