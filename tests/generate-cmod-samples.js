// tests/generate-cmod-samples.js — Generate .cmod sample files from JSON workflow recordings
//
// Replays each JSON recording headlessly, builds the Part, then exports
// as a .cmod file using buildCMOD(). Run with:
//   node tests/generate-cmod-samples.js

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { buildCMOD } from '../js/cmod.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, 'samples');

// ---------------------------------------------------------------------------
// Headless command replay engine (same as test-workflow-recordings.js)
// ---------------------------------------------------------------------------

class HeadlessReplay {
  constructor() {
    this.part = null;
    this.lastSketchFeatureId = null;
    this.scene = { segments: [], circles: [], arcs: [], clear() { this.segments = []; this.circles = []; this.arcs = []; } };
    this.activeTool = 'select';
    this.inSketch = false;
    this.toolClicks = [];
    this.settings = {
      fov: 45, snapEnabled: true, orthoEnabled: false,
      gridVisible: true, gridSize: 10, constructionMode: false, autoCoincidence: true,
    };
    this.orbit = null;
  }

  applyInitialSettings(initialSettings) {
    if (!initialSettings) return;
    for (const key of Object.keys(initialSettings)) {
      if (key in this.settings) this.settings[key] = initialSettings[key];
    }
  }

  run(commands) {
    for (const cmd of commands) this._handleCommand(cmd);
  }

  _processToolClicks() {
    if (this.activeTool === 'rectangle' && this.toolClicks.length === 2) {
      const [p1, p2] = this.toolClicks;
      this.scene.segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p1.y });
      this.scene.segments.push({ x1: p2.x, y1: p1.y, x2: p2.x, y2: p2.y });
      this.scene.segments.push({ x1: p2.x, y1: p2.y, x2: p1.x, y2: p2.y });
      this.scene.segments.push({ x1: p1.x, y1: p2.y, x2: p1.x, y2: p1.y });
      this.toolClicks = [];
    } else if (this.activeTool === 'line' && this.toolClicks.length === 2) {
      const [p1, p2] = this.toolClicks;
      this.scene.segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      this.toolClicks = [p2];
    } else if (this.activeTool === 'circle' && this.toolClicks.length === 2) {
      const [center, edge] = this.toolClicks;
      const dx = edge.x - center.x, dy = edge.y - center.y;
      this.scene.circles.push({ cx: center.x, cy: center.y, radius: Math.sqrt(dx * dx + dy * dy) });
      this.toolClicks = [];
    }
  }

  _handleCommand(cmd) {
    if (!cmd) return;
    const raw = cmd.trim().split(/\s+/);
    const command = raw[0].toLowerCase();
    const args = raw.slice(1);

    if (command === 'workspace') {
      if (args[0] === 'part' && !this.part) this.part = new Part('Part1');
      return;
    }

    if (command === 'camera.set') {
      if (args.length >= 6) {
        this.orbit = {
          theta: parseFloat(args[0]), phi: parseFloat(args[1]),
          radius: parseFloat(args[2]),
          target: { x: parseFloat(args[3]), y: parseFloat(args[4]), z: parseFloat(args[5]) },
        };
      }
      return;
    }

    if (command === 'select.face' || command === 'deselect.face' ||
        command === 'select.plane' || command === 'select.feature' ||
        command === 'select.edge' || command === 'deselect.edge' ||
        command.startsWith('record.')) {
      return;
    }

    if (command === 'setting') {
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
        this.toolClicks.push({ x: parseFloat(args[0]), y: parseFloat(args[1]) });
        this._processToolClicks();
      }
      return;
    }

    if (command === 'sketch.start') { this.scene.clear(); this.inSketch = true; this.activeTool = 'select'; this.toolClicks = []; return; }

    if (command === 'sketch.finish') {
      this.inSketch = false;
      if (!this.part) this.part = new Part('Part1');
      const sketch = new Sketch();
      for (const seg of this.scene.segments) sketch.addSegment(seg.x1, seg.y1, seg.x2, seg.y2);
      for (const c of this.scene.circles) sketch.addCircle(c.cx, c.cy, c.radius);
      const sf = this.part.addSketch(sketch);
      this.lastSketchFeatureId = sf.id;
      this.scene.clear();
      return;
    }

    if (command === 'sketch.edit' || command === 'sketch.from-face') return;

    if (command === 'draw.line') {
      if (args.length >= 4) this.scene.segments.push({ x1: parseFloat(args[0]), y1: parseFloat(args[1]), x2: parseFloat(args[2]), y2: parseFloat(args[3]) });
      return;
    }

    if (command === 'draw.rect') {
      if (args.length >= 4) {
        const x1 = parseFloat(args[0]), y1 = parseFloat(args[1]), x2 = parseFloat(args[2]), y2 = parseFloat(args[3]);
        this.scene.segments.push({ x1, y1, x2, y2: y1 }, { x1: x2, y1, x2, y2 }, { x1: x2, y1: y2, x2: x1, y2 }, { x1, y1: y2, x2: x1, y2: y1 });
      }
      return;
    }

    if (command === 'draw.circle') {
      if (args.length >= 3) this.scene.circles.push({ cx: parseFloat(args[0]), cy: parseFloat(args[1]), radius: parseFloat(args[2]) });
      return;
    }

    if (command === 'extrude') {
      if (args.length >= 1 && this.lastSketchFeatureId && this.part) {
        const dist = parseFloat(args[0]);
        const isCut = args[1] === 'cut';
        if (isCut) this.part.extrudeCut(this.lastSketchFeatureId, Math.abs(dist), { operation: 'subtract', direction: -1 });
        else this.part.extrude(this.lastSketchFeatureId, Math.abs(dist));
      }
      return;
    }

    if (command === 'revolve') {
      if (args.length >= 1 && this.lastSketchFeatureId && this.part)
        this.part.revolve(this.lastSketchFeatureId, (parseFloat(args[0]) * Math.PI) / 180);
      return;
    }

    if (command === 'chamfer') {
      if (args.length >= 2 && this.part) this.part.chamfer(args.slice(1), parseFloat(args[0]));
      return;
    }

    if (command === 'fillet') {
      if (args.length >= 3 && this.part) this.part.fillet(args.slice(2), parseFloat(args[0]), { segments: parseInt(args[1], 10) });
      return;
    }

    if (command === 'feature.modify') {
      if (args.length >= 3 && this.part) {
        this.part.modifyFeature(args[0], (f) => {
          switch (args[1]) {
            case 'distance': f.setDistance(parseFloat(args[2])); break;
            case 'direction': f.direction = parseInt(args[2], 10); break;
            case 'operation': f.operation = args[2]; break;
            case 'symmetric': f.symmetric = args[2] === 'true'; break;
            case 'angle': if (typeof f.setAngle === 'function') f.setAngle(parseFloat(args[2])); break;
            case 'segments': f.segments = parseInt(args[2], 10); break;
          }
        });
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Generate .cmod for each JSON recording
// ---------------------------------------------------------------------------

console.log('\n=== Generating .cmod samples from JSON recordings ===\n');

const jsonFiles = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.json'));
let generated = 0;

for (const file of jsonFiles) {
  const filePath = join(SAMPLES_DIR, file);
  let recording;
  try {
    recording = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.log(`  ✗ ${file}: failed to parse JSON — ${e.message}`);
    continue;
  }

  const commands = (recording.steps || []).map(s => s.command);
  if (!commands.length) {
    console.log(`  ✗ ${file}: no steps found`);
    continue;
  }

  // Replay commands
  const replay = new HeadlessReplay();
  replay.applyInitialSettings(recording.initialSettings);
  try {
    replay.run(commands);
  } catch (e) {
    console.log(`  ✗ ${file}: replay failed — ${e.message}`);
    continue;
  }

  if (!replay.part) {
    console.log(`  ✗ ${file}: no Part produced`);
    continue;
  }

  // Build .cmod with settings and orbit from the recording
  const cmod = buildCMOD(replay.part, {
    orbit: replay.orbit,
    settings: replay.settings,
  });

  // Attach the original recording's description
  if (recording.description) {
    cmod.metadata.description = recording.description;
  }

  // Write .cmod file
  const cmodName = basename(file, '.json') + '.cmod';
  const cmodPath = join(SAMPLES_DIR, cmodName);
  writeFileSync(cmodPath, JSON.stringify(cmod, null, 2), 'utf-8');
  console.log(`  ✓ ${cmodName} (${replay.part.getFeatures().length} features, ${cmod.metadata.faceCount || '?'} faces)`);
  generated++;
}

console.log(`\nGenerated ${generated} .cmod files from ${jsonFiles.length} JSON recordings.\n`);
