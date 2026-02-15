# DXF Modeller

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

### Parametric 3D Part Modeling (New!)
- **Feature Tree** — Industry-standard parametric history tree
- **Sketch + Operation Workflow** — Each modeling step builds on previous features
- **Recursive Recalculation** — Changing lower-level features automatically updates everything
- **Dependency Tracking** — Features declare dependencies; system validates operations
- **Feature Management** — Add, remove, reorder, suppress features with automatic validation
- **3D Operations**:
  - ✅ Extrude — Extrude 2D sketches to create 3D solids
  - ✅ Revolve — Revolve sketches around an axis
  - ⏳ Fillet, Chamfer (coming soon)
  - ⏳ Boolean operations (coming soon)

## Architecture

The project features a modular architecture with three main design interfaces:

- **Sketch** — 2D drawing interface for creating parametric geometry with constraints
- **Part** — Parametric 3D part modeling with feature tree and recursive recalculation
- **Assembly** — (Stub) Future support for multi-part assemblies with constraints and BOM

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed documentation.

## Getting Started

```bash
npm install
npm run start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

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
