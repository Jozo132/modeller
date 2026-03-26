# Tessellation Architecture

## Overview

The modeller provides two tessellation pipelines, selectable via
`TessellationConfig.tessellator`:

| Mode     | Module                    | Description                              |
|----------|---------------------------|------------------------------------------|
| `legacy` | `js/cad/Tessellation.js`  | Independent per-face tessellation (default) |
| `robust` | `js/cad/Tessellator2/`    | Edge-first shared-boundary pipeline      |

Both pipelines produce the same mesh format:
```js
{ vertices: [{x,y,z}, ...], faces: [{vertices, normal, shared}, ...], edges: [...] }
```

## TessellationConfig

`js/cad/TessellationConfig.js` is the single public interface for
tessellation quality control.

### Fields

| Field                | Type    | Default    | Description                          |
|----------------------|---------|------------|--------------------------------------|
| `curveSegments`      | number  | 16         | Curve tessellation segments          |
| `surfaceSegments`    | number  | 8          | Surface U/V subdivisions             |
| `edgeSegments`       | number  | 16         | Edge wireframe segments              |
| `adaptiveSubdivision`| boolean | true       | Enable adaptive refinement           |
| `tessellator`        | string  | `'legacy'` | Pipeline selection: `'legacy'` or `'robust'` |

### Presets

| Preset  | curve | surface | edge |
|---------|-------|---------|------|
| draft   | 8     | 4       | 8    |
| normal  | 16    | 8       | 16   |
| fine    | 32    | 16      | 32   |
| ultra   | 64    | 32      | 64   |

## Robust Tessellator (Tessellator2)

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
   with JS fallback. The robust tessellator evaluates point-by-point,
   bypassing WASM tessellation buffer caps.

4. **Legacy fallback**: If robust tessellation fails for a body, the
   `tessellateBodyRouted()` function falls back to the legacy path and
   records a diagnostic payload.

### WASM Buffer Limits

The WASM surface tessellation path (`nurbsSurfaceTessellate`) has a
fixed buffer of (128+1)² = 16641 vertices. Requests exceeding this
return -1, and the JS side falls back to pure JS evaluation. The
robust tessellator bypasses this cap by evaluating through
`GeometryEvaluator` point-by-point.

## Mesh Validation

`MeshValidator.js` provides:
- `detectSelfIntersections(faces)` — O(n²) Möller–Trumbore check
- `detectBoundaryEdges(faces)` — edge manifoldness check
- `detectDegenerateFaces(faces)` — zero-area triangle detection
- `validateMesh(faces)` — combined summary

## Testing

`tests/test-mesh-quality.js` covers:
- Watertightness on closed bodies (box, prism)
- Shared-edge consistency (same point objects)
- No self-intersections
- Deterministic mesh hashing
- Trimmed-face correctness (planar face with hole)
- Config routing (legacy/robust)
- Legacy regression
- STEP corpus validation
