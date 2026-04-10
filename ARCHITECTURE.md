# Architecture Documentation

## Overview

A parametric 3D CAD modeller built entirely in JavaScript (ES modules) with an
AssemblyScript → WebAssembly acceleration layer. Runs both as a browser
application and as a headless Node.js library for CAD kernel operations,
mesh tessellation, STEP import/export, and offline rendering without a UI. The
system follows a **topology-first** design: every solid is represented by an
exact NURBS/B-Rep topology graph, and triangle meshes exist only for rendering.

---

## Mandatory Design Rules

### Rule 1 — B-Rep Topology Is the Source of Truth

Every solid body in the feature tree is represented by its exact NURBS/B-Rep
topology (`TopoBody` from `BRepTopology.js`):

```
TopoBody → TopoShell → TopoFace → TopoLoop → TopoCoEdge → TopoEdge → TopoVertex
```

| Element    | Exact Data                                                       |
|------------|------------------------------------------------------------------|
| TopoFace   | `NurbsSurface`, `surfaceType`, `surfaceInfo`, UV bounds          |
| TopoEdge   | `NurbsCurve` (exact 3D edge curve), tolerance                    |
| TopoVertex | Exact 3D point `{x, y, z}`, tolerance                           |

All feature operations (extrude, revolve, chamfer, fillet, boolean) operate on
this topology — never on tessellated mesh faces/vertices.

### Rule 2 — Tessellation Is Post-Processing Only

Mesh tessellation (`vertices[]`, `faces[]`) exists only for rendering. It is
generated after topology is fully computed and must never be fed back into
feature operations.

```
STEP file  ──parse──►  TopoBody (exact)  ──tessellate──►  mesh (display only)
Sketch     ──extrude──► TopoBody (exact)  ──tessellate──►  mesh (display only)
```

### Rule 3 — Features Propagate TopoBody

Every feature's `execute()` must produce and propagate a `TopoBody`:

```js
return {
  type: 'solid',
  geometry,                            // mesh — display only
  solid: { geometry, body: newBody },  // body is mandatory
  body: newBody,
};
```

### Known Gaps

- **BSPLINE+BSPLINE fillet/chamfer**: Chamfering/filleting edges between two
  BSPLINE faces (e.g., lens-shaped profiles) can produce topology gaps or
  excessive volume removal. Tracked by the `test-nurbs-fillet-chamfer-variants`
  test suite (8 known edge cases).
- **Bezier bottom-edge chamfer**: Chamfering the bottom straight edge of a
  mixed bezier profile produces boundary edges in some orientations.
- **Sequential BSPLINE operations**: Chaining chamfer/fillet on BSPLINE faces
  after a first operation can leave boundary edges in the mesh output.
- **Tessellation winding**: BSPLINE face tessellation may produce inconsistent
  triangle winding. The topology (TopoBody) is correct; only the mesh output
  is affected.

---

## Project Structure

```
assembly/           AssemblyScript WASM source (compiled to build/)
build/              Compiled WASM binaries (debug + release)
css/                Stylesheets
js/
  main.js           Application entry point & App class
  state.js          Global singleton app state
  viewport.js       2D canvas transform (pan/zoom)
  wasm-renderer.js  WASM-backed 3D renderer
  webgl-executor.js WebGL2 command processor
  persist.js        LocalStorage persistence
  history.js        Undo/redo snapshots
  cmod.js           .cmod file format (project save/load)
  part-manager.js   3D part workflow manager
  snap.js           Snap-to-grid/objects
  logger.js         Console logging
  cad/              CAD kernel (59 modules)
  dxf/              DXF import/export
  render/           Rendering pipeline
  ui/               UI panels and dialogs
  tools/            2D sketch tools
  entities/         Entity definitions
  workers/          Web workers
tests/              Test suite (53 test files)
tools/              CLI render tools
```

---

## Design Hierarchy

```
Assembly (3D, multi-part)
  └─ Part (3D parametric solid)
      ├─ FeatureTree — Ordered parametric operations
      │   ├─ SketchFeature        2D sketch on a plane
      │   ├─ ExtrudeFeature       Extrude sketch → solid
      │   ├─ ExtrudeCutFeature    Extrude subtract
      │   ├─ MultiSketchExtrudeFeature   Multi-plane extrude + union
      │   ├─ RevolveFeature       Revolve sketch around axis
      │   ├─ ChamferFeature       Flat bevel on edges
      │   ├─ FilletFeature        Rounded blend on edges
      │   └─ StepImportFeature    Import external STEP file
      └─ TessellationConfig — Quality presets (draft/normal/fine/ultra)
```

---

## Parametric Feature System

### Feature (Base Class) — `js/cad/Feature.js`

```
Feature
  ├─ id: string (feature_N)
  ├─ name, type, suppressed, visible
  ├─ dependencies: string[]
  ├─ children: string[]
  ├─ execute(context) → result
  └─ canExecute(context) → bool
```

### FeatureTree — `js/cad/FeatureTree.js`

Manages ordered features with dependency-driven recalculation:

- `addFeature(feature, index?)` — Insert with dependency validation
- `removeFeature(featureId)` — Remove (blocks if others depend on it)
- `recalculateFrom(featureId)` — Recompute this + all dependents
- `executeAll()` — Full rebuild

### Feature Types

| Feature | File | Params |
|---------|------|--------|
| SketchFeature | `SketchFeature.js` | plane (origin + axes), profile extraction |
| ExtrudeFeature | `ExtrudeFeature.js` | distance, direction, symmetric, taper, operation (new/add/subtract/intersect) |
| ExtrudeCutFeature | `ExtrudeCutFeature.js` | extends ExtrudeFeature, defaults to subtract |
| MultiSketchExtrudeFeature | `MultiSketchExtrudeFeature.js` | array of {sketchId, distance, direction}, unions result |
| RevolveFeature | `RevolveFeature.js` | angle, segments, axis, operation |
| ChamferFeature | `ChamferFeature.js` | distance, edgeKeys[] |
| FilletFeature | `FilletFeature.js` | radius, segments, edgeKeys[] |
| StepImportFeature | `StepImportFeature.js` | STEP file data, parsed TopoBody |

### Part — `js/cad/Part.js`

Top-level container for parametric modeling:

- `addSketch(sketch, plane)` → SketchFeature
- `extrude(sketchId, distance, opts)` → ExtrudeFeature
- `revolve(sketchId, angle, opts)` → RevolveFeature
- `chamfer(edgeKeys, distance)` → ChamferFeature
- `fillet(edgeKeys, radius)` → FilletFeature
- `importSTEP(stepData)` → StepImportFeature
- `getFinalGeometry()` → executes tree, returns combined solid

State: featureTree, customPlanes, originPlanes (XY/XZ/YZ),
tessellationConfig, material properties, computed mass/volume/centerOfMass.

---

## Exact Geometry Kernel

### B-Rep Topology — `js/cad/BRepTopology.js`

Production-grade topology graph:

```
TopoBody
  └─ TopoShell (closed: bool)
       └─ TopoFace
            ├─ surface: NurbsSurface
            ├─ surfaceType: PLANE | CYLINDER | CONE | SPHERE | TORUS |
            │                EXTRUSION | REVOLUTION | BSPLINE
            ├─ outerLoop: TopoLoop
            │    └─ TopoCoEdge[] (oriented half-edges)
            │         └─ TopoEdge
            │              ├─ curve: NurbsCurve
            │              ├─ startVertex: TopoVertex {x,y,z}
            │              └─ endVertex: TopoVertex {x,y,z}
            └─ innerLoops: TopoLoop[]
```

### NURBS — `js/cad/NurbsCurve.js`, `js/cad/NurbsSurface.js`

**NurbsCurve**: degree, controlPoints, knots, weights. Methods: `evaluate(u)`,
`evaluateDerivative(u)`, `tessellate(segments)`, `arcLength()`,
`serialize()`/`deserialize()`. Cox-de Boor basis evaluation.

**NurbsSurface**: degreeU/V, control point grid (row-major), knotsU/V, weights.
Methods: `evaluate(u,v)`, `normal(u,v)`, `closestPointUV(point, gridRes, uvHint)`,
`tessellate(segsU, segsV)`, `serialize()`/`deserialize()`.

Both support WASM-accelerated tessellation with automatic JS fallback.

### Boolean Operations

**Dual pipeline** dispatched by `CSG.js`:

| Mode | Implementation | When Used |
|------|----------------|-----------|
| Exact B-Rep | `BooleanKernel.js` | Both operands have `TopoBody` |
| Mesh BSP | `CSG.js` | Fallback for mesh-only geometry |

Exact pipeline (`BooleanKernel.exactBooleanOp`):
1. Intersect candidate face pairs → exact curves
2. Split faces by intersection curves (`FaceSplitter.js`)
3. Classify fragments as inside/outside
4. Stitch into shells (`ShellBuilder.js`)
5. Validate closure & orientation (`BRepValidator.js`)

Supporting modules: `CurveCurveIntersect.js`, `CurveSurfaceIntersect.js`,
`SurfaceSurfaceIntersect.js`, `Intersections.js` (dispatch).

### Chamfer & Fillet — `js/cad/BRepChamfer.js`, `js/cad/BRepFillet.js`

Both operate directly on `TopoBody`, preserving the exact topology chain:

**Chamfer** (`applyBRepChamfer`):
1. Compute offset directions perpendicular to edge on each adjacent face
2. Create 4 trim points defining a quadrilateral bevel surface
3. Trim original faces at offset points
4. Insert planar bevel face with NURBS boundary curves
5. Build new `TopoBody` with closure validation

**Fillet** (`applyBRepFillet`):
1. Precompute rolling-ball offset on each adjacent face
2. Generate NURBS arc cross-sections via `NurbsCurve.createArc()`
3. Clip trim points to neighboring edges for non-90° corners
4. Merge shared vertex positions at multi-edge junctions
5. Handle 3-edge corners with sphere-center patches
6. Build exact `TopoBody` with fillet, trimmed, and corner faces

**Surface pairing support**:

| Pairing | Chamfer | Fillet | Notes |
|---------|---------|--------|-------|
| PLANE + PLANE (90°) | ✅ | ✅ | Full support |
| PLANE + PLANE (non-90°) | ✅ | ✅ | Angles 45°–135° tested |
| PLANE + BSPLINE | ✅ | ✅ | Via extruded-surface offset handler |
| PLANE + CYLINDER | ⚠ | ⚠ | Known failures on round edges |
| BSPLINE + BSPLINE | ⚠ | ⚠ | Known topology gaps (lens profiles) |

Shared helpers between chamfer and fillet: `_computeOffsetDirs`,
`_buildPlanarFaceDesc`, `_buildPlanarBoundarySegments`,
`_extractFeatureFacesFromTopoBody`.

### Tessellation — `js/cad/Tessellation.js`

Converts exact B-Rep to renderable triangle mesh:

- `tessellateBody(body, config)` — Full body → mesh
- `tessellateFace(face, config)` — Single face → triangles
- `tessellateForSTL(body)` — Export-quality mesh

Uses ear-clipping triangulation, adaptive subdivision for curved surfaces,
and WASM-accelerated NURBS evaluation when available.

**TessellationConfig** — `js/cad/TessellationConfig.js`:

| Preset | curveSegments | surfaceSegments |
|--------|---------------|-----------------|
| draft  | 8             | 4               |
| normal | 16            | 8               |
| fine   | 32            | 16              |
| ultra  | 64            | 32              |

---

## STEP Import/Export

### Import — `js/cad/StepImport.js`

Two-phase design: topology first, tessellation second.

```
parseSTEPTopology(stepString)         → TopoBody (exact, no mesh)
  1. _parseEntities()                 Parse DATA section
  2. _resolveEntities()               Resolve reference graph
  3. _findShells()                    Find MANIFOLD_SOLID_BREP / CLOSED_SHELL
  4. _buildFaceTopology()             Build TopoFace with NurbsSurface, NurbsCurve

importSTEP(stepString, opts)          → { body, vertices, faces }
  calls parseSTEPTopology() then tessellates for display
```

Supported STEP entities: MANIFOLD_SOLID_BREP, CLOSED_SHELL, OPEN_SHELL,
ADVANCED_FACE, FACE_BOUND, EDGE_LOOP, ORIENTED_EDGE, EDGE_CURVE, VERTEX_POINT,
LINE, CIRCLE, ELLIPSE, B_SPLINE_CURVE_WITH_KNOTS, SURFACE_CURVE,
PLANE, CYLINDRICAL_SURFACE, CONICAL_SURFACE, SPHERICAL_SURFACE,
TOROIDAL_SURFACE, B_SPLINE_SURFACE_WITH_KNOTS.

### Export — `js/cad/StepExport.js`

`exportSTEP(body, opts)` → ISO 10303-21 string (AP203/AP214/AP242).

Writes complete entity graph: MANIFOLD_SOLID_BREP, ADVANCED_FACE, EDGE_CURVE,
all surface types, B-spline curves/surfaces with rational variants.

---

## WASM Acceleration Layer

### Architecture

The WASM module is compiled from AssemblyScript (`assembly/`) to `build/release.js`.
It accelerates three areas:

| Area | JS Module | WASM Module | Functions |
|------|-----------|-------------|-----------|
| NURBS evaluation | NurbsCurve.js, NurbsSurface.js | assembly/nurbs.ts | tessellate, evaluate, normal |
| 2D rendering | wasm-renderer.js | assembly/render2d.ts | Entity rendering, command buffer |
| Constraint solving | Solver.js | assembly/solver.ts | Gauss-Seidel relaxation |

### WASM Bridge — `js/cad/WasmTessellation.js`

Singleton `wasmTessellation` object:

- `init()` — Load WASM module (async, call once at startup)
- `isAvailable()` — Check if loaded
- `tessellateCurve(curve, segments)` → point array
- `tessellateSurface(surface, segsU, segsV)` → triangle mesh
- `evaluateCurve(curve, u)` → single point
- `evaluateSurfaceNormal(surface, u, v)` → unit normal

Data marshalling: JS passes typed arrays (Float64Array) to WASM via
`__lowerTypedArray`; results are read from WASM memory buffer pointers.

**Init sequencing** (`main.js`): WASM init is awaited before `new App()` to
guarantee WASM is ready before any project restore triggers tessellation.

### Assembly/ Source Files

| File | Purpose |
|------|---------|
| index.ts | WASM entry point, exported API |
| math.ts | Vec3, Mat4, Color structs |
| camera.ts | Perspective/orthographic camera |
| commands.ts | Command buffer protocol |
| geometry.ts | Box, grid, axes generation |
| scene.ts | Scene graph with nodes |
| entities.ts | Entity storage with bitflags |
| nurbs.ts | NURBS curve/surface evaluation & tessellation |
| render2d.ts | 2D sketch rendering |
| solver.ts | Constraint solver (10 constraint types) |
| tessellation.ts | Ear-clipping triangulation, mesh metrics |

### Building

```bash
npm run asbuild          # Build debug + release WASM
npm run asbuild:release  # Build optimized WASM only
```

---

## Rendering Pipeline

### 3D Rendering

```
Part geometry (TopoBody + mesh)
  ↓
WasmRenderer.render()
  ├─ buildMeshRenderData()      (silhouette edges, normals)
  ├─ computeOrbitMvp()          (orbit camera → MVP matrix)
  └─ emit command buffer
     ↓
WebGLExecutor.execute(commands)
  ├─ Program 0: solid (vertex lighting + MVP + normal)
  ├─ Program 1: line/point (no lighting)
  └─ Program 2: diagnostic (backface overlay)
```

Command buffer protocol — flat `Float32Array` with encoded WebGL ops:

| Command | ID |
|---------|-----|
| END | 0 |
| CLEAR | 1 |
| SET_PROGRAM | 2 |
| SET_MATRIX | 3 |
| SET_COLOR | 4 |
| DRAW_TRIANGLES | 5 |
| DRAW_LINES | 6 |
| DRAW_POINTS | 7 |
| SET_LINE_DASH | 8 |
| SET_DEPTH_TEST | 9 |
| SET_LINE_WIDTH | 10 |
| SET_DEPTH_WRITE | 11 |

### 2D Rendering

2D sketch view uses the same WASM command buffer, rendered by `render2d.ts`.
`Viewport` (`viewport.js`) handles pan/zoom transforms. Canvas 2D fallback
available via `canvas-command-executor.js`.

---

## 2D Sketch System

### Scene — `js/cad/Scene.js`

Low-level 2D primitive manager: points (`PPoint`), segments (`PSegment`),
circles (`PCircle`), arcs (`PArc`), splines (`PSpline`), text (`TextPrimitive`),
dimensions (`DimensionPrimitive`). Manages constraint storage and solver integration.

### Sketch — `js/cad/Sketch.js`

High-level wrapper over `Scene` with:
- Plane definition (origin, x/y/z axes)
- `extractProfiles()` — trace closed loops for 3D operations
- `solve()` — run constraint solver
- Delegates to Scene for primitive management

### Constraint Solver — `js/cad/Solver.js`

Gauss-Seidel iterative relaxation (maxIter=200, tol=1e-6):

10 constraint types: Coincident, Distance, Fixed, Horizontal, Vertical,
Parallel, Perpendicular, EqualLength, Tangent, Angle.

Parametric variables supported with formula evaluation (+, -, *, /, parens).
WASM mirror in `assembly/solver.ts`.

---

## File Formats

| Format | Import | Export | Module |
|--------|--------|--------|--------|
| STEP (ISO 10303) | `StepImport.js` | `StepExport.js` | Full B-Rep topology |
| DXF | `dxf/import.js` | `dxf/export.js` | 2D geometry |
| .cmod | `cmod.js` | `cmod.js` | Native project format (JSON) |

**.cmod** (CAD Modeller Open Design): JSON-based project file containing feature
tree, sketches, part state, camera, workspace mode, and metadata. Version 1.

---

## Persistence & History

**persist.js**: Debounced (500ms) auto-save to LocalStorage. Serializes scene,
part, orbit camera, workspace mode, named scenes. `loadProject()` restores on
startup.

**history.js**: Undo/redo via deep-copy JSON snapshots (max 50). Snapshot
format: `{ scene, part }`.

---

## Application Shell — `js/main.js`

The `App` class (~9K lines) is the top-level state machine managing:
- Workspace modes (2D sketch, 3D part design)
- Tool selection and dispatch
- File operations (new, open, save, import/export)
- UI panels (feature tree, parameters, layers, DXF export)
- 3D orbit camera and face/edge selection
- Interaction recording/playback

Supporting modules: `part-manager.js` (workflow orchestration), `state.js`
(global singleton), `snap.js` (grid/object snapping), `logger.js` (leveled
console output).

### UI Modules — `js/ui/`

| Module | Purpose |
|--------|---------|
| featurePanel.js | Feature tree panel |
| parametersPanel.js | Feature parameter editing |
| featureIcons.js | SVG icons per feature type |
| popup.js | Modal dialogs |
| contextMenu.js | Right-click context menu |
| dxfExportPanel.js | DXF export options |

---

## Testing

```bash
npm test                  # Full test suite
npm run test:parametric   # Parametric feature tests
```

53 test files (~22k lines) covering:

| Area | Tests |
|------|-------|
| Geometry | test-nurbs, test-wasm-tessellation, test-mesh-quality (85 tests) |
| Features | test-exact-extrude, test-exact-revolve, test-multi-body-chamfer-fillet |
| Chamfer/Fillet | test-brep-chamfer, test-spline-chamfer (17), test-nurbs-fillet-chamfer-variants (52) |
| Booleans | test-boolean-analytic, test-boolean-nurbs, test-boolean-hardening |
| Topology | test-brep-topology (29), test-coplanar-merge, test-stable-hash (21) |
| STEP | test-step-import, test-step-export |
| Pipeline | test-feature-pipeline (46), test-toolkit (82), test-history-replay (60) |
| Sketching | test-sketch-drag, test-spline-multi-extrude (23), test-multi-sketch-planes |
| I/O | test-cmod-import-export, test-geometry-persistence |
| UI | test-ui-workflow, test-face-selection, test-interaction-recorder |
| Patterns | test-mirror-pattern |

### Shared Test Helpers — `tests/test-helpers.js`

Common utilities extracted to reduce duplication across test files:

- `createTestContext(name)` — scoped test runner with pass/fail tracking
- `assertApprox()` — floating-point approximate equality
- `checkManifold()` / `assertManifold()` — mesh manifoldness validation
- `countBoundaryEdges()` / `assertTopoClosed()` — TopoBody closure checks
- `makeRectSketch()`, `makeCircleSketch()`, `makeBoxPart()` — sketch/part factories
- `edgeKey()`, `findEdge()`, `getExtrudeResult()` — edge selection utilities

---

## Performance Architecture

### STEP Import Optimizations

Hot-path functions in `StepImport.js` and `CSG.js` use integer math for hash key
generation (`Math.round(v * 1e6)` instead of `Number.toFixed()`) to avoid
allocating formatted strings in inner loops.

Adaptive subdivision (`_subdivideBSplineTriangles`) propagates UV coordinates on
split vertices so that `closestPointUV` can skip its 289-point grid search and
go directly to Newton-Raphson refinement via UV hints.

`computeFeatureEdges` in `CSG.js` skips the O(n²) T-junction analysis for STEP
topology faces (identified by `topoFaceId`) since their boundary edges are
suppressed downstream anyway.

### Tessellation

WASM-accelerated NURBS evaluation (Cox-de Boor basis + tensor products) for
curve and surface tessellation. Falls back to identical JS implementations when
WASM is unavailable. The WASM module loads asynchronously at startup and is
guaranteed ready before any tessellation occurs.

---

## Dependencies

- **AssemblyScript** 0.28.9 — WASM compiler (devDependency)
- **@napi-rs/canvas** 0.1.68 — Headless canvas for CLI tools (devDependency)
- Zero runtime dependencies

---

## Feature Flags

All CAD-kernel feature flags are defined in `js/featureFlags.js` (import path
`modeller/flags`).  Every flag defaults to **OFF** so importing the module
never changes existing behaviour.

Flags are resolved in this priority order:

1. **Programmatic override** — `setFlag(name, value)` / `resetFlags()`
2. **Environment variable** — `process.env.CAD_*` (Node.js only)
3. **Default** — defined in the flag table below

Boolean flags accept `'1'`, `'true'`, `'yes'` (case-insensitive) as truthy.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `CAD_USE_IR_CACHE` | boolean | `false` | Enable CBREP IR cache embedding in `.cmod` files |
| `CAD_IR_CACHE_MODE` | string | `'none'` | IR cache storage mode: `'none'` \| `'memory'` \| `'fs'` \| `'idb'` |
| `CAD_USE_WASM_EVAL` | boolean | `false` | Prefer WASM evaluator for NURBS curve/surface evaluation |
| `CAD_USE_GWN_CONTAINMENT` | boolean | `false` | Use generalized winding number for containment |
| `CAD_USE_ROBUST_TESSELLATOR` | boolean | `false` | Use the Tessellator2 robust tessellation pipeline |
| `CAD_ALLOW_DISCRETE_FALLBACK` | boolean | `false` | Allow discrete mesh fallback when exact boolean fails |
| `CAD_STRICT_INVARIANTS` | boolean | `false` | Throw on invariant violations instead of warning |
| `CAD_DIAGNOSTICS_DIR` | string | `''` | Directory path for diagnostic JSON output (empty = disabled) |

---

## Module Boundaries (Package Exports)

The `package.json` `"exports"` map defines the public API surface:

| Import path | Module | Description |
|---|---|---|
| `modeller` | `js/index.js` | All headless CAD APIs (geometry, constraints, features, NURBS, B-Rep, CSG) |
| `modeller/cad` | `js/cad/index.js` | Core CAD kernel — primitives, features, solver, B-Rep, booleans, diagnostics |
| `modeller/render` | `js/render/index.js` | Node.js canvas renderer |
| `modeller/cmod` | `js/cmod.js` | CMOD project file import/export |
| `modeller/logger` | `js/logger.js` | Lightweight leveled logger |
| `modeller/wasm` | `build/release.js` | Raw AssemblyScript WASM module |
| `modeller/flags` | `js/featureFlags.js` | Centralized feature-flag registry |
| `modeller/ir` | `js/ir/index.js` | CBREP binary IR (schema, canonicalize, read/write, hash) |
| `modeller/cache` | `js/cache/index.js` | Cache store interface + Node.js/browser implementations |
| `modeller/workers` | `js/workers/index.js` | Web Worker entry points |

Internal modules (`packages/ir/*`, `packages/cache/*`) are implementation
details and may change without notice.  Always import through the `js/`
barrel modules above.
