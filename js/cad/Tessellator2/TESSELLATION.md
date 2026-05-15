# Tessellation Architecture

## Overview

The live tessellation path is native WASM / OCCT-first:

- `js/cad/Tessellation.js` routes body display and STL tessellation to the native WASM kernel.
- `js/cad/StepImportWasm.js` and STEP import use the same native trimming and mesh-validation path.
- `js/cad/TessellationConfig.js` controls tessellation density only. Its serialized `tessellator` field is retained for backward compatibility and diagnostics; it does not switch the live runtime path.

`js/cad/Tessellator2/` is retained only as a compatibility / forensic stack. It is no longer exported from the public CAD barrels, no longer exercised by default package test scripts, and is only imported by dedicated diagnostics such as:

- `tools/diagnose-cmod-faces.js`
- `tests/debug-step-tessellation.js`
- `tests/diag-*.js`

All tessellation paths still produce the same mesh format:
```js
{ vertices: [{x,y,z}, ...], faces: [{vertices, normal, shared}, ...], edges: [...] }
```

## TessellationConfig

`js/cad/TessellationConfig.js` is the single public interface for
live tessellation quality control.

### Fields

| Field                | Type    | Default    | Description                          |
|----------------------|---------|------------|--------------------------------------|
| `curveSegments`      | number  | 16         | Curve tessellation segments          |
| `surfaceSegments`    | number  | 8          | Surface U/V subdivisions             |
| `edgeSegments`       | number  | 16         | Edge wireframe segments              |
| `adaptiveSubdivision`| boolean | true       | Enable adaptive refinement           |
| `tessellator`        | string  | `'legacy'` | Compatibility-only serialized field; ignored by the live WASM path |

### Presets

| Preset  | curve | surface | edge |
|---------|-------|---------|------|
| draft   | 8     | 4       | 8    |
| normal  | 16    | 8       | 16   |
| fine    | 32    | 16      | 32   |
| ultra   | 64    | 32      | 64   |

## Compatibility Tessellator (Tessellator2)

Tessellator2 is preserved for forensic debugging and historical incident
reproduction. It is not part of `tessellateBody()` or the OCCT / WASM-first
runtime route.

### Pipeline Stages

```
1. EdgeSampler      — sample each TopoEdge once, cache by id+segments
2. FaceTriangulator — triangulate faces using shared boundary samples
3. MeshStitcher     — deduplicate vertices, assemble body mesh
4. Refinement       — chordal/angular error hooks (placeholder for adaptive)
5. MeshValidator    — optional watertightness / self-intersection checks
```

### Module Layout

```
js/cad/Tessellator2/
├── EdgeSampler.js       — shared edge sampling with caching
├── FaceTriangulator.js  — parameter-space face triangulation
├── Refinement.js        — adaptive refinement utilities
├── MeshStitcher.js      — vertex deduplication and mesh assembly
├── MeshHash.js          — deterministic FNV-1a mesh hashing
└── index.js             — public entry point and config routing
```

### Key Design Decisions

1. **Edge sampling is canonical**: Each `TopoEdge` is sampled exactly once
   per config. Coedges on adjacent faces reference the same point objects
   (possibly reversed). This guarantees watertight boundaries.

2. **Collinear point removal**: For planar faces with straight edges,
   intermediate collinear samples are removed before ear-clipping to
   prevent degenerate triangles.

3. **GeometryEvaluator is authoritative**: All NURBS curve/surface
   evaluation goes through `GeometryEvaluator`, which is WASM-first
   with JS fallback. The compatibility tessellator evaluates point-by-point,
   bypassing native tessellation buffer caps for debugging.

4. **Debug-only surface**: `robustTessellateBody()`, `tessellateBodyRouted()`,
   `shadowTessellateBody()`, and `FaceTriangulator` are compatibility helpers
   for diagnostics. They are not part of the live product path.

### WASM Buffer Limits

The native surface tessellation path (`nurbsSurfaceTessellate`) has a
fixed buffer of (128+1)² = 16641 vertices. Compatibility diagnostics can
bypass this cap by evaluating through `GeometryEvaluator` point-by-point,
but the live route stays on the native tessellation path.

## Mesh Validation

`MeshValidator.js` provides:
- `detectSelfIntersections(faces)` — O(n²) Möller–Trumbore check
- `detectBoundaryEdges(faces)` — edge manifoldness check
- `detectDegenerateFaces(faces)` — zero-area triangle detection
- `validateMesh(faces)` — combined summary

## Testing

The active tessellation path is now covered by:
- `tests/test-wasm-tessellation-policy.js` for WASM-only routing policy
- `tests/test-wasm-tessellation.js` for native tessellation behavior
- `tests/test-lod-retess.js` for live LoD retessellation
- `tests/test-api-migration.js` for package-level migration contracts
- `tests/test-step-import-nist.js` for STEP import regression
