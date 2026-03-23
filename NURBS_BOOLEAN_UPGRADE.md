# NURBS And Boolean Upgrade Guide

## Purpose

This document defines the upgrade path from the current tessellated mesh workflow to a manufacturing-grade exact-geometry CAD kernel suitable for high-resolution DXF, STEP, and STL export.

The target is not "better mesh booleans". The target is an exact Boundary Representation (B-Rep) workflow where:

- sketches produce exact curves
- features produce exact surfaces and trims
- booleans operate on surfaces, curves, loops, and topology
- tessellation is only a downstream visualization/export approximation

This is the minimum architecture required for STEP-quality CAD behavior.

## Current State

### What Exists

- Parametric feature tree in [js/cad/Feature.js](js/cad/Feature.js), [js/cad/FeatureTree.js](js/cad/FeatureTree.js), and [js/cad/Part.js](js/cad/Part.js)
- Mesh-based solid generation in [js/cad/ExtrudeFeature.js](js/cad/ExtrudeFeature.js) and [js/cad/RevolveFeature.js](js/cad/RevolveFeature.js)
- Mesh boolean engine in [js/cad/CSG.js](js/cad/CSG.js)
- Exact-geometry containers in [js/cad/BRep.js](js/cad/BRep.js)
- NURBS surfaces in [js/cad/NurbsSurface.js](js/cad/NurbsSurface.js)
- NURBS curves in [js/cad/NurbsCurve.js](js/cad/NurbsCurve.js)
- Partial exact surface generation for chamfer and fillet workflows

### What Does Not Exist Yet

- General exact B-Rep solid model for every feature
- Face parameter-space trims and loop ownership
- Surface/surface intersection engine
- Curve/surface intersection engine
- General topology split and re-stitch logic
- Exact boolean classification of cells, shells, and trimmed faces
- STEP writer backed by exact topology and geometry

### Consequence

The current boolean engine can only ever be mesh-robust, not CAD-exact. It cannot satisfy manufacturing-grade expectations for arbitrary combinations of:

- planar faces
- revolved faces
- trimmed faces
- fillets and chamfers
- freeform NURBS faces
- intersecting sketch planes

## Target End State

The upgraded kernel should represent every solid as:

- topological entities: body, shell, face, loop, coedge, edge, vertex
- geometric support entities: plane, cylinder, cone, sphere, torus, swept surface, NURBS surface, line, circle, ellipse, NURBS curve
- trimming entities: 3D edge curve plus 2D p-curve on each adjacent face
- tolerances: model resolution, edge tolerance, vertex tolerance, sewing tolerance

Every feature should output both:

- exact B-Rep data for modeling and export
- display mesh derived from the exact B-Rep for rendering and selection

## Non-Negotiable Principles

1. The B-Rep is the source of truth.
2. Meshes are disposable display artifacts.
3. No boolean should be based on face triangulation as the primary representation.
4. Every edge in a final solid must have both topology and exact geometric meaning.
5. Every trimmed face must know its support surface and boundary loops.
6. STEP export must serialize exact faces and edges, not reverse-engineered triangles.
7. STL export remains tessellated, but must come from the exact model at controlled resolution.

## Required Data Model Upgrade

### Replace The Current Minimal B-Rep With A Full Topology Graph

Extend [js/cad/BRep.js](js/cad/BRep.js) to include:

- `BRepBody`
- `BRepShell`
- `BRepFace`
- `BRepLoop`
- `BRepCoedge`
- `BRepEdge`
- `BRepVertex`

Minimum responsibilities:

- `BRepFace`: support surface, outer loop, inner loops, orientation, tolerance
- `BRepLoop`: ordered coedges
- `BRepCoedge`: oriented reference to an edge, owning face, p-curve on face
- `BRepEdge`: 3D curve, start vertex, end vertex, adjacent coedges, tolerance
- `BRepVertex`: exact point, tolerance, incident edges

### Add Support Surface Typing

Each face support surface should explicitly carry a type:

- plane
- cylinder
- cone
- sphere
- torus
- extrusion surface
- revolution surface
- bspline surface

Avoid collapsing everything into generic NURBS too early. Analytic surfaces are easier to intersect, trim, offset, and export accurately.

### Add Parametric Trims

Each coedge must store a p-curve on the owning face.

Without p-curves, trimmed-face operations remain fragile because the kernel cannot reliably:

- split faces
- classify loops
- sew adjacent faces
- export exact trims to STEP

## Feature Output Upgrade

### Sketches

Upgrade sketch output so profiles preserve exact curve segments:

- lines
- arcs
- circles
- ellipses when added
- bspline curves when added

Each closed profile should export as an exact wire, not only a sampled polygon.

### Extrude

Upgrade [js/cad/ExtrudeFeature.js](js/cad/ExtrudeFeature.js) so it produces:

- planar cap faces with exact trim loops
- exact side faces as:
  - planar surfaces for line segments parallel to extrusion direction
  - cylindrical surfaces for circular arcs extruded normally
  - swept/NURBS surfaces for general curves
- exact vertical edge curves
- exact profile-derived top and bottom wires

Do not generate the exact model from the tessellated result. Build the B-Rep directly from the sketch wire.

### Revolve

Upgrade [js/cad/RevolveFeature.js](js/cad/RevolveFeature.js) so it produces:

- analytic revolution faces where possible
- trimmed revolved faces bounded by exact meridian and profile curves
- exact cap faces for partial revolves
- exact seam edges for closed revolves

### Fillet And Chamfer

Current chamfer/fillet exactness in [js/cad/CSG.js](js/cad/CSG.js) should be refactored out of mesh-repair helpers and rebuilt as feature-native B-Rep operations.

That means:

- select topological edges, not mesh edges
- trim adjacent exact faces
- create new support surfaces
- insert new loops/coedges/edges
- regenerate display mesh from resulting B-Rep

## Boolean Kernel Upgrade

### Replace Mesh BSP With Exact B-Rep Boolean Operations

The function currently exposed as `booleanOp()` in [js/cad/CSG.js](js/cad/CSG.js) should become a façade over a new exact boolean pipeline.

Recommended structure:

- `js/cad/BooleanKernel.js`
- `js/cad/Intersections.js`
- `js/cad/TopologyBuilder.js`
- `js/cad/Tolerance.js`
- `js/cad/Tessellation.js`

### Exact Boolean Pipeline

For `union`, `subtract`, and `intersect`:

1. Intersect every candidate face pair.
2. Compute exact intersection curves.
3. Split support faces by intersection curves.
4. Build trimmed face fragments in parameter space.
5. Classify each fragment as inside, outside, or coincident.
6. Keep or discard fragments according to boolean type.
7. Stitch kept fragments into shells.
8. Sew vertices and edges within tolerance.
9. Validate shell orientation and closure.
10. Tessellate the result for rendering.

### Intersection Requirements

The kernel must support at least:

- plane/plane
- plane/cylinder
- plane/cone
- plane/sphere
- plane/revolved surface
- plane/bspline surface
- cylinder/cylinder
- cylinder/bspline surface
- bspline/bspline with numeric fallback

Practical approach:

- implement analytic-solvable pairs first
- add numerical marching/refinement for generic NURBS pairs
- reproject and refine intersection samples onto both surfaces
- fit exact or approximate intersection curves with bounded tolerance

### Coincident And Near-Coincident Handling

This is where most CAD kernels fail if tolerances are vague.

Add an explicit tolerance policy module with:

- modeling epsilon
- point coincidence tolerance
- edge overlap tolerance
- angular parallelism tolerance
- sewing tolerance
- export tolerance

Every boolean decision must use the same tolerance policy.

## STEP-Quality Export Requirements

### Internal Representation Requirements

Before STEP export is attempted, the kernel must be able to serialize:

- exact support surfaces
- exact edge curves
- p-curves on faces
- shell orientation
- loop orientation
- trimmed face boundaries

### STEP Scope Recommendation

Implement in this order:

1. AP203/AP214 style analytic and bounded surfaces
2. AP242-oriented B-spline and trimmed NURBS support

Minimum face entities to support cleanly:

- advanced face
- plane
- cylindrical surface
- conical surface
- spherical surface
- surface of linear extrusion
- surface of revolution
- b-spline surface with knots
- edge curve
- oriented edge
- vertex point
- face bound
- edge loop
- closed shell
- manifold solid brep

### DXF And STL Positioning

- DXF should export exact 2D curves where the source geometry is exact and planar.
- STL should export from exact B-Rep tessellation with user-controlled chordal deviation and angular tolerance.
- STEP should never be built from STL-style triangles.

## Implementation Phases

### Phase 1: Stabilize Geometry Ownership

Goal: stop generating solids as mesh-first artifacts.

Tasks:

- create full topological B-Rep classes
- make extrude emit exact B-Rep alongside mesh
- make revolve emit exact B-Rep alongside mesh
- maintain face-to-feature provenance on exact entities
- add B-Rep validation helpers

Exit criteria:

- a new extrude or revolve can be represented without `CSG.js`
- mesh can be regenerated from B-Rep for display

### Phase 2: Exact Sketch Wires

Goal: preserve exact profile curves from sketch to solid feature.

Tasks:

- represent closed sketch profiles as exact wires
- maintain curve continuity and orientation
- detect nested loops and islands exactly
- add wire healing and tolerance checks

Exit criteria:

- profile input to extrude/revolve is exact wire data, not sampled points only

### Phase 3: Face Splitting Infrastructure

Goal: enable exact trimming before full booleans.

Tasks:

- implement p-curves for loops/coedges
- split analytic faces by exact trim curves
- classify loop orientation in face UV space
- rebuild trimmed face fragments

Exit criteria:

- planar and cylindrical faces can be trimmed and re-tessellated robustly

### Phase 4: Limited Exact Boolean Kernel

Goal: replace the current subtract failures in the most common production workflows.

Scope:

- extrude vs extrude
- extrude-cut against planar and cylindrical faces
- union/subtract/intersect on analytic faces only

Tasks:

- analytic intersection routines
- face fragment classification
- shell stitching and sewing
- manifold validation

Exit criteria:

- current failing coplanar extrude-cut regression no longer depends on mesh BSP
- analytic-only boolean regression suite passes consistently

### Phase 5: General NURBS Boolean Support

Goal: add mixed analytic and bspline support.

Tasks:

- surface marching for bspline intersections
- curve fitting and refinement against both support surfaces
- trimmed NURBS face splitting
- mixed-surface classification and sew operations

Exit criteria:

- subtract and union are reliable on mixed planar, revolved, and NURBS face combinations

### Phase 6: STEP Export

Goal: export exact topology and geometry.

Tasks:

- STEP entity writer
- topological graph serialization
- support-surface serialization
- edge curve and p-curve serialization
- export validation round-trip tests

Exit criteria:

- exported STEP opens in external CAD systems with preserved face classes and topology

## Required Module Layout

Recommended additions:

- `js/cad/BRepTopology.js`
- `js/cad/BRepValidator.js`
- `js/cad/BooleanKernel.js`
- `js/cad/Intersections.js`
- `js/cad/CurveCurveIntersect.js`
- `js/cad/CurveSurfaceIntersect.js`
- `js/cad/SurfaceSurfaceIntersect.js`
- `js/cad/FaceSplitter.js`
- `js/cad/ShellBuilder.js`
- `js/cad/Tolerance.js`
- `js/cad/Tessellation.js`
- `js/cad/StepExport.js`

Recommended responsibility split:

- [js/cad/CSG.js](js/cad/CSG.js): compatibility façade only
- feature files: exact feature construction
- B-Rep modules: truth model and topology
- tessellation: render mesh generation
- STEP export: exact model serialization

## Testing And Validation Requirements

### Geometry Validation

Add kernel-level validation for every feature and boolean result:

- closed shell check
- oriented shell check
- non-self-intersecting trims
- edge-to-coedge consistency
- vertex-edge incidence consistency
- no dangling coedges
- no duplicate coincident edges after sewing

### Numerical Validation

Add tolerance-focused tests for:

- coplanar start faces
- grazing intersections
- nearly coincident planes
- thin walls
- tiny holes
- nested loops
- mixed analytic and NURBS surfaces

### External Validation

Create golden export tests for:

- STEP opens in external CAD without repair prompts
- STL tessellation matches requested tolerance
- DXF planar projections preserve true arcs and circles when possible

### Regression Suite Expansion

Extend [tests/test-cmod-import-export.js](tests/test-cmod-import-export.js) and add dedicated suites for:

- `tests/test-brep-topology.js`
- `tests/test-exact-extrude.js`
- `tests/test-exact-revolve.js`
- `tests/test-boolean-analytic.js`
- `tests/test-boolean-nurbs.js`
- `tests/test-step-export.js`

## Migration Strategy

### Do Not Delete Mesh Rendering

The renderer still needs triangles. Keep the mesh pipeline, but demote it to a derived representation.

Migration rule:

- old path: sketch -> tessellated solid -> boolean -> render
- new path: sketch -> exact B-Rep -> boolean -> tessellate -> render

### Keep A Compatibility Façade

Keep `booleanOp()` in [js/cad/CSG.js](js/cad/CSG.js) as a compatibility entry point during migration.

Transitional behavior:

- if operands expose exact B-Rep, dispatch to exact boolean kernel
- otherwise fall back to legacy mesh boolean temporarily
- log or flag legacy fallback use in tests and development mode

This allows incremental migration without breaking the feature tree API immediately.

### Upgrade Order For Existing Features

Implement exactness in this order:

1. Sketch wire exactness
2. Extrude exact B-Rep
3. Revolve exact B-Rep
4. Analytic boolean kernel
5. Chamfer and fillet as exact topological edits
6. NURBS boolean support
7. STEP exporter

This order matches the current repo structure and gives the fastest path to removing the current subtract failure class.

## Compliance Guidance

Do not claim formal manufacturing or STEP compliance until the following are true:

- exact topology is the source model
- exact booleans replace mesh BSP for supported workflows
- tolerance policy is explicit and testable
- STEP export is validated in external CAD systems
- regression coverage includes analytic and NURBS mixed cases

Appropriate interim language:

- "exact-geometry architecture in progress"
- "STEP-oriented B-Rep kernel"
- "manufacturing-grade target workflow"

Avoid language like:

- "fully compliant"
- "manufacturing certified"
- "STEP accurate" without external validation

## Definition Of Done

The upgrade is complete only when all of the following are true:

1. Extrude and revolve generate exact B-Rep first.
2. Booleans operate on exact topology and surfaces for supported workflows.
3. Fillets and chamfers modify exact topology instead of patching mesh faces.
4. Display meshes are generated from exact B-Rep.
5. STEP export uses exact surfaces, loops, edges, and topology.
6. STL export is tolerance-controlled tessellation from exact geometry.
7. The current coplanar extrude-cut failure is resolved by the exact kernel, not by mesh healing.
8. Regression suites cover mixed analytic and NURBS intersections.

## Immediate Next Step For This Repository

The correct next implementation step is:

1. make sketch profiles exact wires
2. make extrude and revolve emit exact B-Rep solids directly
3. introduce a limited analytic boolean kernel for planar and revolved faces

That path addresses the current subtract failure while moving the architecture toward STEP-quality CAD instead of deepening mesh hacks.