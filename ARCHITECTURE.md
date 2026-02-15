# Architecture Documentation

## Overview

This document describes the modular architecture with parametric 3D CAD capabilities.

## Design Hierarchy

The project has three main design interfaces, organized in a hierarchy:

```
Assembly (3D)
  └─ Part (3D) — Now with Parametric Feature Tree
      ├─ FeatureTree — Ordered list of parametric features
      │   ├─ SketchFeature — 2D sketch on a plane
      │   ├─ ExtrudeFeature — Extrude sketch to 3D
      │   ├─ RevolveFeature — Revolve sketch around axis
      │   └─ Future: FilletFeature, ChamferFeature, etc.
      └─ Scene (Internal)
```

## Parametric Feature System

### Feature Tree Architecture

The parametric system is based on a **feature tree** that maintains an ordered list of modeling operations. Each feature:
- Has explicit dependencies on previous features
- Automatically recalculates when modified
- Can be suppressed (temporarily disabled)
- Can be reordered (with dependency validation)

### Core Classes

#### Feature (Base Class)
**Location:** `js/cad/Feature.js`

Abstract base class for all parametric features. Provides:
- **Dependency tracking**: Features declare which other features they depend on
- **Execution**: `execute(context)` method produces geometry
- **State management**: Suppressed, error states
- **Serialization**: Full save/load support

#### FeatureTree
**Location:** `js/cad/FeatureTree.js`

Manages the ordered list of features and handles:
- **Feature execution**: Runs features in dependency order
- **Recursive recalculation**: When a feature changes, all dependent features automatically recalculate
- **Dependency validation**: Ensures features are ordered correctly
- **Feature reordering**: Move features with automatic dependency checking
- **Result caching**: Stores execution results for each feature

**Key Methods:**
```javascript
const tree = new FeatureTree();
tree.addFeature(feature);              // Add feature to tree
tree.removeFeature(featureId);         // Remove feature (checks dependencies)
tree.reorderFeature(featureId, newIndex); // Reorder with validation
tree.markModified(featureId);          // Trigger recalculation from this feature
tree.executeAll();                      // Execute all features
```

### Feature Types

#### SketchFeature
**Location:** `js/cad/SketchFeature.js`

Represents a 2D sketch on a plane. Features:
- Wraps a `Sketch` object with 2D geometry and constraints
- Defines sketch plane in 3D space (origin, normal, axes)
- Extracts closed profiles for use in 3D operations
- No dependencies (base feature)

**Usage:**
```javascript
const sketchFeature = new SketchFeature('MySketch');
sketchFeature.sketch.addSegment(0, 0, 100, 0);
sketchFeature.sketch.addSegment(100, 0, 100, 50);
// ... complete the profile
```

#### ExtrudeFeature
**Location:** `js/cad/ExtrudeFeature.js`

Extrudes a 2D sketch profile to create 3D solid geometry. Features:
- Depends on a SketchFeature
- Configurable distance, direction, and symmetry
- Generates 3D vertices, faces, and edges
- Supports boolean operations (new, add, subtract, intersect)

**Usage:**
```javascript
const extrudeFeature = new ExtrudeFeature('Extrude1', sketchFeatureId, 25);
extrudeFeature.setDistance(50); // Modify and trigger recalculation
```

#### RevolveFeature
**Location:** `js/cad/RevolveFeature.js`

Revolves a 2D sketch profile around an axis to create 3D geometry. Features:
- Depends on a SketchFeature
- Configurable angle (partial or full 360°)
- Configurable revolution axis
- Generates 3D surface with specified segment count

**Usage:**
```javascript
const revolveFeature = new RevolveFeature('Revolve1', sketchFeatureId, Math.PI * 2);
revolveFeature.setAngle(Math.PI); // 180° revolution
revolveFeature.setAxis({x: 0, y: 0}, {x: 0, y: 1}); // Custom axis
```

### Parametric Behavior

#### Automatic Recalculation

When a feature is modified, the system automatically:
1. Marks the feature as modified
2. Recalculates the feature
3. Recalculates all features that depend on it (recursively)
4. Updates the final geometry

**Example:**
```javascript
// Modify a sketch
part.modifyFeature(sketchFeature.id, (feature) => {
  feature.sketch.addSegment(x1, y1, x2, y2);
});
// All operations using this sketch automatically recalculate!
```

#### Dependency Tracking

Features explicitly declare their dependencies:
```javascript
const extrudeFeature = new ExtrudeFeature('Extrude1', sketchFeatureId, 50);
// Automatically adds sketchFeatureId as a dependency
```

The system validates:
- Dependencies exist before adding features
- Reordering doesn't break dependencies
- Features can't be deleted if others depend on them

#### Feature Suppression

Features can be temporarily disabled:
```javascript
feature.suppress();    // Disable feature
feature.unsuppress();  // Re-enable feature
```

Suppressed features:
- Don't execute
- Don't produce geometry
- Allow dependent features to execute if they have fallbacks

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

### Part (3D Part Design with Parametric Features)

**Location:** `js/cad/Part.js`

The `Part` class now fully supports parametric 3D solid modeling with a feature tree:

- **Feature Tree**: Ordered list of parametric features
- **Sketches**: Multiple 2D sketches on different planes
- **3D Operations**:
  - ✅ Extrude - extrude 2D profiles to 3D
  - ✅ Revolve - revolve profiles around an axis
  - ⏳ Fillets, chamfers (future)
  - ⏳ Boolean operations (future)
- **Material Properties**: Density, color, texture
- **Physical Properties**: Mass, volume, center of mass
- **Recursive Recalculation**: Changing any feature automatically updates all dependent features

**Usage:**
```javascript
import { Part } from './js/cad/Part.js';

const part = new Part('MyPart');

// Add a sketch
const sketch = new Sketch();
sketch.addSegment(0, 0, 100, 0);
sketch.addSegment(100, 0, 100, 50);
sketch.addSegment(100, 50, 0, 50);
sketch.addSegment(0, 50, 0, 0);

const sketchFeature = part.addSketch(sketch);

// Extrude the sketch
const extrudeFeature = part.extrude(sketchFeature.id, 25);

// Modify and watch automatic recalculation
part.modifyFeature(extrudeFeature.id, (feature) => {
  feature.setDistance(50);
});

// Get final geometry
const geometry = part.getFinalGeometry();
console.log('Vertices:', geometry.geometry.vertices.length);
console.log('Faces:', geometry.geometry.faces.length);
```

### Assembly (Multi-Part Design - Stub)

**Location:** `js/cad/Assembly.js`

The `Assembly` class supports multi-part assemblies with positioning and constraints. Currently a stub with planned features:

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
- ✅ **Part**: Parametric feature tree with dependency tracking
- ✅ **SketchFeature**: 2D sketches as features
- ✅ **ExtrudeFeature**: Extrude sketches to 3D solids
- ✅ **RevolveFeature**: Revolve sketches around an axis
- ✅ **Recursive Recalculation**: Modifying features triggers automatic updates
- ✅ **Feature Management**: Add, remove, reorder, suppress features
- ✅ **Serialization**: All classes support save/load
- ✅ **Assembly**: Basic structure and component management

### What's Coming:
- ⏳ **More 3D Operations**: Fillet, chamfer, sweep, loft
- ⏳ **Boolean Operations**: Union, subtract, intersect using CSG
- ⏳ **Assembly Constraints**: Mates, alignments
- ⏳ **3D Rendering**: WebGL-based 3D viewport
- ⏳ **Export Formats**: STEP, IGES, STL

## Integration with Existing Code

The new parametric system is **fully backward compatible** with the existing application:

- The `Scene` class remains unchanged and continues to work
- The `Sketch` class wraps `Scene` without modifying it
- All existing tools and features work exactly as before
- No breaking changes to the API

## Testing

Run the parametric system test:
```bash
npm run test:parametric
```

This demonstrates:
- Creating sketches and adding them as features
- Extruding and revolving sketches
- Modifying features and triggering recalculation
- Feature suppression
- Dependency tracking
- Serialization and deserialization

## Migration Path

For future development, the migration path is:

1. **Current**: Application uses `Scene` directly through `state.scene`
2. **Near-term**: Application can optionally use `Part` with `FeatureTree` for 3D modeling
3. **Long-term**: 3D features will use `Part` and `Assembly` with multiple `Sketch` instances

The architecture is designed to be incremental, allowing gradual adoption of new features without disrupting existing functionality.
