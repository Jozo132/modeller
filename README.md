# CAD Modeller

A browser-based parametric CAD modeller with exact NURBS/B-Rep geometry, 2D sketch tools, feature-tree part modeling, STEP import/export, and a published OCCT WebAssembly lane for exact modeling authority. Built with vanilla JavaScript (ES modules), browser-first UI code, and WebAssembly-backed kernel paths for both the web app and headless Node.js usage.

Try it online: [GitHub Pages demo](https://jozo132.github.io/modeller/)

## Current Direction

- **OCCT-backed exact modeling** now covers the primary exact-modeling lane for supported sketch solids, STEP residency, direct booleans, and downstream topology queries.
- **AssemblyScript/WASM infrastructure** still powers app-side acceleration, tessellation helpers, and legacy/native runtime support where OCCT is not the active authority.
- **Browser and Node.js support** are both first-class: the repo runs as an interactive local web app and as a reusable headless library for conversion, rendering, and testing.
- **Hosted fallback support** is built in: local development can serve package-hosted OCCT assets, while hosted builds can fall back to a CDN-delivered OCCT package.

## Features

### Exact Geometry Kernel
- **B-Rep Topology** — Full boundary representation: `TopoBody → TopoShell → TopoFace → TopoLoop → TopoCoEdge → TopoEdge → TopoVertex`
- **OCCT WASM Authority** — Published [`occt-kernel-wasm`](https://www.npmjs.com/package/occt-kernel-wasm) integration for resident exact shapes, STEP import/export, topology queries, tessellation, and structured feature APIs
- **NURBS Curves & Surfaces** — Rational B-splines with Cox-de Boor evaluation, arc/circle/ellipse factories, splitting, tessellation
- **Analytic Surface Types** — Plane, Cylinder, Cone, Sphere, Torus, Extrusion, Revolution, B-Spline
- **Exact Booleans** — Surface-surface intersection, face splitting, inside/outside classification, shell building
- **WASM Acceleration** — Compiled AssemblyScript for NURBS evaluation, constraint solving, and 2D rendering with automatic JS fallback

### 3D Operations
- ✅ **Extrude** — Linear extrusion of 2D profiles (segments, arcs, splines, beziers) into exact NURBS solids
- ✅ **Revolve** — Revolve profiles around an axis with angle control
- ✅ **Chamfer** — Flat bevel on edges (PLANE+PLANE, PLANE+BSPLINE at various dihedral angles)
- ✅ **Fillet** — Rolling-ball blend on edges with NURBS arc surfaces and sphere-patch corners
- ✅ **Boolean** — Union, subtraction, intersection via exact B-Rep kernel (mesh BSP fallback)
- ✅ **Multi-body** — Multiple disjoint solids from separate sketch profiles

### 2D Sketch System
- **Drawing Tools** — Line, Rectangle, Circle, Arc, Polyline, Spline, Bezier, Text, Dimension
- **Editing Tools** — Select, Move, Copy
- **Snap System** — Endpoint, Midpoint, Center, Quadrant, Grid snapping
- **Constraint Solver** — 10 types: Coincident, Distance, Fixed, Horizontal, Vertical, Parallel, Perpendicular, EqualLength, Tangent, Angle
- **Profile Extraction** — Automatic closed-loop detection for splines, beziers, and mixed profiles

### Import / Export
- **STEP** (ISO 10303) — Full B-Rep topology import and export (AP203/AP214/AP242)
- **DXF** — AutoCAD DXF R2000 ASCII 2D import/export
- **SVG** — Import and export with cubic/quadratic bezier support
- **.cmod** — Native JSON project format (feature tree, sketches, camera, metadata)
- **STL** — Triangle mesh export

### Parametric Feature System
- **Feature Tree** — Ordered parametric operations with dependency tracking
- **Recursive Recalculation** — Modifying a feature automatically recomputes all dependents
- **Stable Entity Keys** — History-based identity that survives parameter changes and serialization
- **Feature Types**: SketchFeature, ExtrudeFeature, ExtrudeCutFeature, MultiSketchExtrudeFeature, RevolveFeature, SweepFeature, LoftFeature, ChamferFeature, FilletFeature, StepImportFeature

### Application
- **Split View** — 2D canvas + 3D WebGL viewport
- **Undo/Redo** — Full history snapshots (max 50)
- **Auto-save** — Debounced persistence to LocalStorage
- **Layers** — Multiple layers with color, visibility, lock control
- **Touch Support** — Responsive UI with gesture handling

## Using the 3D Workflow

1. **Draw your sketch** — Use the 2D drawing tools (Line, Rectangle, Circle, Arc, Spline, Bezier) to create geometry
2. **Toggle 3D mode** — Click the "Toggle 3D View (3)" button in the toolbar
3. **Add sketch to part** — Click "Add Sketch to Part" to convert your 2D sketch to a feature
4. **Apply operations**:
   - Click "Extrude Sketch" to create a 3D solid (supports exact NURBS/B-Rep topology)
   - Click "Revolve Sketch" to revolve around an axis
   - Select edges in 3D, then apply Chamfer or Fillet
5. **Modify parameters** — Select features in the Feature Tree to edit their properties
6. **Watch live updates** — The 3D view automatically updates as you modify features

## Architecture

The project features a topology-first architecture with three main design interfaces:

- **Sketch** — 2D drawing interface for creating parametric geometry with constraints
- **Part** — Parametric 3D part modeling with feature tree and exact B-Rep topology
- **Assembly** — (Stub) Future support for multi-part assemblies with constraints and BOM

The CAD kernel uses exact NURBS/B-Rep topology as the source of truth. Triangle meshes are generated only for rendering. Feature operations, STEP residency, and OCCT-backed exact-modeling flows are all designed around exact topology rather than mesh-derived authority.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed documentation.

## Repository Docs

- [README.md](README.md) is the current project overview, setup guide, and public-facing usage reference.
- [ARCHITECTURE.md](ARCHITECTURE.md) is the maintained design doc for runtime structure and modeling rules.

## Library Usage (NPM package)

The package can be imported as a reusable library in both **Node.js** (backend meshing, conversion, testing, server-side rendering) and **browser** (frontend 3D/2D viewer, parametric modelling):

```bash
npm install modeller
```

### Main entry point — all headless CAD APIs

```js
import {
  Part, Sketch, Scene, Assembly,
  SketchFeature, ExtrudeFeature, RevolveFeature, ChamferFeature, FilletFeature,
  Constraint, Coincident, Distance, Fixed,
  buildCMOD, parseCMOD, getScenesFromCMOD,
  exportSTEP,
  NurbsCurve, NurbsSurface,
  calculateMeshVolume, calculateBoundingBox,
  applyChamfer, applyFillet,
} from 'modeller';
```

### Sub-path exports

| Import path | Contents |
|---|---|
| `modeller` | All headless CAD APIs (geometry, constraints, features, NURBS, B-Rep, CSG) |
| `modeller/cad` | Core CAD primitives, features, solver, B-Rep, CSG — same as `modeller` |
| `modeller/render` | Node.js canvas renderer (`renderCmodToPngBuffer`, `SceneRenderer`, …) |
| `modeller/cmod` | Full CMOD project import/export (includes browser helpers) |
| `modeller/logger` | Lightweight logger (`debug`, `info`, `warn`, `error`, `setLogLevel`) |
| `modeller/wasm` | Raw AssemblyScript WASM 2D/solver module |
| `modeller/flags` | Feature-flag registry (`getFlag`, `setFlag`, `allFlags`, `flagDefinitions`) |
| `modeller/ir` | CBREP binary IR — schema, canonicalize, read/write, hash |
| `modeller/cache` | Cache store interface + Node.js (fs) and browser (IndexedDB) stores |
| `modeller/workers` | Web Worker entry points (STEP import worker) |

### Headless meshing example (Node.js)

```js
import { Part, Sketch, buildCMOD, parseCMOD } from 'modeller';

const sketch = new Sketch();
sketch.addSegment(0, 0, 100, 0);
sketch.addSegment(100, 0, 100, 50);
sketch.addSegment(100, 50, 0, 50);
sketch.addSegment(0, 50, 0, 0);

const part = new Part('Box');
const sf = part.addSketch(sketch);
part.extrude(sf.id, 25);

const geo = part.getFinalGeometry();
console.log('faces:', geo.geometry.faces.length);

// Serialize to .cmod project file
const cmod = buildCMOD(part);
const json = JSON.stringify(cmod);

// Parse it back and validate
const result = parseCMOD(json);
console.log('valid:', result.ok);
```

### Server-side PNG render (Node.js)

```js
import { renderCmodToPngBuffer } from 'modeller/render';
import fs from 'node:fs/promises';

const raw = await fs.readFile('model.cmod', 'utf8');
const cmod = JSON.parse(raw);

const { buffer } = await renderCmodToPngBuffer({ cmod, width: 1280, height: 720, fitToView: true });
await fs.writeFile('model.png', buffer);
```

### STEP export (Node.js / browser)

```js
import { Part, Sketch, exportSTEP } from 'modeller';

// … build part as above …
const stepText = exportSTEP(part.getFinalGeometry()?.geometry);
```

## Getting Started (web app)

```bash
npm install
npm run start
```

When this repo sits alongside `../occt-kernel-wasm`, the OCCT loader and dev server prefer that sibling repo's `dist/` output for local development. If the sibling repo is absent, `modeller` falls back to the installed `occt-kernel-wasm` package and then the hosted CDN path.

Then open [http://localhost:3000](http://localhost:3000) in your browser.

To test the hosted/GitHub Pages style path locally, use:

```bash
npm run start:host
```

`start:host` intentionally blocks `/node_modules` and disables the local OCCT vendor mount so the app exercises the hosted fallback path instead of silently serving local package assets.

## Backend CMOD Screenshots

You can render a `.cmod` model to a PNG from a standalone Node renderer:

```bash
npm run render:cmod -- --input tests/samples/box-fillet-3-p.cmod --output out/box-fillet-3-p.png
```

The command uses the render library directly from Node with Canvas plus the existing WASM scene pipeline, so it respects the model's stored `.cmod` orbit by default. You can override the orbit explicitly:

```bash
npm run render:cmod -- --input tests/samples/box-fillet-3-p.cmod --output out/box.png --theta 0.8 --phi 1.1 --radius 30 --target 5,5,5
```

Available options:
- `--width <px>` and `--height <px>` control image size.
- `--fit-to-view` ignores the stored `.cmod` orbit and frames the current model bounds.
- `--orbit '<json>'` supplies the full orbit object in one argument.

The standalone render API lives under `js/render/`, so backend code can drive the scene directly while the frontend stays focused on UI and interaction.

## Testing

Run the full test suite:
```bash
npm test
```

Download the public CAD reference corpus used for STEP import interoperability work:
```bash
npm run download
```

The downloader currently fetches the public NIST PMI/FTC/CTC sample archive into `tests/nist-samples/` and writes a local manifest for regression use. These files are not authored by this project, are not checked into the repository, and remain subject to their original source terms.

They are used here only as externally hosted reference fixtures for interoperability, parser validation, and STEP import quality work. The project does not claim ownership of the downloaded models and should not redistribute them by copying the archive into the repository. If upstream hosting or usage terms change, review those terms before using the corpus again.

Run the dedicated NIST STEP corpus diagnostics after downloading the samples:
```bash
npm run test:nist-step
```

Refresh the tracked NIST scorecard baseline used to compare importer iterations:
```bash
npm run test:nist-step:scorecard
```

Run individual test areas:
```bash
node tests/test-feature-pipeline.js          # Feature tree execution (46+ tests)
node tests/test-multi-body-chamfer-fillet.js  # Chamfer/fillet operations (25+ tests)
node tests/test-occt-structured-adapter.js    # OCCT wrapper/native adapter contract
node tests/test-occt-feasibility.js           # OCCT end-to-end feasibility + residency seams
node tests/test-nurbs-fillet-chamfer-variants.js  # NURBS intersection edge cases (52 tests)
node tests/test-spline-chamfer.js             # Spline/bezier chamfer (17 tests)
node tests/test-toolkit.js                    # Toolkit utilities (82 tests)
node tests/test-wasm-tessellation-policy.js   # WASM tessellation routing policy
node tests/test-nurbs.js                      # NURBS curve/surface (25+ tests)
node tests/test-boolean-analytic.js           # Exact boolean kernel (18+ tests)
```

The test suite covers:

| Area | Key Tests |
|------|-----------|
| Geometry | NURBS curves/surfaces, WASM tessellation, mesh quality |
| Features | Extrude (exact), revolve, chamfer, fillet, multi-body |
| Booleans | Analytic booleans, NURBS booleans, T-junction fixes |
| Topology | B-Rep topology, coplanar merge, stable hashes |
| Edge cases | NURBS fillet/chamfer variants (52 tests across 7 profile types, 6+ dihedral angles) |
| STEP | Import and export with topology roundtrip |
| Sketching | Spline/bezier extrusion, multi-sketch planes, drag |
| I/O | CMOD import/export, geometry persistence, history replay |
| UI | Workflow recordings, face selection, feature editor |

## Parametric Modeling Example

```javascript
import { Part, Sketch } from 'modeller';

// Create a part
const part = new Part('MyPart');

// Create a sketch with a rectangle profile
const sketch = new Sketch();
sketch.addSegment(0, 0, 100, 0);
sketch.addSegment(100, 0, 100, 50);
sketch.addSegment(100, 50, 0, 50);
sketch.addSegment(0, 50, 0, 0);

// Add sketch as a feature
const sketchFeature = part.addSketch(sketch);

// Extrude the sketch to create 3D geometry
const extrudeFeature = part.extrude(sketchFeature.id, 25);

// Modify the extrusion distance - all dependent features recalculate automatically!
part.modifyFeature(extrudeFeature.id, (feature) => {
  feature.setDistance(50);
});

// Get the final 3D geometry
const geometry = part.getFinalGeometry();
console.log('Vertices:', geometry.geometry.vertices.length);
console.log('Faces:', geometry.geometry.faces.length);
```

## Author

J.Vovk <jozo132@gmail.com>

## License

[MIT](LICENSE)
