# Architecture Documentation

## Overview

This document describes the new modular architecture introduced to support future 3D CAD capabilities.

## Design Hierarchy

The project now has three main design interfaces, organized in a hierarchy:

```
Assembly (3D)
  └─ Part (3D)
      └─ Sketch (2D)
          └─ Scene (Internal)
```

### Sketch (2D Drawing Interface)

**Location:** `js/cad/Sketch.js`

The `Sketch` class represents a 2D drawing plane with geometric primitives and constraints. It wraps the existing `Scene` class and provides:

- **Metadata**: Name, description, created/modified timestamps
- **2D Geometry**: Points, segments, circles, arcs
- **Constraints**: Parametric relationships between geometry
- **Serialization**: Full save/load support

**Usage:**
```javascript
import { Sketch } from './js/cad/Sketch.js';

const sketch = new Sketch();
sketch.name = 'MySketch';
sketch.addSegment(0, 0, 100, 0);
sketch.addCircle(50, 50, 25);

// Serialize for storage
const data = sketch.serialize();

// Restore from data
const restored = Sketch.deserialize(data);
```

### Part (3D Part Design - Stub)

**Location:** `js/cad/Part.js`

The `Part` class will eventually support 3D solid modeling built from 2D sketches. Currently a stub with planned features:

- **Multiple Sketches**: Collection of 2D sketches on different planes
- **3D Operations** (future):
  - Extrude, revolve, sweep, loft
  - Fillets, chamfers, shells
  - Boolean operations (union, subtract, intersect)
- **Material Properties** (future): Density, color, texture
- **Physical Properties** (future): Mass, volume, center of mass

**Usage (future):**
```javascript
import { Part } from './js/cad/Part.js';

const part = new Part('MyPart');
const sketch = new Sketch();
// ... add geometry to sketch ...
part.addSketch(sketch);
part.extrude(sketch, 50); // Future implementation
```

### Assembly (Multi-Part Design - Stub)

**Location:** `js/cad/Assembly.js`

The `Assembly` class will eventually support multi-part assemblies with positioning and constraints. Currently a stub with planned features:

- **Component Management**: Parts and sub-assemblies with transforms
- **Assembly Constraints** (future):
  - Mate, align, tangent constraints
  - Distance, angle constraints
- **Visualization** (future):
  - Exploded views
  - Section views
- **BOM** (future): Bill of materials generation
- **Analysis** (future): Interference detection, motion simulation

**Usage (future):**
```javascript
import { Assembly } from './js/cad/Assembly.js';

const assembly = new Assembly('MyAssembly');
const part1 = new Part('Bracket');
const part2 = new Part('Bolt');

const comp1 = assembly.addComponent(part1);
const comp2 = assembly.addComponent(part2, {
  position: { x: 100, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 }
});

assembly.addMate(comp1, comp2, 'coincident'); // Future implementation
```

## Current State

### What Works Now:
- ✅ **Sketch**: Fully functional 2D drawing interface
- ✅ **Part**: Basic structure and sketch management
- ✅ **Assembly**: Basic structure and component management
- ✅ **Serialization**: All classes support save/load

### What's Coming:
- ⏳ **3D Operations**: Extrude, revolve, fillet, etc.
- ⏳ **Assembly Constraints**: Mates, alignments
- ⏳ **3D Rendering**: WebGL-based 3D viewport
- ⏳ **Export Formats**: STEP, IGES, STL

## Integration with Existing Code

The new classes are **fully backward compatible** with the existing application:

- The `Scene` class remains unchanged and continues to work
- The `Sketch` class wraps `Scene` without modifying it
- All existing tools and features work exactly as before
- No breaking changes to the API

## Migration Path

For future development, the migration path is:

1. **Current**: Application uses `Scene` directly through `state.scene`
2. **Future**: Application can optionally use `Sketch` for enhanced features
3. **Long-term**: 3D features will use `Part` and `Assembly` with multiple `Sketch` instances

The architecture is designed to be incremental, allowing gradual adoption of new features without disrupting existing functionality.
