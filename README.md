# CAD Modeller

A browser-based 2D CAD modeller with parametric 3D part modeling capabilities. Built with vanilla JavaScript and HTML5 Canvas. Supports drawing, editing, and exporting geometry in DXF format.

## Features

### 2D Drawing
- **Drawing Tools** — Line, Rectangle, Circle, Arc, Polyline, Text, Dimension
- **Editing Tools** — Select, Move, Copy
- **Snap System** — Endpoint, Midpoint, Center, Quadrant, Grid snapping
- **DXF Import/Export** — Read and write AutoCAD DXF R2000 ASCII files
- **Layers** — Multiple layers with color, visibility, and lock control
- **Undo/Redo** — Full history support
- **Persistent State** — Project auto-saves to localStorage across page refreshes
- **Responsive UI** — Adapts to different screen sizes with touch support

### Parametric 3D Part Modeling (Integrated!)
- **Feature Tree** — Industry-standard parametric history tree with UI panel
- **Sketch + Operation Workflow** — Draw in 2D, convert to 3D parts with extrude/revolve
- **Split View Interface** — 2D canvas + 3D viewport with AssemblyScript WASM WebGL rendering
- **Recursive Recalculation** — Changing lower-level features automatically updates everything
- **Dependency Tracking** — Features declare dependencies; system validates operations
- **Feature Management** — Add, remove, reorder, suppress features with automatic validation
- **Interactive Parameters Panel** — Edit feature properties with live 3D preview updates
- **3D Operations**:
  - ✅ Extrude — Extrude 2D sketches to create 3D solids
  - ✅ Revolve — Revolve sketches around an axis
  - ⏳ Fillet, Chamfer (coming soon)
  - ⏳ Boolean operations (coming soon)

## Using the 3D Workflow

1. **Draw your sketch** — Use the 2D drawing tools (Line, Rectangle, Circle, etc.) to create geometry
2. **Toggle 3D mode** — Click the "Toggle 3D View (3)" button in the toolbar
3. **Add sketch to part** — Click "Add Sketch to Part" to convert your 2D sketch to a feature
4. **Apply operations**:
   - Click "Extrude Sketch" and enter a distance to create a 3D solid
   - Or click "Revolve Sketch" and enter an angle to revolve around an axis
5. **Modify parameters** — Select features in the Feature Tree to edit their properties
6. **Watch live updates** — The 3D view automatically updates as you modify features

## Architecture

The project features a modular architecture with three main design interfaces:

- **Sketch** — 2D drawing interface for creating parametric geometry with constraints
- **Part** — Parametric 3D part modeling with feature tree and recursive recalculation
- **Assembly** — (Stub) Future support for multi-part assemblies with constraints and BOM

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed documentation.
See [NURBS_BOOLEAN_UPGRADE.md](NURBS_BOOLEAN_UPGRADE.md) for the exact-geometry roadmap from mesh CSG to STEP-oriented B-Rep and NURBS booleans.

## Getting Started

```bash
npm install
npm run start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

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

Test the parametric 3D modeling system:
```bash
npm run test:parametric
```

This demonstrates:
- Creating sketches and adding them as features
- Extruding and revolving sketches  
- Modifying features and triggering automatic recalculation
- Feature suppression and dependency tracking
- Serialization and deserialization

## Parametric Modeling Example

```javascript
import { Part, Sketch } from './js/cad/index.js';

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
