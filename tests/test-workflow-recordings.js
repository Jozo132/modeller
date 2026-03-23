// tests/test-workflow-recordings.js — Replay workflow recordings and verify part statistics
//
// Loads JSON recording files from tests/samples/ and replays the commands
// headlessly using the CAD API. Verifies that the final solid matches the
// expected statistics stored in the recording's partStats field.
//
// Also loads .cmod project files from tests/samples/ — deserializes the Part
// from the feature tree and verifies that rebuilt geometry matches the embedded
// metadata.

import assert from 'assert';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { parseCMOD } from '../js/cmod.js';
import { calculateMeshVolume, calculateBoundingBox, calculateSurfaceArea, detectDisconnectedBodies, calculateWallThickness, countInvertedFaces } from '../js/cad/CSG.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, 'samples');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${msg}: expected ~${expected}, got ${actual} (diff: ${Math.abs(actual - expected).toFixed(6)})`);
}

function assertPositiveWallThickness(geometry, context) {
  const wt = calculateWallThickness(geometry);
  assert.ok(wt.minThickness > 0, `${context}: expected min wall thickness > 0, got ${wt.minThickness}`);
  assert.ok(wt.maxThickness > 0, `${context}: expected max wall thickness > 0, got ${wt.maxThickness}`);
}

// ---------------------------------------------------------------------------
// Headless command replay engine
// ---------------------------------------------------------------------------

class HeadlessReplay {
  constructor() {
    this.part = null;
    this.lastSketchFeatureId = null;
    this.scene = { segments: [], circles: [], arcs: [], clear() { this.segments = []; this.circles = []; this.arcs = []; } };
    this.activeTool = 'select';
    this.inSketch = false;
    this.toolClicks = [];
    // Settings state (mirrors app defaults)
    this.settings = {
      fov: 45,
      snapEnabled: true,
      orthoEnabled: false,
      gridVisible: true,
      gridSize: 10,
      constructionMode: false,
      autoCoincidence: true,
    };
  }

  /** Apply initial settings from recording before replaying commands. */
  applyInitialSettings(initialSettings) {
    if (!initialSettings) return;
    for (const key of Object.keys(initialSettings)) {
      if (key in this.settings) {
        this.settings[key] = initialSettings[key];
      }
    }
  }

  run(commands) {
    for (const cmd of commands) {
      this._handleCommand(cmd);
    }
  }

  _processToolClicks() {
    if (this.activeTool === 'rectangle' && this.toolClicks.length === 2) {
      const [p1, p2] = this.toolClicks;
      const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
      this.scene.segments.push({ x1, y1, x2, y2: y1 });
      this.scene.segments.push({ x1: x2, y1, x2, y2 });
      this.scene.segments.push({ x1: x2, y1: y2, x2: x1, y2 });
      this.scene.segments.push({ x1, y1: y2, x2: x1, y2: y1 });
      this.toolClicks = [];
    } else if (this.activeTool === 'line' && this.toolClicks.length === 2) {
      const [p1, p2] = this.toolClicks;
      this.scene.segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      this.toolClicks = [p2]; // line tool chains points
    } else if (this.activeTool === 'circle' && this.toolClicks.length === 2) {
      const [center, edge] = this.toolClicks;
      const dx = edge.x - center.x, dy = edge.y - center.y;
      const radius = Math.sqrt(dx * dx + dy * dy);
      this.scene.circles.push({ cx: center.x, cy: center.y, radius });
      this.toolClicks = [];
    }
  }

  _handleCommand(cmd) {
    if (!cmd) return;
    const raw = cmd.trim().split(/\s+/);
    const command = raw[0].toLowerCase();
    const args = raw.slice(1);

    if (command === 'workspace') {
      if (args[0] === 'part' && !this.part) {
        this.part = new Part('Part1');
      }
      return;
    }

    if (command === 'camera.set' ||
        command === 'select.face' || command === 'deselect.face' ||
        command === 'select.plane' || command === 'select.feature' ||
        command === 'select.edge' || command === 'deselect.edge' ||
        command.startsWith('record.')) {
      // These are UI-only commands with no effect on geometry
      return;
    }

    if (command === 'setting') {
      // Track settings state for potential geometry-affecting settings
      if (args[0] === 'fov' && args[1] != null) this.settings.fov = parseFloat(args[1]);
      else if (args[0] === 'snap') this.settings.snapEnabled = args[1] !== 'false';
      else if (args[0] === 'ortho') this.settings.orthoEnabled = args[1] !== 'false';
      else if (args[0] === 'grid') this.settings.gridVisible = args[1] !== 'false';
      else if (args[0] === 'gridSize' && args[1] != null) this.settings.gridSize = parseFloat(args[1]);
      else if (args[0] === 'construction') this.settings.constructionMode = args[1] !== 'false';
      else if (args[0] === 'autoCoincidence') this.settings.autoCoincidence = args[1] !== 'false';
      return;
    }

    if (command === 'tool') {
      this.activeTool = (args[0] || 'select').toLowerCase();
      this.toolClicks = [];
      return;
    }

    if (command === 'click') {
      if (this.inSketch && args.length >= 2) {
        const cx = parseFloat(args[0]), cy = parseFloat(args[1]);
        this.toolClicks.push({ x: cx, y: cy });
        this._processToolClicks();
      }
      return;
    }

    if (command === 'sketch.start') {
      this.scene.clear();
      this.inSketch = true;
      this.activeTool = 'select';
      this.toolClicks = [];
      return;
    }

    if (command === 'sketch.finish') {
      this.inSketch = false;
      if (!this.part) this.part = new Part('Part1');
      const sketch = new Sketch();
      for (const seg of this.scene.segments) {
        sketch.addSegment(seg.x1, seg.y1, seg.x2, seg.y2);
      }
      for (const c of this.scene.circles) {
        sketch.addCircle(c.cx, c.cy, c.radius);
      }
      const sketchFeature = this.part.addSketch(sketch);
      this.lastSketchFeatureId = sketchFeature.id;
      this.scene.clear();
      return;
    }

    if (command === 'sketch.edit' || command === 'sketch.from-face') {
      return;
    }

    if (command === 'draw.line') {
      if (args.length >= 4) {
        this.scene.segments.push({
          x1: parseFloat(args[0]), y1: parseFloat(args[1]),
          x2: parseFloat(args[2]), y2: parseFloat(args[3]),
        });
      }
      return;
    }

    if (command === 'draw.rect') {
      if (args.length >= 4) {
        const x1 = parseFloat(args[0]), y1 = parseFloat(args[1]);
        const x2 = parseFloat(args[2]), y2 = parseFloat(args[3]);
        this.scene.segments.push({ x1, y1: y1, x2, y2: y1 });
        this.scene.segments.push({ x1: x2, y1: y1, x2, y2 });
        this.scene.segments.push({ x1: x2, y1: y2, x2: x1, y2 });
        this.scene.segments.push({ x1, y1: y2, x2: x1, y2: y1 });
      }
      return;
    }

    if (command === 'draw.circle') {
      if (args.length >= 3) {
        this.scene.circles.push({
          cx: parseFloat(args[0]), cy: parseFloat(args[1]),
          radius: parseFloat(args[2]),
        });
      }
      return;
    }

    if (command === 'extrude') {
      if (args.length >= 1 && this.lastSketchFeatureId && this.part) {
        const dist = parseFloat(args[0]);
        const isCut = args[1] === 'cut';
        const options = isCut ? { operation: 'subtract', direction: -1 } : {};
        if (isCut) {
          this.part.extrudeCut(this.lastSketchFeatureId, Math.abs(dist), options);
        } else {
          this.part.extrude(this.lastSketchFeatureId, Math.abs(dist), options);
        }
      }
      return;
    }

    if (command === 'revolve') {
      if (args.length >= 1 && this.lastSketchFeatureId && this.part) {
        const angleDeg = parseFloat(args[0]);
        this.part.revolve(this.lastSketchFeatureId, (angleDeg * Math.PI) / 180);
      }
      return;
    }

    if (command === 'chamfer') {
      if (args.length >= 2 && this.part) {
        const distance = parseFloat(args[0]);
        const edgeKeys = args.slice(1);
        this.part.chamfer(edgeKeys, distance);
      }
      return;
    }

    if (command === 'fillet') {
      if (args.length >= 3 && this.part) {
        const radius = parseFloat(args[0]);
        const segments = parseInt(args[1], 10);
        const edgeKeys = args.slice(2);
        this.part.fillet(edgeKeys, radius, { segments });
      }
      return;
    }

    if (command === 'feature.modify') {
      if (args.length >= 3 && this.part) {
        const featureId = args[0];
        const paramName = args[1];
        const value = args[2];
        this.part.modifyFeature(featureId, (f) => {
          switch (paramName) {
            case 'distance': f.setDistance(parseFloat(value)); break;
            case 'direction': f.direction = parseInt(value, 10); break;
            case 'operation': f.operation = value; break;
            case 'symmetric': f.symmetric = value === 'true'; break;
            case 'angle': if (typeof f.setAngle === 'function') f.setAngle(parseFloat(value)); break;
            case 'segments': f.segments = parseInt(value, 10); break;
          }
        });
      }
      return;
    }

    // Ignore unknown commands during headless replay
  }
}

// ---------------------------------------------------------------------------
// Load and run all sample recordings
// ---------------------------------------------------------------------------

console.log('\n=== Workflow Recording Tests ===\n');

let sampleFiles;
try {
  sampleFiles = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.json'));
} catch (e) {
  console.log('  No samples directory found — skipping workflow tests');
  sampleFiles = [];
}

for (const file of sampleFiles) {
  const filePath = join(SAMPLES_DIR, file);
  let recording;
  try {
    recording = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    test(`${file}: valid JSON`, () => { throw new Error(`Failed to parse: ${e.message}`); });
    continue;
  }

  const commands = (recording.steps || []).map(s => s.command);
  const expected = recording.partStats;
  if (!expected) {
    test(`${file}: has partStats`, () => { throw new Error('Missing partStats in recording'); });
    continue;
  }

  // Replay commands headlessly
  const replay = new HeadlessReplay();
  replay.applyInitialSettings(recording.initialSettings);
  try {
    replay.run(commands);
  } catch (e) {
    test(`${file}: replay succeeds`, () => { throw new Error(`Replay failed: ${e.message}`); });
    continue;
  }

  const part = replay.part;

  // Validate feature count
  if (expected.featureCount !== undefined) {
    test(`${file}: feature count`, () => {
      assert.strictEqual(part.getFeatures().length, expected.featureCount,
        `Expected ${expected.featureCount} features, got ${part.getFeatures().length}`);
    });
  }

  // Validate feature types
  if (expected.featureTypes) {
    test(`${file}: feature types`, () => {
      const actual = part.getFeatures().map(f => f.type);
      assert.deepStrictEqual(actual, expected.featureTypes,
        `Expected types ${JSON.stringify(expected.featureTypes)}, got ${JSON.stringify(actual)}`);
    });
  }

  // Get final geometry for numeric checks
  const geo = part.getFinalGeometry();
  const geometry = geo && geo.geometry ? geo.geometry : null;

  if (!geometry) {
    test(`${file}: has final geometry`, () => { throw new Error('No final geometry produced'); });
    continue;
  }

  test(`${file}: positive wall thickness`, () => {
    assertPositiveWallThickness(geometry, file);
  });

  // Validate face count
  if (expected.faceCount !== undefined) {
    test(`${file}: face count`, () => {
      assert.strictEqual(geometry.faces.length, expected.faceCount,
        `Expected ${expected.faceCount} faces, got ${geometry.faces.length}`);
    });
  }

  // Validate volume (tolerance: 0.5)
  if (expected.volume !== undefined) {
    test(`${file}: volume`, () => {
      assertApprox(calculateMeshVolume(geometry), expected.volume, 0.5,
        'Volume mismatch');
    });
  }

  // Validate surface area (tolerance: 0.5)
  if (expected.surfaceArea !== undefined) {
    test(`${file}: surface area`, () => {
      assertApprox(calculateSurfaceArea(geometry), expected.surfaceArea, 0.5,
        'Surface area mismatch');
    });
  }

  // Validate bounding box dimensions (tolerance: 0.01)
  const bb = calculateBoundingBox(geometry);
  if (expected.width !== undefined) {
    test(`${file}: width`, () => {
      assertApprox(bb.max.x - bb.min.x, expected.width, 0.01, 'Width mismatch');
    });
  }
  if (expected.height !== undefined) {
    test(`${file}: height`, () => {
      assertApprox(bb.max.y - bb.min.y, expected.height, 0.01, 'Height mismatch');
    });
  }
  if (expected.depth !== undefined) {
    test(`${file}: depth`, () => {
      assertApprox(bb.max.z - bb.min.z, expected.depth, 0.01, 'Depth mismatch');
    });
  }

  // Validate feature edge count
  if (expected.edgeCount !== undefined) {
    test(`${file}: edge count`, () => {
      const actual = (geometry.edges || []).length;
      assert.strictEqual(actual, expected.edgeCount,
        `Expected ${expected.edgeCount} feature edges, got ${actual}`);
    });
  }

  // Validate path count
  if (expected.pathCount !== undefined) {
    test(`${file}: path count`, () => {
      const actual = (geometry.paths || []).length;
      assert.strictEqual(actual, expected.pathCount,
        `Expected ${expected.pathCount} paths, got ${actual}`);
    });
  }

  // Validate disconnected bodies (1 = solid, >1 = problem)
  if (expected.bodyCount !== undefined) {
    test(`${file}: body count`, () => {
      const bodies = detectDisconnectedBodies(geometry);
      assert.strictEqual(bodies.bodyCount, expected.bodyCount,
        `Expected ${expected.bodyCount} connected body(ies), got ${bodies.bodyCount}`);
    });
  }

  // Validate wall thickness
  if (expected.minWallThickness !== undefined) {
    test(`${file}: min wall thickness`, () => {
      const wt = calculateWallThickness(geometry);
      assertApprox(wt.minThickness, expected.minWallThickness, 0.5,
        'Min wall thickness mismatch');
    });
  }
  if (expected.maxWallThickness !== undefined) {
    test(`${file}: max wall thickness`, () => {
      const wt = calculateWallThickness(geometry);
      assertApprox(wt.maxThickness, expected.maxWallThickness, 0.5,
        'Max wall thickness mismatch');
    });
  }

  if (expected.invertedFaceCount !== undefined) {
    test(`${file}: inverted face count`, () => {
      assert.strictEqual(countInvertedFaces(geometry), expected.invertedFaceCount,
        `Expected ${expected.invertedFaceCount} inverted faces, got ${countInvertedFaces(geometry)}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Load and run all .cmod project samples
// ---------------------------------------------------------------------------

console.log('\n--- .cmod Project File Tests ---\n');

let cmodFiles;
try {
  cmodFiles = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.cmod'));
} catch (e) {
  console.log('  No samples directory found — skipping .cmod tests');
  cmodFiles = [];
}

for (const file of cmodFiles) {
  const filePath = join(SAMPLES_DIR, file);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    test(`${file}: readable`, () => { throw new Error(`Failed to read: ${e.message}`); });
    continue;
  }

  // Parse and validate
  const parsed = parseCMOD(raw);
  if (!parsed.ok) {
    test(`${file}: valid .cmod`, () => { throw new Error(parsed.error); });
    continue;
  }

  const cmod = parsed.data;
  const expected = cmod.metadata;
  if (!expected) {
    test(`${file}: has metadata`, () => { throw new Error('Missing metadata in .cmod file'); });
    continue;
  }

  // Deserialize the Part from the feature tree
  let part;
  try {
    part = Part.deserialize(cmod.part);
  } catch (e) {
    test(`${file}: Part deserialize`, () => { throw new Error(`Deserialize failed: ${e.message}`); });
    continue;
  }

  // Validate feature count
  if (expected.featureCount !== undefined) {
    test(`${file}: feature count`, () => {
      assert.strictEqual(part.getFeatures().length, expected.featureCount,
        `Expected ${expected.featureCount} features, got ${part.getFeatures().length}`);
    });
  }

  // Validate feature types
  if (expected.featureTypes) {
    test(`${file}: feature types`, () => {
      const actual = part.getFeatures().map(f => f.type);
      assert.deepStrictEqual(actual, expected.featureTypes,
        `Expected types ${JSON.stringify(expected.featureTypes)}, got ${JSON.stringify(actual)}`);
    });
  }

  // Rebuild geometry from deserialized Part
  const geo = part.getFinalGeometry();
  const geometry = geo && geo.geometry ? geo.geometry : null;

  if (!geometry) {
    test(`${file}: has final geometry`, () => { throw new Error('No final geometry produced after deserialize'); });
    continue;
  }

  test(`${file}: positive wall thickness`, () => {
    assertPositiveWallThickness(geometry, file);
  });

  // Validate face count
  if (expected.faceCount !== undefined) {
    test(`${file}: face count`, () => {
      assert.strictEqual(geometry.faces.length, expected.faceCount,
        `Expected ${expected.faceCount} faces, got ${geometry.faces.length}`);
    });
  }

  // Validate volume (tolerance: 0.5)
  if (expected.volume !== undefined) {
    test(`${file}: volume`, () => {
      assertApprox(calculateMeshVolume(geometry), expected.volume, 0.5, 'Volume mismatch');
    });
  }

  // Validate surface area (tolerance: 0.5)
  if (expected.surfaceArea !== undefined) {
    test(`${file}: surface area`, () => {
      assertApprox(calculateSurfaceArea(geometry), expected.surfaceArea, 0.5, 'Surface area mismatch');
    });
  }

  // Validate bounding box dimensions (tolerance: 0.01)
  const bb = calculateBoundingBox(geometry);
  if (expected.width !== undefined) {
    test(`${file}: width`, () => { assertApprox(bb.max.x - bb.min.x, expected.width, 0.01, 'Width mismatch'); });
  }
  if (expected.height !== undefined) {
    test(`${file}: height`, () => { assertApprox(bb.max.y - bb.min.y, expected.height, 0.01, 'Height mismatch'); });
  }
  if (expected.depth !== undefined) {
    test(`${file}: depth`, () => { assertApprox(bb.max.z - bb.min.z, expected.depth, 0.01, 'Depth mismatch'); });
  }

  // Validate edge count
  if (expected.edgeCount !== undefined) {
    test(`${file}: edge count`, () => {
      const actual = (geometry.edges || []).length;
      assert.strictEqual(actual, expected.edgeCount,
        `Expected ${expected.edgeCount} feature edges, got ${actual}`);
    });
  }

  // Validate path count
  if (expected.pathCount !== undefined) {
    test(`${file}: path count`, () => {
      const actual = (geometry.paths || []).length;
      assert.strictEqual(actual, expected.pathCount,
        `Expected ${expected.pathCount} paths, got ${actual}`);
    });
  }

  // Validate body count
  if (expected.bodyCount !== undefined) {
    test(`${file}: body count`, () => {
      const bodies = detectDisconnectedBodies(geometry);
      assert.strictEqual(bodies.bodyCount, expected.bodyCount,
        `Expected ${expected.bodyCount} connected body(ies), got ${bodies.bodyCount}`);
    });
  }

  // Validate wall thickness
  if (expected.minWallThickness !== undefined) {
    test(`${file}: min wall thickness`, () => {
      const wt = calculateWallThickness(geometry);
      assertApprox(wt.minThickness, expected.minWallThickness, 0.5, 'Min wall thickness mismatch');
    });
  }
  if (expected.maxWallThickness !== undefined) {
    test(`${file}: max wall thickness`, () => {
      const wt = calculateWallThickness(geometry);
      assertApprox(wt.maxThickness, expected.maxWallThickness, 0.5, 'Max wall thickness mismatch');
    });
  }

  if (expected.invertedFaceCount !== undefined) {
    test(`${file}: inverted face count`, () => {
      assert.strictEqual(countInvertedFaces(geometry), expected.invertedFaceCount,
        `Expected ${expected.invertedFaceCount} inverted faces, got ${countInvertedFaces(geometry)}`);
    });
  }
}

console.log(`\nWorkflow Recording Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
