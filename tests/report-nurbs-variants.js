/**
 * tests/report-nurbs-variants.js
 *
 * Professional PDF test report generator for the NURBS fillet/chamfer variant
 * test suite. Renders before/after 3D views of each test case using the
 * existing headless SceneRenderer pipeline. Produces a publication-quality
 * report with:
 *
 *   - Cover page with metadata
 *   - Each test: description, before/after images, selected edge highlight,
 *     triangle-mesh overlay, normal-color shading, hatched flipped faces,
 *     purple boundary-edge (hole) markers
 *   - Manifold/winding/boundary stats per test
 *   - Volume before/after/error metrics
 *   - Summary table
 *   - Per-test composite PNG images for easy standalone presentation
 *
 * Usage:
 *   node tests/report-nurbs-variants.js [--output path/to/report.pdf] [--no-images]
 *
 * Output is git-ignored (tests/reports/)
 */

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { calculateMeshVolume } from '../js/cad/CSG.js';
import { applyBRepChamfer } from '../js/cad/BRepChamfer.js';
import { applyBRepFillet } from '../js/cad/BRepFillet.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';
import { buildMeshRenderData, computeFitViewState, computeOrbitMvp } from '../js/render/part-render-core.js';
import { renderBaseMeshOverlay } from '../js/render/mesh-overlay-renderer.js';
import { CanvasCommandExecutor } from '../js/render/canvas-command-executor.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CELL_W = 280;
const CELL_H = 210;
const PAGE_W = 595.28;   // A4
const PAGE_H = 841.89;
const MARGIN = 40;
const IMG_GAP = 8;

// Colors
const COLOR_HEADER_BG = '#1a2744';
const COLOR_HEADER_TEXT = '#ffffff';
const COLOR_PASS = '#22863a';
const COLOR_FAIL = '#cb2431';
const COLOR_KNOWN = '#e36209';
const COLOR_WARN = '#d4a017';

// ---------------------------------------------------------------------------
// Geometry helpers (duplicated from test file for independence)
// ---------------------------------------------------------------------------

const PREC = 5;
const VERTEX_ZERO_THRESHOLD = 5e-6;
const fmt = (n) => (Math.abs(n) < VERTEX_ZERO_THRESHOLD ? 0 : n).toFixed(PREC);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;

function checkManifold(geometry) {
  const edgeMap = new Map();
  for (let fi = 0; fi < geometry.faces.length; fi++) {
    const verts = geometry.faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = vk(a), kb = vk(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const fwd = ka < kb;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fi, fwd });
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, windingErrors = 0;
  for (const [, entries] of edgeMap) {
    if (entries.length === 1) boundaryEdges++;
    else if (entries.length === 2) { if (entries[0].fwd === entries[1].fwd) windingErrors++; }
    else nonManifoldEdges++;
  }
  return { boundaryEdges, nonManifoldEdges, windingErrors, totalEdges: edgeMap.size };
}

function countBoundaryEdges(body) {
  if (!body?.shells?.[0]?.faces) return -1;
  const edgeRefs = new Map();
  for (const face of body.shells[0].faces) {
    for (const coedge of face.outerLoop.coedges) {
      edgeRefs.set(coedge.edge.id, (edgeRefs.get(coedge.edge.id) || 0) + 1);
    }
  }
  let count = 0;
  for (const c of edgeRefs.values()) { if (c < 2) count++; }
  return count;
}

function makePlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

function buildPart(sketchSetup, extrudeHeight = 8) {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = new Sketch();
  sketchSetup(sketch);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, extrudeHeight);
  return part;
}

function getGeom(part) {
  const extrude = part.featureTree.features.find(f => f.type === 'extrude');
  return extrude.result.geometry;
}

function findTopoEdge(topo, predicate) {
  const allEdges = [];
  for (const face of topo.faces()) {
    for (const coedge of face.outerLoop.coedges) {
      allEdges.push(coedge.edge);
    }
  }
  return allEdges.find(predicate);
}

function findTopEdge(topo, height, filterFn) {
  return findTopoEdge(topo, (e) => {
    const s = e.startVertex.point, end = e.endVertex.point;
    if (Math.abs(s.z - height) > 0.1 || Math.abs(end.z - height) > 0.1) return false;
    return filterFn ? filterFn(s, end) : true;
  });
}

function findBottomEdge(topo, filterFn) {
  return findTopEdge(topo, 0, filterFn);
}

function findVerticalEdge(topo, filterFn) {
  return findTopoEdge(topo, (e) => {
    const s = e.startVertex.point, end = e.endVertex.point;
    const dz = Math.abs(s.z - end.z);
    if (dz < 1.0) return false;
    return filterFn ? filterFn(s, end) : true;
  });
}

const EdgeSelectors = {
  topHorizontal: (topo, height) => findTopEdge(topo, height, (s, e) => Math.abs(s.x - e.x) > 1.0),
  bottomHorizontal: (topo) => findBottomEdge(topo, (s, e) => Math.abs(s.x - e.x) > 1.0),
  vertical: (topo) => findVerticalEdge(topo),
  bsplineTop: (topo, height) => findTopoEdge(topo, (e) => {
    const s = e.startVertex.point, end = e.endVertex.point;
    return Math.abs(s.z - height) < 0.1 && Math.abs(end.z - height) < 0.1;
  }),
};

// ---------------------------------------------------------------------------
// Profile factories
// ---------------------------------------------------------------------------

function rectangleProfile(w = 20, h = 10) {
  return (sketch) => {
    sketch.addSegment(0, 0, w, 0);
    sketch.addSegment(w, 0, w, h);
    sketch.addSegment(w, h, 0, h);
    sketch.addSegment(0, h, 0, 0);
  };
}

function trapezoidProfile(bottomW = 20, topW = 10, h = 10) {
  const inset = (bottomW - topW) / 2;
  return (sketch) => {
    sketch.addSegment(0, 0, bottomW, 0);
    sketch.addSegment(bottomW, 0, bottomW - inset, h);
    sketch.addSegment(bottomW - inset, h, inset, h);
    sketch.addSegment(inset, h, 0, 0);
  };
}

function parallelogramProfile(w = 20, h = 10, shear = 5) {
  return (sketch) => {
    sketch.addSegment(0, 0, w, 0);
    sketch.addSegment(w, 0, w + shear, h);
    sketch.addSegment(w + shear, h, shear, h);
    sketch.addSegment(shear, h, 0, 0);
  };
}

function mixedSplineProfile(w = 10, h = 10) {
  return (sketch) => {
    sketch.addSegment(0, 0, w, 0);
    sketch.addSegment(w, 0, w, h);
    sketch.addSpline([
      { x: w, y: h },
      { x: w * 0.7, y: h + 4 },
      { x: w * 0.3, y: h + 4 },
      { x: 0, y: h },
    ]);
    sketch.addSegment(0, h, 0, 0);
  };
}

function lensSplineProfile() {
  return (sketch) => {
    sketch.addSpline([
      { x: 0, y: 0 },
      { x: 3, y: 5 },
      { x: 7, y: 5 },
      { x: 10, y: 0 },
    ]);
    sketch.addSpline([
      { x: 10, y: 0 },
      { x: 7, y: -5 },
      { x: 3, y: -5 },
      { x: 0, y: 0 },
    ]);
  };
}

function mixedBezierProfile(w = 10, h = 10) {
  return (sketch) => {
    sketch.addSegment(0, 0, w, 0);
    sketch.addSegment(w, 0, w, h);
    sketch.addBezier([
      { x: w, y: h, handleOut: { dx: -2, dy: 5 } },
      { x: 0, y: h, handleIn: { dx: 2, dy: 5 } },
    ]);
    sketch.addSegment(0, h, 0, 0);
  };
}

function triangleProfile(base = 20, h = 17.32) {
  return (sketch) => {
    sketch.addSegment(0, 0, base, 0);
    sketch.addSegment(base, 0, base / 2, h);
    sketch.addSegment(base / 2, h, 0, 0);
  };
}

function pentagonProfile(r = 10) {
  return (sketch) => {
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const angle = (2 * Math.PI * i) / 5 - Math.PI / 2;
      pts.push({ x: r * Math.cos(angle) + r, y: r * Math.sin(angle) + r });
    }
    for (let i = 0; i < 5; i++) {
      const a = pts[i], b = pts[(i + 1) % 5];
      sketch.addSegment(a.x, a.y, b.x, b.y);
    }
  };
}

// ---------------------------------------------------------------------------
// Concave profile factories
// ---------------------------------------------------------------------------

function lShapeProfile(totalW = 30, totalH = 20, armW = 10, legH = 10) {
  return (sketch) => {
    sketch.addSegment(0, 0, totalW, 0);
    sketch.addSegment(totalW, 0, totalW, legH);
    sketch.addSegment(totalW, legH, armW, legH);
    sketch.addSegment(armW, legH, armW, totalH);
    sketch.addSegment(armW, totalH, 0, totalH);
    sketch.addSegment(0, totalH, 0, 0);
  };
}

function uShapeProfile(outerW = 30, outerH = 20, wallThick = 8, channelH = 12) {
  const innerLeft = wallThick;
  const innerRight = outerW - wallThick;
  const innerBottom = outerH - channelH;
  return (sketch) => {
    sketch.addSegment(0, 0, outerW, 0);
    sketch.addSegment(outerW, 0, outerW, outerH);
    sketch.addSegment(outerW, outerH, innerRight, outerH);
    sketch.addSegment(innerRight, outerH, innerRight, innerBottom);
    sketch.addSegment(innerRight, innerBottom, innerLeft, innerBottom);
    sketch.addSegment(innerLeft, innerBottom, innerLeft, outerH);
    sketch.addSegment(innerLeft, outerH, 0, outerH);
    sketch.addSegment(0, outerH, 0, 0);
  };
}

function tShapeProfileFull(crossW = 30, crossH = 8, stemW = 10, stemH = 15) {
  const stemLeft = (crossW - stemW) / 2;
  const stemRight = stemLeft + stemW;
  return (sketch) => {
    sketch.addSegment(stemLeft, 0, stemRight, 0);
    sketch.addSegment(stemRight, 0, stemRight, stemH);
    sketch.addSegment(stemRight, stemH, crossW, stemH);
    sketch.addSegment(crossW, stemH, crossW, stemH + crossH);
    sketch.addSegment(crossW, stemH + crossH, 0, stemH + crossH);
    sketch.addSegment(0, stemH + crossH, 0, stemH);
    sketch.addSegment(0, stemH, stemLeft, stemH);
    sketch.addSegment(stemLeft, stemH, stemLeft, 0);
  };
}

function crossShapeProfile(armLen = 8, armW = 8) {
  const half = armW / 2;
  const outer = armLen + half;
  return (sketch) => {
    sketch.addSegment(-half, -outer, half, -outer);
    sketch.addSegment(half, -outer, half, -half);
    sketch.addSegment(half, -half, outer, -half);
    sketch.addSegment(outer, -half, outer, half);
    sketch.addSegment(outer, half, half, half);
    sketch.addSegment(half, half, half, outer);
    sketch.addSegment(half, outer, -half, outer);
    sketch.addSegment(-half, outer, -half, half);
    sketch.addSegment(-half, half, -outer, half);
    sketch.addSegment(-outer, half, -outer, -half);
    sketch.addSegment(-outer, -half, -half, -half);
    sketch.addSegment(-half, -half, -half, -outer);
  };
}

function notchedRectProfile(w = 20, h = 15, notchW = 8, notchH = 6) {
  const nl = (w - notchW) / 2;
  const nr = nl + notchW;
  return (sketch) => {
    sketch.addSegment(0, 0, nl, 0);
    sketch.addSegment(nl, 0, nl, notchH);
    sketch.addSegment(nl, notchH, nr, notchH);
    sketch.addSegment(nr, notchH, nr, 0);
    sketch.addSegment(nr, 0, w, 0);
    sketch.addSegment(w, 0, w, h);
    sketch.addSegment(w, h, 0, h);
    sketch.addSegment(0, h, 0, 0);
  };
}

function steppedProfile(stepW = 8, stepH = 5, steps = 3) {
  return (sketch) => {
    const totalW = stepW * steps;
    const totalH = stepH * steps;
    sketch.addSegment(0, 0, totalW, 0);
    sketch.addSegment(totalW, 0, totalW, totalH);
    for (let i = steps - 1; i >= 0; i--) {
      const x = stepW * (i + 1), y = stepH * (i + 1);
      const xPrev = stepW * i, yPrev = stepH * i;
      sketch.addSegment(x, y, xPrev, y);
      if (i > 0) sketch.addSegment(xPrev, y, xPrev, yPrev);
    }
    sketch.addSegment(0, stepH, 0, 0);
  };
}

// ---------------------------------------------------------------------------
// Concave edge selection helpers
// ---------------------------------------------------------------------------

function findVerticalEdgeAt(topo, x, y) {
  let bestEdge = null, bestDist = Infinity;
  for (const face of topo.faces()) {
    for (const coedge of face.outerLoop.coedges) {
      const e = coedge.edge;
      const s = e.startVertex.point, end = e.endVertex.point;
      if (Math.abs(s.z - end.z) < 1.0) continue;
      const mx = (s.x + end.x) / 2, my = (s.y + end.y) / 2;
      const dist = Math.sqrt((mx - x) ** 2 + (my - y) ** 2);
      if (dist < bestDist) { bestDist = dist; bestEdge = e; }
    }
  }
  return bestEdge;
}

function findInnerCornerEdge(topo, height, innerX, innerY) {
  let bestEdge = null, bestDist = Infinity;
  for (const face of topo.faces()) {
    for (const coedge of face.outerLoop.coedges) {
      const e = coedge.edge;
      const s = e.startVertex.point, end = e.endVertex.point;
      if (Math.abs(s.z - height) > 0.1 || Math.abs(end.z - height) > 0.1) continue;
      const mx = (s.x + end.x) / 2, my = (s.y + end.y) / 2;
      const dist = Math.sqrt((mx - innerX) ** 2 + (my - innerY) ** 2);
      if (dist < bestDist) { bestDist = dist; bestEdge = e; }
    }
  }
  return bestEdge;
}

function findAllTopEdges(topo, height) {
  const seen = new Set(), edges = [];
  for (const face of topo.faces()) {
    for (const coedge of face.outerLoop.coedges) {
      const e = coedge.edge;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const s = e.startVertex.point, end = e.endVertex.point;
      if (Math.abs(s.z - height) < 0.1 && Math.abs(end.z - height) < 0.1) edges.push(e);
    }
  }
  return edges;
}

function findAllVerticalEdges(topo) {
  const seen = new Set(), edges = [];
  for (const face of topo.faces()) {
    for (const coedge of face.outerLoop.coedges) {
      const e = coedge.edge;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const s = e.startVertex.point, end = e.endVertex.point;
      if (Math.abs(s.z - end.z) > 1.0) edges.push(e);
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Headless rendering — async render helpers are below variant definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Variant definitions (match test-nurbs-fillet-chamfer-variants.js)
// ---------------------------------------------------------------------------

function buildSingleOpVariants() {
  const variants = [];

  // PLANE+PLANE: Rectangle
  for (const [edgeSel, edgeDesc] of [['topHorizontal', 'top'], ['bottomHorizontal', 'bottom'], ['vertical', 'vertical']]) {
    for (const [op, param] of [['chamfer', 1.0], ['fillet', 1.0]]) {
      variants.push({
        name: `Rectangle ${op} on ${edgeDesc} edge (PLANE+PLANE, 90°)`,
        profile: rectangleProfile(20, 10), extrudeHeight: 10,
        edgeSelector: edgeSel, operation: op, param,
        surfacePairing: 'PLANE+PLANE',
      });
    }
  }

  // Trapezoid
  for (const [op, param] of [['chamfer', 1.0], ['fillet', 1.0]]) {
    variants.push({
      name: `Trapezoid ${op} on top edge (PLANE+PLANE, ~70°)`,
      profile: trapezoidProfile(20, 10, 10), extrudeHeight: 8,
      edgeSelector: 'topHorizontal', operation: op, param,
      surfacePairing: 'PLANE+PLANE non-orthogonal',
    });
    variants.push({
      name: `Trapezoid ${op} on bottom edge (PLANE+PLANE, ~70°)`,
      profile: trapezoidProfile(20, 10, 10), extrudeHeight: 8,
      edgeSelector: 'bottomHorizontal', operation: op, param,
      surfacePairing: 'PLANE+PLANE non-orthogonal',
    });
    variants.push({
      name: `Trapezoid ${op} on vertical/slanted edge (PLANE+PLANE, ~110°)`,
      profile: trapezoidProfile(20, 10, 10), extrudeHeight: 8,
      edgeSelector: 'vertical', operation: op, param,
      surfacePairing: 'PLANE+PLANE slanted',
    });
  }

  // Parallelogram
  for (const [op, param] of [['chamfer', 1.0], ['fillet', 1.0]]) {
    variants.push({
      name: `Parallelogram ${op} on top edge (~63°/~117°)`,
      profile: parallelogramProfile(20, 10, 5), extrudeHeight: 8,
      edgeSelector: 'topHorizontal', operation: op, param,
      surfacePairing: 'PLANE+PLANE acute',
    });
  }

  // Triangle
  for (const [op, param] of [['chamfer', 1.0], ['fillet', 1.0]]) {
    variants.push({
      name: `Triangle ${op} on bottom edge (~60°)`,
      profile: triangleProfile(20, 17.32), extrudeHeight: 8,
      edgeSelector: 'bottomHorizontal', operation: op, param,
      surfacePairing: 'PLANE+PLANE 60°',
    });
  }

  // Pentagon
  for (const [op, param] of [['chamfer', 0.5], ['fillet', 0.5]]) {
    variants.push({
      name: `Pentagon ${op} on top edge (108° interior)`,
      profile: pentagonProfile(10), extrudeHeight: 6,
      edgeSelector: 'topHorizontal', operation: op, param,
      surfacePairing: 'PLANE+PLANE 108°',
    });
  }

  // Mixed spline
  for (const [edgeSel, edgeDesc] of [['topHorizontal', 'bottom-straight'], ['vertical', 'vertical-junction']]) {
    for (const [op, param] of [['chamfer', 0.5], ['fillet', 0.5]]) {
      variants.push({
        name: `Mixed-spline ${op} on ${edgeDesc} (PLANE+BSPLINE)`,
        profile: mixedSplineProfile(10, 10), extrudeHeight: 5,
        edgeSelector: edgeSel, operation: op, param,
        surfacePairing: 'PLANE+BSPLINE',
      });
    }
  }

  // Lens (known)
  for (const [op, param] of [['chamfer', 0.3], ['fillet', 0.3]]) {
    variants.push({
      name: `Lens ${op} on vertical edge (BSPLINE+BSPLINE)`,
      profile: lensSplineProfile(), extrudeHeight: 5,
      edgeSelector: 'vertical', operation: op, param,
      surfacePairing: 'BSPLINE+BSPLINE', knownEdgeCase: true,
    });
  }

  // Mixed bezier
  for (const [edgeSel, edgeDesc, known] of [['bottomHorizontal', 'bottom-straight', true], ['vertical', 'vertical-junction', false]]) {
    for (const [op, param] of [['chamfer', 0.5], ['fillet', 0.5]]) {
      variants.push({
        name: `Mixed-bezier ${op} on ${edgeDesc} (PLANE+BSPLINE)`,
        profile: mixedBezierProfile(10, 10), extrudeHeight: 5,
        edgeSelector: edgeSel, operation: op, param,
        surfacePairing: 'PLANE+BSPLINE (bezier)', knownEdgeCase: known,
      });
    }
  }

  // Parametric sweep — rectangle at multiple sizes
  for (const size of [0.25, 0.5, 1.0, 2.0, 3.0, 4.0]) {
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `Rectangle ${op} size=${size} on top edge`,
        profile: rectangleProfile(20, 10), extrudeHeight: 10,
        edgeSelector: 'topHorizontal', operation: op, param: size,
        surfacePairing: 'PLANE+PLANE',
      });
    }
  }

  // Parametric sweep — trapezoid at multiple sizes
  for (const size of [0.25, 0.5, 1.0, 2.0]) {
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `Trapezoid ${op} size=${size} on top edge (~70°)`,
        profile: trapezoidProfile(20, 10, 10), extrudeHeight: 8,
        edgeSelector: 'topHorizontal', operation: op, param: size,
        surfacePairing: 'PLANE+PLANE non-orthogonal',
      });
    }
  }

  // Parametric sweep — mixed-spline at multiple sizes
  for (const size of [0.25, 0.5, 1.0]) {
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `Mixed-spline ${op} size=${size} on vertical-junction`,
        profile: mixedSplineProfile(10, 10), extrudeHeight: 5,
        edgeSelector: 'vertical', operation: op, param: size,
        surfacePairing: 'PLANE+BSPLINE',
      });
    }
  }

  // Orientation variants
  const ORIENT_BASE_W = 20;
  const ORIENT_HEIGHT = 10;
  for (const [angle, desc] of [[60, '60°'], [120, '120°']]) {
    const radians = (angle * Math.PI) / 180;
    const topW = ORIENT_BASE_W - 2 * ORIENT_HEIGHT * Math.tan(Math.PI / 2 - radians);
    if (topW > 2) {
      for (const op of ['chamfer', 'fillet']) {
        variants.push({
          name: `Trapezoid ${op} top edge with ${desc} sidewall`,
          profile: trapezoidProfile(ORIENT_BASE_W, Math.max(2, topW), ORIENT_HEIGHT),
          extrudeHeight: 8,
          edgeSelector: 'topHorizontal', operation: op, param: 0.5,
          surfacePairing: 'PLANE+PLANE',
        });
      }
    }
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Concave corner variants (Section 5)
// ---------------------------------------------------------------------------

function buildConcaveVariants() {
  const variants = [];

  // L-shape
  for (const op of ['chamfer', 'fillet']) {
    for (const [edgeDesc, edgeFinderFn, known] of [
      ['inner vertical edge', (topo) => findVerticalEdgeAt(topo, 10, 10), false],
      ['inner top-step edge', (topo) => findInnerCornerEdge(topo, 8, 20, 10), true],
      ['top edge near concavity', (topo, h) => EdgeSelectors.topHorizontal(topo, h), false],
    ]) {
      variants.push({
        name: `L-shape ${op} on ${edgeDesc}`,
        profile: lShapeProfile(30, 20, 10, 10), extrudeHeight: 8,
        edgeFinderFn, operation: op, param: 1.0,
        surfacePairing: 'PLANE+PLANE concave', concave: true,
        knownEdgeCase: known,
      });
    }
  }

  // U-shape — left inner wall
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `U-shape ${op} on left inner vertical edge`,
      profile: uShapeProfile(30, 20, 8, 12), extrudeHeight: 8,
      edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 8, 8),
      operation: op, param: 1.0,
      surfacePairing: 'PLANE+PLANE concave', concave: true,
    });
  }

  // T-shape — stem-crossbar junction
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `T-shape ${op} on stem-crossbar concave corner`,
      profile: tShapeProfileFull(30, 8, 10, 15), extrudeHeight: 6,
      edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 20, 15),
      operation: op, param: 0.8,
      surfacePairing: 'PLANE+PLANE concave', concave: true,
    });
  }

  // Cross shape
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Cross-shape ${op} on concave inner corner`,
      profile: crossShapeProfile(8, 8), extrudeHeight: 6,
      edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 4, 4),
      operation: op, param: 0.5,
      surfacePairing: 'PLANE+PLANE concave', concave: true,
      knownEdgeCase: true,
    });
  }

  // Notched rectangle
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Notched-rect ${op} on notch concave corner`,
      profile: notchedRectProfile(20, 15, 8, 6), extrudeHeight: 6,
      edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 6, 3),
      operation: op, param: 0.5,
      surfacePairing: 'PLANE+PLANE concave', concave: true,
    });
  }

  // Stepped profile
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Stepped-profile ${op} on step concave corner`,
      profile: steppedProfile(8, 5, 3), extrudeHeight: 6,
      edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 8, 5),
      operation: op, param: 0.5,
      surfacePairing: 'PLANE+PLANE concave', concave: true,
    });
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Overlapping / adjacent multi-edge batch variants (Section 6)
// ---------------------------------------------------------------------------

function buildOverlappingVariants() {
  const variants = [];

  // Rectangle: all top edges (4 edges meeting at corners)
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Rectangle all-top-edges ${op} (4 edges meeting at corners)`,
      profile: rectangleProfile(20, 10), extrudeHeight: 10,
      multiEdge: true,
      edgesFinderFn: (topo, h) => findAllTopEdges(topo, h),
      operation: op, param: 1.0,
      surfacePairing: 'PLANE+PLANE multi-edge',
      knownEdgeCase: true,
    });
  }

  // L-shape: all top edges (convex + concave corners)
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `L-shape all-top-edges ${op} (convex + concave corners)`,
      profile: lShapeProfile(30, 20, 10, 10), extrudeHeight: 8,
      multiEdge: true,
      edgesFinderFn: (topo, h) => findAllTopEdges(topo, h),
      operation: op, param: 0.8,
      surfacePairing: 'PLANE+PLANE multi-edge concave',
      knownEdgeCase: true,
    });
  }

  // U-shape: all top edges (mixed concave/convex)
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `U-shape all-top-edges ${op} (mixed concave/convex)`,
      profile: uShapeProfile(30, 20, 8, 12), extrudeHeight: 8,
      multiEdge: true,
      edgesFinderFn: (topo, h) => findAllTopEdges(topo, h),
      operation: op, param: 0.6,
      surfacePairing: 'PLANE+PLANE multi-edge concave',
      knownEdgeCase: true,
    });
  }

  // Cross shape: all vertical edges (4 concave + 4 convex)
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Cross-shape all-vertical-edges ${op} (4 concave + 4 convex)`,
      profile: crossShapeProfile(8, 8), extrudeHeight: 6,
      multiEdge: true,
      edgesFinderFn: (topo) => findAllVerticalEdges(topo),
      operation: op, param: 0.5,
      surfacePairing: 'PLANE+PLANE multi-edge concave',
      knownEdgeCase: true,
    });
  }

  // Rectangle: two adjacent top edges (shared vertex)
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Rectangle two-adjacent-top-edges ${op} (shared vertex)`,
      profile: rectangleProfile(20, 10), extrudeHeight: 10,
      multiEdge: true,
      edgesFinderFn: (topo, h) => {
        const topEdges = findAllTopEdges(topo, h);
        if (topEdges.length < 2) return topEdges;
        const first = topEdges[0];
        const shared = topEdges.find(e => {
          if (e === first) return false;
          const fverts = [vk(first.startVertex.point), vk(first.endVertex.point)];
          return fverts.includes(vk(e.startVertex.point)) || fverts.includes(vk(e.endVertex.point));
        });
        return shared ? [first, shared] : [first];
      },
      operation: op, param: 1.5,
      surfacePairing: 'PLANE+PLANE multi-edge adjacent',
      knownEdgeCase: true,
    });
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Face-consuming large radius variants (Section 8)
// ---------------------------------------------------------------------------

function buildFaceConsumingVariants() {
  const variants = [];

  // Rectangle with increasing radius ratios
  const faceWidth = 10;
  for (const [ratio, desc, known] of [
    [0.4, '40% of face width', false],
    [0.6, '60% of face width', false],
    [0.8, '80% of face width', true],
    [0.95, '95% of face width', true],
  ]) {
    const size = faceWidth * ratio;
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `Rect ${op} at ${desc} (size=${size.toFixed(1)})`,
        profile: rectangleProfile(20, 10), extrudeHeight: 10,
        edgeSelector: 'topHorizontal', operation: op, param: size,
        surfacePairing: 'PLANE+PLANE face-consuming',
        knownEdgeCase: known,
      });
    }
  }

  // L-shape: large fillet at concave corner
  for (const [size, desc, known] of [
    [1.5, 'moderate radius', false],
    [3.0, 'large radius (concave fill)', true],
    [5.0, 'very large radius (face merge)', true],
  ]) {
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `L-shape ${op} concave edge size=${size} (${desc})`,
        profile: lShapeProfile(30, 20, 10, 10), extrudeHeight: 8,
        edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 10, 10),
        operation: op, param: size,
        surfacePairing: 'PLANE+PLANE concave face-consuming',
        concave: true,
        knownEdgeCase: known,
      });
    }
  }

  // Thin wall near-elimination
  for (const op of ['chamfer', 'fillet']) {
    variants.push({
      name: `Thin-wall ${op} (3mm wall, 2.5mm radius)`,
      profile: rectangleProfile(20, 3), extrudeHeight: 10,
      edgeSelector: 'topHorizontal', operation: op, param: 2.5,
      surfacePairing: 'PLANE+PLANE thin-wall',
      knownEdgeCase: true,
    });
  }

  // Notched rectangle: large fillet at notch — may consume notch walls
  for (const [size, known] of [[1.0, false], [2.5, true], [4.0, true]]) {
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `Notched-rect ${op} at notch, size=${size}`,
        profile: notchedRectProfile(20, 15, 8, 6), extrudeHeight: 6,
        edgeFinderFn: (topo) => findVerticalEdgeAt(topo, 6, 3),
        operation: op, param: size,
        surfacePairing: 'PLANE+PLANE concave face-consuming',
        concave: true,
        knownEdgeCase: known,
      });
    }
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Sequential operations (Sections 7 + 9) — multiple chained ops on one body
// ---------------------------------------------------------------------------

function buildSequentialVariants() {
  const variants = [];

  // L-shape: chamfer→fillet, fillet→chamfer, fillet→fillet, chamfer→chamfer
  for (const [op1, op2, desc] of [
    ['chamfer', 'fillet', 'chamfer-then-fillet'],
    ['fillet', 'chamfer', 'fillet-then-chamfer'],
    ['fillet', 'fillet', 'fillet-then-fillet'],
    ['chamfer', 'chamfer', 'chamfer-then-chamfer'],
  ]) {
    variants.push({
      name: `L-shape ${desc} (top → bottom)`,
      sequential: true,
      steps: [
        { profile: lShapeProfile(30, 20, 10, 10), extrudeHeight: 8,
          operation: op1, param: 0.8, edgeSelector: 'topHorizontal' },
        { operation: op2, param: 0.8, edgeSelector: 'bottomHorizontal' },
      ],
      surfacePairing: 'PLANE+PLANE sequential',
    });
  }

  // Triple: L-shape fillet top → chamfer bottom → fillet vertical
  variants.push({
    name: `L-shape fillet→chamfer→fillet (top → bottom → vertical)`,
    sequential: true,
    steps: [
      { profile: lShapeProfile(30, 20, 10, 10), extrudeHeight: 8,
        operation: 'fillet', param: 0.5, edgeSelector: 'topHorizontal' },
      { operation: 'chamfer', param: 0.5, edgeSelector: 'bottomHorizontal' },
      { operation: 'fillet', param: 0.5, edgeSelector: 'vertical' },
    ],
    surfacePairing: 'PLANE+PLANE triple-sequential',
  });

  // Rectangle: chamfer top → fillet top → chamfer bottom
  variants.push({
    name: `Rectangle chamfer→fillet→chamfer (top → top → bottom)`,
    sequential: true,
    steps: [
      { profile: rectangleProfile(20, 10), extrudeHeight: 10,
        operation: 'chamfer', param: 1.0, edgeSelector: 'topHorizontal' },
      { operation: 'fillet', param: 1.0, edgeSelector: 'topHorizontal' },
      { operation: 'chamfer', param: 0.5, edgeSelector: 'bottomHorizontal' },
    ],
    surfacePairing: 'PLANE+PLANE triple-sequential',
  });

  return variants;
}

// ---------------------------------------------------------------------------
// Test execution + data collection
// ---------------------------------------------------------------------------

function selectEdge(topo, selector, extrudeHeight) {
  if (typeof selector === 'function') return selector(topo, extrudeHeight);
  if (selector === 'topHorizontal') return EdgeSelectors.topHorizontal(topo, extrudeHeight);
  if (selector === 'bottomHorizontal') return EdgeSelectors.bottomHorizontal(topo);
  if (selector === 'vertical') return EdgeSelectors.vertical(topo);
  if (selector === 'bsplineTop') return EdgeSelectors.bsplineTop(topo, extrudeHeight);
  return null;
}

/** Count degenerate triangles (near-zero area) in a geometry. */
function countDegenerateTriangles(geom, threshold = 1e-8) {
  let count = 0;
  for (const face of geom.faces || []) {
    const verts = face.vertices || [];
    for (let i = 1; i + 1 < verts.length; i++) {
      const a = verts[0], b = verts[i], c = verts[i + 1];
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
      const cx = aby * acz - abz * acy;
      const cy = abz * acx - abx * acz;
      const cz = abx * acy - aby * acx;
      const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (area < threshold) count++;
    }
  }
  return count;
}

/**
 * Count thin-sliver triangles (aspect ratio > threshold).
 * Aspect ratio = longest edge / height to that edge.
 * Well-shaped triangles have ratio ~1.15; slivers have much higher.
 */
function countSliverTriangles(geom, ratioThreshold = 8.0) {
  let count = 0;
  for (const face of geom.faces || []) {
    const verts = face.vertices || [];
    for (let i = 1; i + 1 < verts.length; i++) {
      const a = verts[0], b = verts[i], c = verts[i + 1];
      // Edge lengths
      const ab = Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2 + (b.z-a.z)**2);
      const bc = Math.sqrt((c.x-b.x)**2 + (c.y-b.y)**2 + (c.z-b.z)**2);
      const ca = Math.sqrt((a.x-c.x)**2 + (a.y-c.y)**2 + (a.z-c.z)**2);
      const longest = Math.max(ab, bc, ca);
      // Cross product magnitude = 2*area
      const abx = b.x-a.x, aby = b.y-a.y, abz = b.z-a.z;
      const acx = c.x-a.x, acy = c.y-a.y, acz = c.z-a.z;
      const cx2 = aby*acz - abz*acy, cy2 = abz*acx - abx*acz, cz2 = abx*acy - aby*acx;
      const twiceArea = Math.sqrt(cx2*cx2 + cy2*cy2 + cz2*cz2);
      if (twiceArea < 1e-12) { count++; continue; }
      const height = twiceArea / longest;
      if (longest / height > ratioThreshold) count++;
    }
  }
  return count;
}

/**
 * Count triangles whose computed normal disagrees with the face's stored normal.
 * This catches "visually flipped" faces that pass winding checks.
 */
function countFlippedNormalTriangles(geom, dotThreshold = -0.1) {
  let count = 0;
  for (const face of geom.faces || []) {
    const fn = face.normal;
    if (!fn) continue;
    const verts = face.vertices || [];
    for (let i = 1; i + 1 < verts.length; i++) {
      const a = verts[0], b = verts[i], c = verts[i + 1];
      const abx = b.x-a.x, aby = b.y-a.y, abz = b.z-a.z;
      const acx = c.x-a.x, acy = c.y-a.y, acz = c.z-a.z;
      const nx = aby*acz - abz*acy, ny = abz*acx - abx*acz, nz = abx*acy - aby*acx;
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
      if (len < 1e-12) continue;
      const dot = (nx*fn.x + ny*fn.y + nz*fn.z) / len;
      if (dot < dotThreshold) count++;
    }
  }
  return count;
}

function runVariant(variant) {
  const result = {
    name: variant.name,
    operation: variant.operation || (variant.sequential ? variant.steps.map(s => s.operation).join('→') : '?'),
    surfacePairing: variant.surfacePairing,
    param: variant.param || (variant.sequential ? variant.steps.map(s => s.param).join(',') : 0),
    knownEdgeCase: variant.knownEdgeCase || false,
    status: 'error',
    error: null,
    warnings: [],
    volumeBefore: 0,
    volumeAfter: 0,
    volumeError: 0,
    manifold: null,
    topoBoundary: -1,
    beforeGeom: null,
    afterGeom: null,
    edgeKey: null,
    faceCountBefore: 0,
    faceCountAfter: 0,
    triCountBefore: 0,
    triCountAfter: 0,
    degenerateTriangles: 0,
    sliverTriangles: 0,
    flippedNormals: 0,
    featureTopoFaceIds: null,
    concave: variant.concave || false,
  };

  try {
    // --- Sequential variants run through a series of chained operations ---
    if (variant.sequential) {
      return runSequentialVariant(variant, result);
    }

    const part = buildPart(variant.profile, variant.extrudeHeight);
    const geom = getGeom(part);
    const topo = geom.topoBody;
    if (!topo) { result.error = 'No topoBody from extrude'; return result; }

    result.beforeGeom = geom;
    result.volumeBefore = calculateMeshVolume(geom);
    result.faceCountBefore = geom.faces?.length || 0;
    result.triCountBefore = countTriangles(geom);

    let afterGeom;

    // --- Multi-edge batch operation ---
    if (variant.multiEdge && variant.edgesFinderFn) {
      const edges = variant.edgesFinderFn(topo, variant.extrudeHeight);
      if (!edges || edges.length === 0) { result.error = 'Multi-edge finder returned no edges'; return result; }
      const keys = edges.map(e => edgeKeyFromVerts(e.startVertex.point, e.endVertex.point));
      result.edgeKey = keys[0]; // highlight first edge for render
      if (variant.operation === 'chamfer') {
        afterGeom = applyBRepChamfer(geom, keys, variant.param);
      } else {
        afterGeom = applyBRepFillet(geom, keys, variant.param, 4);
      }
    } else {
      // --- Single-edge operation ---
      const edge = variant.edgeFinderFn
        ? variant.edgeFinderFn(topo, variant.extrudeHeight)
        : selectEdge(topo, variant.edgeSelector, variant.extrudeHeight);
      if (!edge) { result.error = `Edge finder/selector found nothing`; return result; }

      const edgeKey = edgeKeyFromVerts(edge.startVertex.point, edge.endVertex.point);
      result.edgeKey = edgeKey;

      if (variant.operation === 'chamfer') {
        afterGeom = applyBRepChamfer(geom, [edgeKey], variant.param);
      } else {
        afterGeom = applyBRepFillet(geom, [edgeKey], variant.param, 4);
      }
    }

    if (!afterGeom) { result.error = 'Operation returned null'; return result; }

    result.afterGeom = afterGeom;

    // Identify feature faces
    if (afterGeom.topoBody && topo) {
      const beforeTopoCount = topo.shells[0].faces.length;
      const afterTopoFaces = afterGeom.topoBody.shells[0].faces;
      const featureIds = new Set();
      for (let fi = beforeTopoCount; fi < afterTopoFaces.length; fi++) {
        featureIds.add(afterTopoFaces[fi].id);
      }
      result.featureTopoFaceIds = featureIds;
    }
    result.volumeAfter = calculateMeshVolume(afterGeom);
    result.faceCountAfter = afterGeom.faces?.length || 0;
    result.triCountAfter = countTriangles(afterGeom);
    result.degenerateTriangles = countDegenerateTriangles(afterGeom);
    result.sliverTriangles = countSliverTriangles(afterGeom);
    result.flippedNormals = countFlippedNormalTriangles(afterGeom);
    result.manifold = checkManifold(afterGeom);
    result.topoBoundary = afterGeom.topoBody ? countBoundaryEdges(afterGeom.topoBody) : -1;

    // Volume error
    if (result.volumeBefore > 0) {
      result.volumeError = ((result.volumeBefore - result.volumeAfter) / result.volumeBefore) * 100;
    }

    // --- Determine status: strict validation ---
    const m = result.manifold;

    // Collect warnings (non-fatal indicators of quality issues)
    if (m.windingErrors > 0) result.warnings.push(`${m.windingErrors} winding errors`);
    if (result.degenerateTriangles > 0) result.warnings.push(`${result.degenerateTriangles} degenerate tris`);
    if (result.sliverTriangles > 0) result.warnings.push(`${result.sliverTriangles} sliver tris`);
    if (result.flippedNormals > 0) result.warnings.push(`${result.flippedNormals} flipped normals`);
    if (result.topoBoundary > 0 && m.boundaryEdges === 0) result.warnings.push(`topo boundary ${result.topoBoundary} but mesh closed`);
    if (m.boundaryEdges > 0 && result.topoBoundary === 0) result.warnings.push(`mesh boundary ${m.boundaryEdges} but topo closed`);

    // Hard pass criteria — NO exceptions for BSPLINE anymore
    const isConcave = variant.concave || false;
    const volumeOk = isConcave
      ? true // concave ops can add or remove material
      : (result.volumeAfter < result.volumeBefore && result.volumeAfter > result.volumeBefore * 0.1);

    const pass = m.boundaryEdges === 0 &&
      m.nonManifoldEdges === 0 &&
      m.windingErrors === 0 &&
      result.topoBoundary === 0 &&
      volumeOk;

    result.status = pass ? 'pass' : (variant.knownEdgeCase ? 'known' : 'fail');

    // Upgrade pass→warn if there are quality warnings (pass with caveats)
    if (result.status === 'pass' && result.warnings.length > 0) {
      result.status = 'warn';
    }
  } catch (err) {
    result.error = err.message;
    result.status = variant.knownEdgeCase ? 'known' : 'fail';
  }

  return result;
}

/** Run a sequential (multi-step) variant — chained chamfer/fillet operations. */
function runSequentialVariant(variant, result) {
  try {
    const step0 = variant.steps[0];
    const part = buildPart(step0.profile, step0.extrudeHeight);
    const geomBefore = getGeom(part);
    result.beforeGeom = geomBefore;
    result.volumeBefore = calculateMeshVolume(geomBefore);
    result.faceCountBefore = geomBefore.faces?.length || 0;
    result.triCountBefore = countTriangles(geomBefore);

    let currentGeom = geomBefore;

    for (let si = 0; si < variant.steps.length; si++) {
      const step = variant.steps[si];
      const topo = currentGeom.topoBody;
      if (!topo) { result.error = `Step ${si + 1}: no topoBody`; return result; }

      const edge = selectEdge(topo, step.edgeSelector, step.extrudeHeight || variant.steps[0].extrudeHeight);
      if (!edge) { result.error = `Step ${si + 1}: edge '${step.edgeSelector}' not found`; return result; }

      const key = edgeKeyFromVerts(edge.startVertex.point, edge.endVertex.point);
      if (si === 0) result.edgeKey = key;

      const afterGeom = step.operation === 'chamfer'
        ? applyBRepChamfer(currentGeom, [key], step.param)
        : applyBRepFillet(currentGeom, [key], step.param, 4);

      if (!afterGeom) { result.error = `Step ${si + 1}: operation returned null`; return result; }
      currentGeom = afterGeom;
    }

    result.afterGeom = currentGeom;
    result.volumeAfter = calculateMeshVolume(currentGeom);
    result.faceCountAfter = currentGeom.faces?.length || 0;
    result.triCountAfter = countTriangles(currentGeom);
    result.degenerateTriangles = countDegenerateTriangles(currentGeom);
    result.sliverTriangles = countSliverTriangles(currentGeom);
    result.flippedNormals = countFlippedNormalTriangles(currentGeom);
    result.manifold = checkManifold(currentGeom);
    result.topoBoundary = currentGeom.topoBody ? countBoundaryEdges(currentGeom.topoBody) : -1;

    if (result.volumeBefore > 0) {
      result.volumeError = ((result.volumeBefore - result.volumeAfter) / result.volumeBefore) * 100;
    }

    const m = result.manifold;
    if (m.windingErrors > 0) result.warnings.push(`${m.windingErrors} winding errors`);
    if (result.degenerateTriangles > 0) result.warnings.push(`${result.degenerateTriangles} degenerate tris`);
    if (result.sliverTriangles > 0) result.warnings.push(`${result.sliverTriangles} sliver tris`);
    if (result.flippedNormals > 0) result.warnings.push(`${result.flippedNormals} flipped normals`);

    const pass = m.boundaryEdges === 0 && m.nonManifoldEdges === 0 &&
      m.windingErrors === 0 && result.topoBoundary === 0 &&
      result.volumeAfter < result.volumeBefore && result.volumeAfter > result.volumeBefore * 0.01;

    result.status = pass ? 'pass' : (variant.knownEdgeCase ? 'known' : 'fail');
    if (result.status === 'pass' && result.warnings.length > 0) result.status = 'warn';
  } catch (err) {
    result.error = err.message;
    result.status = variant.knownEdgeCase ? 'known' : 'fail';
  }
  return result;
}

function countTriangles(geom) {
  let count = 0;
  for (const face of geom.faces || []) {
    const n = (face.vertices || []).length;
    if (n >= 3) count += n - 2;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Render helpers for report images — avoid top-level await
// ---------------------------------------------------------------------------

let _renderMathModule = null;
async function getRenderMath() {
  if (!_renderMathModule) {
    _renderMathModule = await import('../js/render/render-math.js');
  }
  return _renderMathModule;
}

async function renderGeometryToPngBuffer(geometry, options = {}) {
  const canvas = await renderGeometryToCanvas(geometry, options);
  const buf = await canvas.encode('png');
  // Reclaim native canvas memory immediately
  canvas.width = 0;
  canvas.height = 0;
  return buf;
}

async function renderGeometryToCanvas(geometry, options = {}) {
  const {
    width = CELL_W,
    height = CELL_H,
    diagnosticHatch = false,
    meshOverlay = false,
    highlightEdgeKey = null,
    theta = Math.PI / 4,
    phi = Math.PI / 3,
  } = options;

  const canvas = createCanvas(width, height);
  const executor = new CanvasCommandExecutor(canvas);
  executor.clear([0.12, 0.12, 0.15, 1]);

  const faces = geometry.faces || [];
  if (faces.length === 0) return canvas;

  const renderData = buildMeshRenderData(geometry);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const face of faces) {
    for (const v of face.vertices || []) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
  }

  const bounds = Number.isFinite(minX) ? {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  } : null;

  const fit = computeFitViewState(bounds, 25);
  const orbitState = { theta, phi, radius: fit.radius, target: fit.target };
  const mvp = computeOrbitMvp({
    width, height,
    target: orbitState.target,
    theta: orbitState.theta,
    phi: orbitState.phi,
    radius: orbitState.radius,
    fov: Math.PI / 4,
    fovDegrees: 45,
    ortho3D: false,
    orthoBounds: null,
  });

  if (!mvp) return canvas;

  const faceColor = options.faceColor || [0.65, 0.75, 0.65, 1];

  renderBaseMeshOverlay(executor, {
    meshTriangles: renderData._meshTriangles,
    meshTriangleCount: renderData._meshTriangleCount,
    meshVisualEdges: renderData._meshVisualEdges,
    meshVisualEdgeVertexCount: renderData._meshVisualEdgeVertexCount,
    meshDashedFeatureEdges: renderData._meshDashedFeatureEdges,
    meshDashedFeatureEdgeVertexCount: renderData._meshDashedFeatureEdgeVertexCount,
    meshTriangleOverlayEdges: renderData._meshTriangleOverlayEdges,
    meshTriangleOverlayEdgeVertexCount: renderData._meshTriangleOverlayEdgeVertexCount,
    meshEdges: renderData._meshEdges,
    meshEdgeVertexCount: renderData._meshEdgeVertexCount,
    meshSilhouetteCandidates: renderData._meshSilhouetteCandidates,
    meshBoundaryEdges: renderData._meshBoundaryEdges,
    meshBoundaryEdgeVertexCount: renderData._meshBoundaryEdgeVertexCount,
    orbitState,
    mvp,
    faceColor,
    diagnosticHatch,
    showInvisibleEdges: false,
    meshTriangleOverlayMode: meshOverlay ? 'outline' : 'off',
  });

  // Draw highlighted edge
  if (highlightEdgeKey) {
    const { mat4TransformVec4, projectClipToScreen } = await getRenderMath();
    const ctx = canvas.getContext('2d');
    for (const edge of geometry.edges || []) {
      const points = edge.points || (edge.start && edge.end ? [edge.start, edge.end] : []);
      if (points.length < 2) continue;
      const kp = edgeKeyFromVerts(points[0], points[points.length - 1]);
      if (kp !== highlightEdgeKey) continue;

      ctx.save();
      ctx.strokeStyle = 'rgba(38, 115, 242, 0.95)';
      ctx.lineWidth = 3.5;
      ctx.shadowColor = 'rgba(38, 115, 242, 0.6)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      let first = true;
      for (const p of points) {
        const clip = mat4TransformVec4(mvp, p.x, p.y, p.z, 1);
        const screen = projectClipToScreen(clip, width, height);
        if (!screen) continue;
        if (first) { ctx.moveTo(screen.x, screen.y); first = false; }
        else ctx.lineTo(screen.x, screen.y);
      }
      ctx.stroke();
      ctx.restore();
      break;
    }
  }

  // Draw label
  if (options.label) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, width, 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px sans-serif';
    ctx.fillText(options.label, 4, 13);
    ctx.restore();
  }

  return canvas;
}

/**
 * Render a feature preview: the after geometry with feature faces in blue
 * and the remaining body faces in muted grey, providing a clear visual
 * of what the chamfer/fillet operation adds.
 *
 * @param {Object} afterGeom - The geometry after the chamfer/fillet
 * @param {Set<number>} featureTopoFaceIds - topoFaceIds of the new feature faces
 * @param {Object} options - Rendering options (width, height, theta, phi, label)
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderFeaturePreviewToPngBuffer(afterGeom, featureTopoFaceIds, options = {}) {
  const {
    width = CELL_W,
    height = CELL_H,
    theta = Math.PI / 4,
    phi = Math.PI / 3,
  } = options;

  const canvas = createCanvas(width, height);
  const executor = new CanvasCommandExecutor(canvas);
  executor.clear([0.12, 0.12, 0.15, 1]);

  const faces = afterGeom.faces || [];
  if (faces.length === 0) {
    const buf = await canvas.encode('png');
    canvas.width = 0; canvas.height = 0;
    return buf;
  }

  // Split faces into base body vs feature faces
  const baseFaces = [];
  const featureFaces = [];
  for (const face of faces) {
    if (featureTopoFaceIds && featureTopoFaceIds.has(face.topoFaceId)) {
      featureFaces.push(face);
    } else {
      baseFaces.push(face);
    }
  }

  // Compute bounds from all faces
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const face of faces) {
    for (const v of face.vertices || []) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
  }
  const bounds = Number.isFinite(minX) ? {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  } : null;

  const fit = computeFitViewState(bounds, 25);
  const orbitState = { theta, phi, radius: fit.radius, target: fit.target };
  const mvp = computeOrbitMvp({
    width, height,
    target: orbitState.target,
    theta: orbitState.theta,
    phi: orbitState.phi,
    radius: orbitState.radius,
    fov: Math.PI / 4,
    fovDegrees: 45,
    ortho3D: false,
    orthoBounds: null,
  });

  if (!mvp) {
    const buf = await canvas.encode('png');
    canvas.width = 0; canvas.height = 0;
    return buf;
  }

  // Build render data for the full geometry first (for edges/silhouettes)
  const fullRenderData = buildMeshRenderData(afterGeom);

  // Render base faces in muted grey
  const baseGeom = { faces: baseFaces, edges: afterGeom.edges || [] };
  const baseRenderData = buildMeshRenderData(baseGeom);
  renderBaseMeshOverlay(executor, {
    meshTriangles: baseRenderData._meshTriangles,
    meshTriangleCount: baseRenderData._meshTriangleCount,
    meshVisualEdges: null,
    meshVisualEdgeVertexCount: 0,
    meshDashedFeatureEdges: null,
    meshDashedFeatureEdgeVertexCount: 0,
    meshTriangleOverlayEdges: null,
    meshTriangleOverlayEdgeVertexCount: 0,
    meshEdges: null,
    meshEdgeVertexCount: 0,
    meshSilhouetteCandidates: null,
    meshBoundaryEdges: null,
    meshBoundaryEdgeVertexCount: 0,
    orbitState,
    mvp,
    faceColor: [0.45, 0.48, 0.52, 1],
    diagnosticHatch: false,
    showInvisibleEdges: false,
    meshTriangleOverlayMode: 'off',
  });

  // Render feature faces in bright blue
  if (featureFaces.length > 0) {
    const featureGeom = { faces: featureFaces, edges: [] };
    const featureRenderData = buildMeshRenderData(featureGeom);
    renderBaseMeshOverlay(executor, {
      meshTriangles: featureRenderData._meshTriangles,
      meshTriangleCount: featureRenderData._meshTriangleCount,
      meshVisualEdges: null,
      meshVisualEdgeVertexCount: 0,
      meshDashedFeatureEdges: null,
      meshDashedFeatureEdgeVertexCount: 0,
      meshTriangleOverlayEdges: null,
      meshTriangleOverlayEdgeVertexCount: 0,
      meshEdges: null,
      meshEdgeVertexCount: 0,
      meshSilhouetteCandidates: null,
      meshBoundaryEdges: null,
      meshBoundaryEdgeVertexCount: 0,
      orbitState,
      mvp,
      faceColor: [0.22, 0.52, 0.92, 1],
      diagnosticHatch: false,
      showInvisibleEdges: false,
      meshTriangleOverlayMode: 'off',
    });
  }

  // Draw edges and silhouettes from full geometry on top
  renderBaseMeshOverlay(executor, {
    meshTriangles: null,
    meshTriangleCount: 0,
    meshVisualEdges: fullRenderData._meshVisualEdges,
    meshVisualEdgeVertexCount: fullRenderData._meshVisualEdgeVertexCount,
    meshDashedFeatureEdges: null,
    meshDashedFeatureEdgeVertexCount: 0,
    meshTriangleOverlayEdges: null,
    meshTriangleOverlayEdgeVertexCount: 0,
    meshEdges: fullRenderData._meshEdges,
    meshEdgeVertexCount: fullRenderData._meshEdgeVertexCount,
    meshSilhouetteCandidates: fullRenderData._meshSilhouetteCandidates,
    meshBoundaryEdges: fullRenderData._meshBoundaryEdges,
    meshBoundaryEdgeVertexCount: fullRenderData._meshBoundaryEdgeVertexCount,
    orbitState,
    mvp,
    faceColor: [0, 0, 0, 0],
    diagnosticHatch: false,
    showInvisibleEdges: false,
    meshTriangleOverlayMode: 'off',
  });

  // Label
  if (options.label) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, width, 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px sans-serif';
    ctx.fillText(options.label, 4, 13);
    ctx.restore();
  }

  const buf = await canvas.encode('png');
  canvas.width = 0; canvas.height = 0;
  return buf;
}

/**
 * Render all 6 sub-images for a single test result, returning PNG buffers.
 * Shared by both PDF embedding and standalone composite image generation.
 */
async function renderTestImages(r, cellW, cellH) {
  const images = { before: null, after: null, featurePreview: null, diagHatch: null, wireframe: null, altRearLeft: null, altFront: null, featurePreviewAlt: null };
  if (!r.beforeGeom) return images;

  const w = Math.round(cellW * 2);
  const h = Math.round(cellH * 2);

  // Render sequentially to avoid native canvas memory buildup (segfault)
  const hasFeature = r.afterGeom && r.featureTopoFaceIds && r.featureTopoFaceIds.size > 0;

  images.before = await renderGeometryToPngBuffer(r.beforeGeom, {
    width: w, height: h,
    highlightEdgeKey: r.edgeKey,
    label: 'BEFORE — selected edge highlighted',
  });

  if (r.afterGeom) {
    images.after = await renderGeometryToPngBuffer(r.afterGeom, {
      width: w, height: h,
      faceColor: [0.55, 0.68, 0.85, 1],
      label: `AFTER — ${r.operation} result`,
    });

    if (hasFeature) {
      images.featurePreview = await renderFeaturePreviewToPngBuffer(r.afterGeom, r.featureTopoFaceIds, {
        width: w, height: h,
        label: `FEATURE PREVIEW — ${r.operation} faces highlighted`,
      });
      images.featurePreviewAlt = await renderFeaturePreviewToPngBuffer(r.afterGeom, r.featureTopoFaceIds, {
        width: w, height: h,
        theta: Math.PI * 0.75,
        phi: Math.PI / 4,
        label: `FEATURE PREVIEW — rear-left angle`,
      });
    }

    images.diagHatch = await renderGeometryToPngBuffer(r.afterGeom, {
      width: w, height: h,
      diagnosticHatch: true,
      meshOverlay: true,
      label: 'Diagnostic hatch (red = flipped, pink boundary = holes)',
    });

    images.wireframe = await renderGeometryToPngBuffer(r.afterGeom, {
      width: w, height: h,
      meshOverlay: true,
      label: 'Triangle mesh wireframe',
    });

    images.altRearLeft = await renderGeometryToPngBuffer(r.afterGeom, {
      width: w, height: h,
      theta: Math.PI * 0.75,
      phi: Math.PI / 4,
      label: 'Rear-left view',
    });

    images.altFront = await renderGeometryToPngBuffer(r.afterGeom, {
      width: w, height: h,
      theta: 0,
      phi: Math.PI / 2.5,
      faceColor: [0.55, 0.68, 0.85, 1],
      label: 'Front view — feature highlight',
    });
  }

  return images;
}

// Composite image layout constants
const COMP_PADDING = 12;
const COMP_HEADER_H = 80;
const COMP_ROW_LABEL_H = 16;
const COMP_BG = '#1e1e24';
const COMP_TEXT = '#e0e0e0';
const COMP_HEADER_BG = '#1a2744';

/**
 * Compose a single presentation-ready PNG for one test result.
 * Layout: header with title/metrics, then 4 rows × 2 columns of images.
 */
async function composeTestImage(r, images, index, total) {
  const cellW = CELL_W * 2;   // use high-res cell size
  const cellH = Math.round(cellW * 0.75);
  const cols = 2;
  const rows = 4;
  const totalW = COMP_PADDING * 2 + cols * cellW + COMP_PADDING;
  const totalH = COMP_PADDING + COMP_HEADER_H + rows * (COMP_ROW_LABEL_H + cellH + COMP_PADDING);

  const canvas = createCanvas(totalW, totalH);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COMP_BG;
  ctx.fillRect(0, 0, totalW, totalH);

  // Header bar
  ctx.fillStyle = COMP_HEADER_BG;
  ctx.fillRect(0, 0, totalW, COMP_HEADER_H);

  // Title
  const statusColor = r.status === 'pass' ? '#4caf50' : r.status === 'warn' ? '#d4a017' : r.status === 'known' ? '#ff9800' : '#f44336';
  const statusText = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : r.status === 'known' ? 'KNOWN EDGE CASE' : 'FAIL';
  ctx.fillStyle = COMP_TEXT;
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(`Test ${index + 1}/${total}: ${r.name}`, COMP_PADDING, 28);

  ctx.fillStyle = statusColor;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(statusText, totalW - COMP_PADDING - ctx.measureText(statusText).width, 28);

  // Metrics line
  ctx.fillStyle = '#aabbcc';
  ctx.font = '13px sans-serif';
  const metricsLine = [
    `Op: ${r.operation}(${r.param})`,
    `Pairing: ${r.surfacePairing}`,
    `Faces: ${r.faceCountBefore}→${r.faceCountAfter}`,
    `Tris: ${r.triCountBefore}→${r.triCountAfter}`,
  ].join('  |  ');
  ctx.fillText(metricsLine, COMP_PADDING, 50);

  // Volume + manifold line
  const volLine = [
    `Vol: ${r.volumeBefore.toFixed(1)} → ${r.volumeAfter.toFixed(1)} (−${r.volumeError.toFixed(1)}%)`,
  ];
  if (r.manifold) {
    const m = r.manifold;
    volLine.push(`Boundary: ${m.boundaryEdges}  Non-manifold: ${m.nonManifoldEdges}  Winding: ${m.windingErrors}  Topo-bnd: ${r.topoBoundary}`);
  }
  if (r.degenerateTriangles > 0) volLine.push(`Degen-tris: ${r.degenerateTriangles}`);
  if (r.sliverTriangles > 0) volLine.push(`Sliver-tris: ${r.sliverTriangles}`);
  if (r.flippedNormals > 0) volLine.push(`Flipped-nrm: ${r.flippedNormals}`);
  if (r.error) volLine.push(`Error: ${r.error}`);
  ctx.fillText(volLine.join('  |  '), COMP_PADDING, 68);

  // Warnings line (if any)
  if (r.warnings && r.warnings.length > 0) {
    ctx.fillStyle = COLOR_WARN;
    ctx.font = '12px sans-serif';
    ctx.fillText(`⚠ ${r.warnings.join('; ')}`, COMP_PADDING, 84);
  }

  // Draw image grid: 4 rows × 2 cols
  const rowLabels = ['Standard View', 'Feature Preview', 'Diagnostic View', 'Alternate Angles'];
  const imageGrid = [
    [images.before, images.after],
    [images.featurePreview, images.featurePreviewAlt],
    [images.diagHatch, images.wireframe],
    [images.altRearLeft, images.altFront],
  ];

  let y = COMP_HEADER_H + COMP_PADDING;
  for (let row = 0; row < rows; row++) {
    // Row label
    ctx.fillStyle = '#8899bb';
    ctx.font = '12px sans-serif';
    ctx.fillText(rowLabels[row], COMP_PADDING, y + 12);
    y += COMP_ROW_LABEL_H;

    for (let col = 0; col < cols; col++) {
      const buf = imageGrid[row][col];
      const x = COMP_PADDING + col * (cellW + COMP_PADDING);
      if (buf) {
        // Draw the PNG buffer onto the composite canvas
        const img = await loadImage(buf);
        ctx.drawImage(img, x, y, cellW, cellH);
      } else {
        // Empty slot
        ctx.fillStyle = '#2a2a32';
        ctx.fillRect(x, y, cellW, cellH);
        ctx.fillStyle = '#555';
        ctx.font = '14px sans-serif';
        ctx.fillText('No geometry', x + cellW / 2 - 40, y + cellH / 2);
      }
    }
    y += cellH + COMP_PADDING;
  }

  const buf = await canvas.encode('png');
  canvas.width = 0; canvas.height = 0;
  return buf;
}

// ---------------------------------------------------------------------------
// Concurrency-limited parallel map
// ---------------------------------------------------------------------------

async function pMap(items, fn, concurrency = 4) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// PDF report generation
// ---------------------------------------------------------------------------

async function generateReport(outputPath, { generateImages = true } = {}) {
  console.log('=== NURBS Fillet/Chamfer Variant Report ===\n');

  // Collect all variants from all sections
  const singleOps = buildSingleOpVariants();
  const concaveOps = buildConcaveVariants();
  const overlappingOps = buildOverlappingVariants();
  const faceConsumingOps = buildFaceConsumingVariants();
  const sequentialOps = buildSequentialVariants();
  const variants = [...singleOps, ...concaveOps, ...overlappingOps, ...faceConsumingOps, ...sequentialOps];
  console.log(`Running ${variants.length} test variants:`);
  console.log(`  Single ops: ${singleOps.length}  |  Concave: ${concaveOps.length}  |  Overlapping: ${overlappingOps.length}  |  Face-consuming: ${faceConsumingOps.length}  |  Sequential: ${sequentialOps.length}\n`);

  // Run all tests and collect results
  const results = [];
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    process.stdout.write(`  [${i + 1}/${variants.length}] ${variant.name}... `);
    const result = runVariant(variant);
    results.push(result);
    const icon = result.status === 'pass' ? '✓' : result.status === 'warn' ? '⚠?' : result.status === 'known' ? '⚠' : '✗';
    const warnSuffix = result.warnings.length > 0 ? ` [${result.warnings.join('; ')}]` : '';
    console.log(icon + warnSuffix);
  }

  // Summary counts
  const passCount = results.filter(r => r.status === 'pass').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  const knownCount = results.filter(r => r.status === 'known').length;

  console.log(`\nResults: ${passCount} passed, ${warnCount} warnings, ${failCount} failed, ${knownCount} known edge cases`);
  console.log('\nGenerating PDF report...');

  // Create PDF
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: 'NURBS Fillet/Chamfer Variant Test Report',
      Author: 'CAD Modeller Test Suite',
      Subject: 'Automated test report for B-Rep chamfer and fillet edge cases',
      CreationDate: new Date(),
    },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // ---- Cover page ----
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(COLOR_HEADER_BG);
  doc.fontSize(36).fillColor(COLOR_HEADER_TEXT)
    .text('NURBS Fillet/Chamfer', MARGIN, PAGE_H / 2 - 80, { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Variant Test Report', { align: 'center', width: PAGE_W - 2 * MARGIN });
  doc.moveDown(2);
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  doc.fontSize(14).fillColor('#8899bb')
    .text(`Generated: ${timestamp} UTC`, { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text(`${results.length} tests — ${passCount} passed, ${warnCount} warnings, ${failCount} failed, ${knownCount} known edge cases`, { align: 'center', width: PAGE_W - 2 * MARGIN });

  doc.moveDown(4);
  doc.fontSize(11).fillColor('#667799')
    .text('Surface pairings: PLANE+PLANE, PLANE+BSPLINE, BSPLINE+BSPLINE', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Dihedral angles: 45° 60° 70° 90° 108° 110° 117° 120°', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Profiles: Rectangle, Trapezoid, Parallelogram, Triangle, Pentagon, Spline, Bezier, Lens', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Concave profiles: L-shape, U-shape, T-shape, Cross, Notched-rect, Stepped', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Operations: Chamfer, Fillet — sizes 0.3 through 5.0, multi-edge, sequential', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Validation: manifold, winding, boundary, volume, degenerate triangles — no BSPLINE bypass', { align: 'center', width: PAGE_W - 2 * MARGIN });

  // ---- Summary table ----
  doc.addPage();
  doc.fontSize(18).fillColor('#1a2744').text('Summary Table', MARGIN, MARGIN);
  doc.moveDown(0.5);

  const tableTop = doc.y;
  const colWidths = [30, 215, 80, 80, 55, 55];
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);
  const headers = ['#', 'Test Name', 'Surface Pairing', 'Operation', 'Status', 'Vol %'];

  // Header row
  let cx = MARGIN;
  doc.rect(cx, tableTop, tableWidth, 18).fill('#e8ecf0');
  cx = MARGIN;
  doc.fontSize(8).fillColor('#333');
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 3, tableTop + 4, { width: colWidths[i] - 6, align: 'left' });
    cx += colWidths[i];
  }

  // Data rows
  let ry = tableTop + 18;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    if (ry > PAGE_H - 60) {
      doc.addPage();
      ry = MARGIN;
      // Re-draw header
      cx = MARGIN;
      doc.rect(cx, ry, tableWidth, 18).fill('#e8ecf0');
      doc.fontSize(8).fillColor('#333');
      for (let j = 0; j < headers.length; j++) {
        doc.text(headers[j], cx + 3, ry + 4, { width: colWidths[j] - 6, align: 'left' });
        cx += colWidths[j];
      }
      ry += 18;
    }

    // Alternating row background
    if (i % 2 === 0) {
      doc.rect(MARGIN, ry, tableWidth, 14).fill('#f8f9fa');
    }

    cx = MARGIN;
    doc.fontSize(7).fillColor('#555');
    const cells = [
      `${i + 1}`,
      r.name,
      r.surfacePairing,
      `${r.operation} (${r.param})`,
      r.status.toUpperCase(),
      r.volumeError > 0 ? `${r.volumeError.toFixed(1)}%` : '-',
    ];

    for (let j = 0; j < cells.length; j++) {
      let color = '#555';
      if (j === 4) {
        color = r.status === 'pass' ? COLOR_PASS : r.status === 'warn' ? COLOR_WARN : r.status === 'known' ? COLOR_KNOWN : COLOR_FAIL;
      }
      doc.fillColor(color).text(cells[j], cx + 3, ry + 3, { width: colWidths[j] - 6, lineBreak: false, align: 'left' });
      cx += colWidths[j];
    }
    ry += 14;
  }

  // ---- Pre-render all test images in parallel batches ----
  const imgW = (PAGE_W - 2 * MARGIN - IMG_GAP) / 2;
  const imgH = imgW * 0.75;
  const imagesDir = path.join(path.dirname(outputPath), 'images');
  if (generateImages) {
    fs.mkdirSync(imagesDir, { recursive: true });
    console.log(`Saving standalone images to: ${imagesDir}/`);
  }

  console.log(`\nPre-rendering ${results.length} test images...`);
  const preRendered = [];
  const tryGC = typeof global.gc === 'function' ? () => global.gc() : () => {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.beforeGeom) {
      preRendered.push({ images: null, error: null });
      continue;
    }
    try {
      console.log(`  → rendering [${i + 1}/${results.length}] ${r.name}...`);
      const images = await renderTestImages(r, imgW, imgH);
      // Write composite image immediately to avoid holding all in memory
      if (generateImages) {
        const composite = await composeTestImage(r, images, i, results.length);
        const slug = r.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
        const imgPath = path.join(imagesDir, `${String(i + 1).padStart(2, '0')}-${slug}.png`);
        await fs.promises.writeFile(imgPath, composite);
        // Don't hold composite buffer in memory
      }
      console.log(`  ✓ [${i + 1}/${results.length}] ${r.name}`);
      preRendered.push({ images, error: null });
    } catch (err) {
      console.error(`  ✗ [${i + 1}/${results.length}] ${r.name} — ${err.stack || err.message}`);
      preRendered.push({ images: null, error: err.message });
    }
    // Release geometry references we no longer need, GC every test
    r.beforeGeom = null;
    r.afterGeom = null;
    r.featureTopoFaceIds = null;
    tryGC();
  }

  // ---- Individual test pages (sequential PDF assembly) ----
  console.log('\nAssembling PDF pages...');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const pre = preRendered[i];

    doc.addPage();

    // Test header
    const statusColor = r.status === 'pass' ? COLOR_PASS : r.status === 'warn' ? COLOR_WARN : r.status === 'known' ? COLOR_KNOWN : COLOR_FAIL;
    const statusText = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : r.status === 'known' ? 'KNOWN EDGE CASE' : 'FAIL';

    doc.rect(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, 30).fill(COLOR_HEADER_BG);
    doc.fontSize(11).fillColor(COLOR_HEADER_TEXT)
      .text(`Test ${i + 1}/${results.length}: ${r.name}`, MARGIN + 8, MARGIN + 8, { width: PAGE_W - 2 * MARGIN - 80 });
    doc.fontSize(10).fillColor(statusColor)
      .text(statusText, PAGE_W - MARGIN - 100, MARGIN + 9, { width: 92, align: 'right' });

    let y = MARGIN + 40;

    // Metadata box
    doc.fontSize(9).fillColor('#444');
    const meta = [
      `Operation: ${r.operation} (${r.param})`,
      `Surface Pairing: ${r.surfacePairing}`,
      `Faces: ${r.faceCountBefore} → ${r.faceCountAfter}`,
      `Triangles: ${r.triCountBefore} → ${r.triCountAfter}`,
    ];
    if (r.error) meta.push(`Error: ${r.error}`);
    for (const line of meta) {
      doc.text(line, MARGIN, y);
      y += 12;
    }

    // Volume metrics
    y += 4;
    doc.fontSize(9).fillColor('#333');
    doc.text(`Volume before: ${r.volumeBefore.toFixed(2)}`, MARGIN, y);
    doc.text(`Volume after: ${r.volumeAfter.toFixed(2)}`, MARGIN + 160, y);
    doc.text(`Removed: ${r.volumeError.toFixed(1)}%`, MARGIN + 320, y);
    y += 16;

    // Manifold metrics
    if (r.manifold) {
      const m = r.manifold;
      doc.fontSize(9);
      doc.fillColor(m.boundaryEdges === 0 ? COLOR_PASS : COLOR_FAIL)
        .text(`Boundary edges: ${m.boundaryEdges}`, MARGIN, y);
      doc.fillColor(m.nonManifoldEdges === 0 ? COLOR_PASS : COLOR_FAIL)
        .text(`Non-manifold: ${m.nonManifoldEdges}`, MARGIN + 160, y);
      doc.fillColor(m.windingErrors === 0 ? COLOR_PASS : COLOR_KNOWN)
        .text(`Winding errors: ${m.windingErrors}`, MARGIN + 320, y);
      y += 12;
      doc.fillColor(r.topoBoundary === 0 ? COLOR_PASS : COLOR_FAIL)
        .text(`Topo boundary: ${r.topoBoundary}`, MARGIN, y);
      doc.fillColor('#555')
        .text(`Total mesh edges: ${m.totalEdges}`, MARGIN + 160, y);
      y += 12;
      // Triangle quality row
      doc.fillColor(r.sliverTriangles === 0 ? COLOR_PASS : COLOR_WARN)
        .text(`Sliver tris: ${r.sliverTriangles || 0}`, MARGIN, y);
      doc.fillColor(r.flippedNormals === 0 ? COLOR_PASS : COLOR_FAIL)
        .text(`Flipped normals: ${r.flippedNormals || 0}`, MARGIN + 160, y);
      doc.fillColor(r.degenerateTriangles === 0 ? COLOR_PASS : COLOR_WARN)
        .text(`Degenerate tris: ${r.degenerateTriangles || 0}`, MARGIN + 320, y);
      y += 16;
    }

    // --- Embed pre-rendered images into PDF ---
    const images = pre.images;

    if (images) {
      // Row 1: Standard view
      doc.fontSize(9).fillColor('#333').text('Standard View', MARGIN, y);
      y += 14;
      if (images.before) doc.image(images.before, MARGIN, y, { width: imgW, height: imgH });
      if (images.after) doc.image(images.after, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });
      y += imgH + 10;

      // Row 2: Feature preview (new feature faces highlighted in blue)
      if (y + imgH + 20 < PAGE_H - MARGIN && (images.featurePreview || images.featurePreviewAlt)) {
        doc.fontSize(9).fillColor('#333').text('Feature Preview — new feature faces in blue', MARGIN, y);
        y += 14;
        if (images.featurePreview) doc.image(images.featurePreview, MARGIN, y, { width: imgW, height: imgH });
        if (images.featurePreviewAlt) doc.image(images.featurePreviewAlt, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });
        y += imgH + 10;
      }

      // Row 3: Diagnostic view
      if (y + imgH + 20 >= PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
      doc.fontSize(9).fillColor('#333').text('Diagnostic View — wireframe + hatched flipped faces + boundary holes', MARGIN, y);
      y += 14;
      if (images.diagHatch) doc.image(images.diagHatch, MARGIN, y, { width: imgW, height: imgH });
      if (images.wireframe) doc.image(images.wireframe, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });
      y += imgH + 10;

      // Row 4: Alternate angles
      if (y + imgH + 20 >= PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
      doc.fontSize(9).fillColor('#333').text('Alternate Angles', MARGIN, y);
      y += 14;
      if (images.altRearLeft) doc.image(images.altRearLeft, MARGIN, y, { width: imgW, height: imgH });
      if (images.altFront) doc.image(images.altFront, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });

      // Console: show test status + key metrics
      const renderIcon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'known' ? '⚠' : '✗';
      const renderStatus = r.status.toUpperCase();
      const renderMetrics = [];
      if (r.manifold) {
        const m = r.manifold;
        if (m.boundaryEdges > 0) renderMetrics.push(`bnd=${m.boundaryEdges}`);
        if (m.windingErrors > 0) renderMetrics.push(`wind=${m.windingErrors}`);
        if (m.nonManifoldEdges > 0) renderMetrics.push(`nm=${m.nonManifoldEdges}`);
      }
      if (r.sliverTriangles > 0) renderMetrics.push(`sliver=${r.sliverTriangles}`);
      if (r.flippedNormals > 0) renderMetrics.push(`flipped=${r.flippedNormals}`);
      if (r.degenerateTriangles > 0) renderMetrics.push(`degen=${r.degenerateTriangles}`);
      const metricsSuffix = renderMetrics.length > 0 ? ` [${renderMetrics.join(', ')}]` : '';
      process.stdout.write(`  PDF [${i + 1}/${results.length}] ${renderIcon} ${renderStatus}${metricsSuffix}\n`);
    } else if (pre.error) {
      doc.fontSize(9).fillColor(COLOR_FAIL).text(`Render error: ${pre.error}`, MARGIN, y);
      process.stdout.write(`  PDF [${i + 1}/${results.length}] ✗ RENDER-ERROR (${pre.error})\n`);
    } else {
      process.stdout.write(`  PDF [${i + 1}/${results.length}] - (no geometry)\n`);
    }
    // Free image buffers after embedding in PDF
    preRendered[i] = null;
  }

  // ---- Final summary page ----
  doc.addPage();
  doc.fontSize(22).fillColor('#1a2744').text('Test Results Summary', MARGIN, MARGIN);
  doc.moveDown(1);

  const barTop = doc.y;
  const barW = PAGE_W - 2 * MARGIN;
  const passW = (passCount / results.length) * barW;
  const warnW = (warnCount / results.length) * barW;
  const knownW = (knownCount / results.length) * barW;
  const failW = (failCount / results.length) * barW;

  let barX = MARGIN;
  doc.rect(barX, barTop, passW, 30).fill(COLOR_PASS); barX += passW;
  if (warnW > 0) { doc.rect(barX, barTop, warnW, 30).fill(COLOR_WARN); barX += warnW; }
  doc.rect(barX, barTop, knownW, 30).fill(COLOR_KNOWN); barX += knownW;
  doc.rect(barX, barTop, failW || 0.5, 30).fill(COLOR_FAIL);

  barX = MARGIN;
  doc.fontSize(12).fillColor('#fff');
  if (passW > 40) { doc.text(`${passCount} Pass`, barX + 8, barTop + 8, { width: passW - 16 }); }
  barX += passW;
  if (warnW > 40) { doc.text(`${warnCount} Warn`, barX + 8, barTop + 8, { width: warnW - 16 }); }
  barX += warnW;
  if (knownW > 40) { doc.text(`${knownCount} Known`, barX + 8, barTop + 8, { width: knownW - 16 }); }
  barX += knownW;
  if (failW > 30) { doc.text(`${failCount} Fail`, barX + 4, barTop + 8, { width: failW - 8 }); }

  doc.moveDown(3);
  doc.fontSize(11).fillColor('#444');
  doc.text(`Total tests: ${results.length}`);
  doc.text(`Passed: ${passCount} (${((passCount / results.length) * 100).toFixed(1)}%)`);
  doc.text(`Warnings (pass with quality issues): ${warnCount} (${((warnCount / results.length) * 100).toFixed(1)}%)`);
  doc.text(`Failed: ${failCount} (${((failCount / results.length) * 100).toFixed(1)}%)`);
  doc.text(`Known edge cases: ${knownCount} (${((knownCount / results.length) * 100).toFixed(1)}%)`);
  doc.moveDown(1);

  // Aggregate quality metrics
  const totalWindingErrors = results.reduce((a, r) => a + (r.manifold?.windingErrors || 0), 0);
  const totalBoundaryEdges = results.reduce((a, r) => a + (r.manifold?.boundaryEdges || 0), 0);
  const totalDegenerateTris = results.reduce((a, r) => a + (r.degenerateTriangles || 0), 0);
  const totalSliverTris = results.reduce((a, r) => a + (r.sliverTriangles || 0), 0);
  const totalFlippedNormals = results.reduce((a, r) => a + (r.flippedNormals || 0), 0);
  doc.fontSize(11).fillColor('#333').text('Quality Metrics (across all tests):');
  doc.fontSize(10).fillColor(totalWindingErrors === 0 ? COLOR_PASS : COLOR_FAIL)
    .text(`  Total winding errors: ${totalWindingErrors}`);
  doc.fillColor(totalBoundaryEdges === 0 ? COLOR_PASS : COLOR_FAIL)
    .text(`  Total boundary edges: ${totalBoundaryEdges}`);
  doc.fillColor(totalDegenerateTris === 0 ? COLOR_PASS : COLOR_WARN)
    .text(`  Total degenerate triangles: ${totalDegenerateTris}`);
  doc.fillColor(totalSliverTris === 0 ? COLOR_PASS : COLOR_WARN)
    .text(`  Total sliver triangles (aspect ratio > 8:1): ${totalSliverTris}`);
  doc.fillColor(totalFlippedNormals === 0 ? COLOR_PASS : COLOR_FAIL)
    .text(`  Total flipped normals: ${totalFlippedNormals}`);
  doc.fillColor('#444');
  doc.text(`  Average volume removed: ${(results.filter(r => r.volumeError > 0).reduce((a, r) => a + r.volumeError, 0) / Math.max(1, results.filter(r => r.volumeError > 0).length)).toFixed(1)}%`);
  doc.text(`  Average face count increase: ${(results.filter(r => r.faceCountAfter > 0).reduce((a, r) => a + (r.faceCountAfter - r.faceCountBefore), 0) / Math.max(1, results.filter(r => r.faceCountAfter > 0).length)).toFixed(1)} faces`);

  if (warnCount > 0) {
    doc.moveDown(1);
    doc.fontSize(14).fillColor(COLOR_WARN).text('Warnings (pass with quality issues):');
    doc.fontSize(9).fillColor('#555');
    for (const r of results.filter(r => r.status === 'warn')) {
      doc.text(`• ${r.name}: ${r.warnings.join('; ')}`);
    }
  }

  if (failCount > 0) {
    doc.moveDown(1);
    doc.fontSize(14).fillColor(COLOR_FAIL).text('Unexpected Failures:');
    doc.fontSize(9).fillColor('#555');
    for (const r of results.filter(r => r.status === 'fail')) {
      const detail = r.error || (r.manifold ? `boundary=${r.manifold.boundaryEdges} winding=${r.manifold.windingErrors} nonManifold=${r.manifold.nonManifoldEdges}` : 'validation failed');
      doc.text(`• ${r.name}: ${detail}`);
    }
  }

  if (knownCount > 0) {
    doc.moveDown(1);
    doc.fontSize(14).fillColor(COLOR_KNOWN).text('Known Edge Cases:');
    doc.fontSize(9).fillColor('#555');
    for (const r of results.filter(r => r.status === 'known')) {
      const detail = r.error || (r.manifold ? `boundary=${r.manifold.boundaryEdges} winding=${r.manifold.windingErrors}` : 'known edge case');
      doc.text(`• ${r.name}: ${detail}`);
    }
  }

  // Finalize
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      const size = fs.statSync(outputPath).size;
      console.log(`\n✓ Report written to: ${outputPath} (${(size / 1024).toFixed(0)} KB)`);
      resolve();
    });
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let outputPath = path.join('tests', 'reports', 'nurbs-fillet-chamfer-variants.pdf');
let generateImages = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) outputPath = args[i + 1];
  if (args[i] === '--no-images') generateImages = false;
}

// Ensure output directory exists
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

generateReport(outputPath, { generateImages }).catch(err => {
  console.error('Report generation failed:', err.message);
  process.exit(1);
});
