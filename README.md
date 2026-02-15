# DXF Modeller

A browser-based 2D CAD modeller built with vanilla JavaScript and HTML5 Canvas. Supports drawing, editing, and exporting geometry in DXF format.

## Features

- **Drawing Tools** — Line, Rectangle, Circle, Arc, Polyline, Text, Dimension
- **Editing Tools** — Select, Move, Copy
- **Snap System** — Endpoint, Midpoint, Center, Quadrant, Grid snapping
- **DXF Import/Export** — Read and write AutoCAD DXF R2000 ASCII files
- **Layers** — Multiple layers with color, visibility, and lock control
- **Undo/Redo** — Full history support
- **Persistent State** — Project auto-saves to localStorage across page refreshes
- **Responsive UI** — Adapts to different screen sizes with touch support

## Architecture

The project now features a modular architecture with three main design interfaces:

- **Sketch** — 2D drawing interface for creating parametric geometry with constraints
- **Part** — (Stub) Future support for 3D part modeling with extrude, revolve, and other operations
- **Assembly** — (Stub) Future support for multi-part assemblies with constraints and BOM

## Getting Started

```bash
npm install
npm run start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## Author

J.Vovk <jozo132@gmail.com>

## License

[MIT](LICENSE)
