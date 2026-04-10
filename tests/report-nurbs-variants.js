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
import { createCanvas } from '@napi-rs/canvas';

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

  // Parametric sweep
  for (const size of [0.5, 1.0, 2.0, 3.0]) {
    for (const op of ['chamfer', 'fillet']) {
      variants.push({
        name: `Rectangle ${op} size=${size} on top edge`,
        profile: rectangleProfile(20, 10), extrudeHeight: 10,
        edgeSelector: 'topHorizontal', operation: op, param: size,
        surfacePairing: 'PLANE+PLANE',
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
// Test execution + data collection
// ---------------------------------------------------------------------------

function selectEdge(topo, selector, extrudeHeight) {
  if (selector === 'topHorizontal') return EdgeSelectors.topHorizontal(topo, extrudeHeight);
  if (selector === 'bottomHorizontal') return EdgeSelectors.bottomHorizontal(topo);
  if (selector === 'vertical') return EdgeSelectors.vertical(topo);
  if (selector === 'bsplineTop') return EdgeSelectors.bsplineTop(topo, extrudeHeight);
  return null;
}

function runVariant(variant) {
  const result = {
    name: variant.name,
    operation: variant.operation,
    surfacePairing: variant.surfacePairing,
    param: variant.param,
    knownEdgeCase: variant.knownEdgeCase || false,
    status: 'error',
    error: null,
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
  };

  try {
    const part = buildPart(variant.profile, variant.extrudeHeight);
    const geom = getGeom(part);
    const topo = geom.topoBody;
    if (!topo) { result.error = 'No topoBody from extrude'; return result; }

    const edge = selectEdge(topo, variant.edgeSelector, variant.extrudeHeight);
    if (!edge) { result.error = `Edge selector '${variant.edgeSelector}' found nothing`; return result; }

    const edgeKey = edgeKeyFromVerts(edge.startVertex.point, edge.endVertex.point);
    result.edgeKey = edgeKey;
    result.beforeGeom = geom;
    result.volumeBefore = calculateMeshVolume(geom);
    result.faceCountBefore = geom.faces?.length || 0;
    result.triCountBefore = countTriangles(geom);

    let afterGeom;
    if (variant.operation === 'chamfer') {
      afterGeom = applyBRepChamfer(geom, [edgeKey], variant.param);
    } else {
      afterGeom = applyBRepFillet(geom, [edgeKey], variant.param, 4);
    }

    if (!afterGeom) { result.error = 'Operation returned null'; return result; }

    result.afterGeom = afterGeom;
    result.volumeAfter = calculateMeshVolume(afterGeom);
    result.faceCountAfter = afterGeom.faces?.length || 0;
    result.triCountAfter = countTriangles(afterGeom);
    result.manifold = checkManifold(afterGeom);
    result.topoBoundary = afterGeom.topoBody ? countBoundaryEdges(afterGeom.topoBody) : -1;

    // Volume error
    if (result.volumeBefore > 0) {
      result.volumeError = ((result.volumeBefore - result.volumeAfter) / result.volumeBefore) * 100;
    }

    // Determine status
    const hasBspline = (variant.surfacePairing || '').includes('BSPLINE');
    const m = result.manifold;
    const pass = m.boundaryEdges === 0 && m.nonManifoldEdges === 0 &&
      (hasBspline || m.windingErrors === 0) &&
      result.topoBoundary === 0 &&
      result.volumeAfter < result.volumeBefore &&
      result.volumeAfter > result.volumeBefore * 0.1;

    result.status = pass ? 'pass' : (variant.knownEdgeCase ? 'known' : 'fail');
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
  return canvas.encode('png');
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

// ---------------------------------------------------------------------------
// PDF report generation
// ---------------------------------------------------------------------------

/**
 * Render all 6 sub-images for a single test result, returning PNG buffers.
 * Shared by both PDF embedding and standalone composite image generation.
 */
async function renderTestImages(r, cellW, cellH) {
  const images = { before: null, after: null, diagHatch: null, wireframe: null, altRearLeft: null, altFront: null };
  if (!r.beforeGeom) return images;

  const w = Math.round(cellW * 2);
  const h = Math.round(cellH * 2);

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

    const diagGeom = r.afterGeom;
    images.diagHatch = await renderGeometryToPngBuffer(diagGeom, {
      width: w, height: h,
      diagnosticHatch: true,
      meshOverlay: true,
      label: 'Diagnostic hatch (red = flipped, pink boundary = holes)',
    });

    images.wireframe = await renderGeometryToPngBuffer(diagGeom, {
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
 * Layout: header with title/metrics, then 3 rows × 2 columns of images.
 */
async function composeTestImage(r, images, index, total) {
  const cellW = CELL_W * 2;   // use high-res cell size
  const cellH = Math.round(cellW * 0.75);
  const cols = 2;
  const rows = 3;
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
  const statusColor = r.status === 'pass' ? '#4caf50' : r.status === 'known' ? '#ff9800' : '#f44336';
  const statusText = r.status === 'pass' ? 'PASS' : r.status === 'known' ? 'KNOWN EDGE CASE' : 'FAIL';
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
  if (r.error) volLine.push(`Error: ${r.error}`);
  ctx.fillText(volLine.join('  |  '), COMP_PADDING, 68);

  // Draw image grid: 3 rows × 2 cols
  const rowLabels = ['Standard View', 'Diagnostic View', 'Alternate Angles'];
  const imageGrid = [
    [images.before, images.after],
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
        const { Image } = await import('@napi-rs/canvas');
        const img = new Image();
        img.src = buf;
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

  return canvas.encode('png');
}

// ---------------------------------------------------------------------------
// PDF report generation
// ---------------------------------------------------------------------------

async function generateReport(outputPath, { generateImages = true } = {}) {
  console.log('=== NURBS Fillet/Chamfer Variant Report ===\n');

  // Collect all variants
  const variants = buildSingleOpVariants();
  console.log(`Running ${variants.length} test variants...\n`);

  // Run all tests and collect results
  const results = [];
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    process.stdout.write(`  [${i + 1}/${variants.length}] ${variant.name}... `);
    const result = runVariant(variant);
    results.push(result);
    const icon = result.status === 'pass' ? '✓' : result.status === 'known' ? '⚠' : '✗';
    console.log(icon);
  }

  // Summary counts
  const passCount = results.filter(r => r.status === 'pass').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  const knownCount = results.filter(r => r.status === 'known').length;

  console.log(`\nResults: ${passCount} passed, ${failCount} failed, ${knownCount} known edge cases`);
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
    .text(`${results.length} tests — ${passCount} passed, ${failCount} failed, ${knownCount} known edge cases`, { align: 'center', width: PAGE_W - 2 * MARGIN });

  doc.moveDown(4);
  doc.fontSize(11).fillColor('#667799')
    .text('Surface pairings: PLANE+PLANE, PLANE+BSPLINE, BSPLINE+BSPLINE', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Dihedral angles: 45° 60° 70° 90° 108° 110° 117° 120°', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Profiles: Rectangle, Trapezoid, Parallelogram, Triangle, Pentagon, Spline, Bezier, Lens', { align: 'center', width: PAGE_W - 2 * MARGIN })
    .text('Operations: Chamfer, Fillet — sizes 0.3 through 3.0', { align: 'center', width: PAGE_W - 2 * MARGIN });

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
        color = r.status === 'pass' ? COLOR_PASS : r.status === 'known' ? COLOR_KNOWN : COLOR_FAIL;
      }
      doc.fillColor(color).text(cells[j], cx + 3, ry + 3, { width: colWidths[j] - 6, lineBreak: false, align: 'left' });
      cx += colWidths[j];
    }
    ry += 14;
  }

  // ---- Individual test pages ----
  const imagesDir = path.join(path.dirname(outputPath), 'images');
  if (generateImages) {
    fs.mkdirSync(imagesDir, { recursive: true });
    console.log(`Saving standalone images to: ${imagesDir}/`);
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    process.stdout.write(`  Rendering [${i + 1}/${results.length}] ${r.name}... `);

    doc.addPage();

    // Test header
    const statusColor = r.status === 'pass' ? COLOR_PASS : r.status === 'known' ? COLOR_KNOWN : COLOR_FAIL;
    const statusText = r.status === 'pass' ? 'PASS' : r.status === 'known' ? 'KNOWN EDGE CASE' : 'FAIL';

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
      y += 16;
    }

    // --- Render images (shared between PDF and standalone) ---
    const imgW = (PAGE_W - 2 * MARGIN - IMG_GAP) / 2;
    const imgH = imgW * 0.75;

    if (r.beforeGeom) {
      try {
        const images = await renderTestImages(r, imgW, imgH);

        // Row 1: Standard view
        doc.fontSize(9).fillColor('#333').text('Standard View', MARGIN, y);
        y += 14;
        if (images.before) doc.image(images.before, MARGIN, y, { width: imgW, height: imgH });
        if (images.after) doc.image(images.after, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });
        y += imgH + 10;

        // Row 2: Diagnostic view
        if (y + imgH + 20 < PAGE_H - MARGIN) {
          doc.fontSize(9).fillColor('#333').text('Diagnostic View — wireframe + hatched flipped faces + boundary holes', MARGIN, y);
          y += 14;
          if (images.diagHatch) doc.image(images.diagHatch, MARGIN, y, { width: imgW, height: imgH });
          if (images.wireframe) doc.image(images.wireframe, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });
          y += imgH + 10;
        }

        // Row 3: Alternate angles
        if (y + imgH + 20 < PAGE_H - MARGIN) {
          doc.fontSize(9).fillColor('#333').text('Alternate Angles', MARGIN, y);
          y += 14;
          if (images.altRearLeft) doc.image(images.altRearLeft, MARGIN, y, { width: imgW, height: imgH });
          if (images.altFront) doc.image(images.altFront, MARGIN + imgW + IMG_GAP, y, { width: imgW, height: imgH });
        }

        // Generate standalone composite image
        if (generateImages) {
          const composite = await composeTestImage(r, images, i, results.length);
          const slug = r.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
          const imgPath = path.join(imagesDir, `${String(i + 1).padStart(2, '0')}-${slug}.png`);
          fs.writeFileSync(imgPath, composite);
        }

        console.log('✓');
      } catch (renderErr) {
        doc.fontSize(9).fillColor(COLOR_FAIL).text(`Render error: ${renderErr.message}`, MARGIN, y);
        console.log(`✗ (${renderErr.message})`);
      }
    } else {
      console.log('- (no geometry)');
    }
  }

  // ---- Final summary page ----
  doc.addPage();
  doc.fontSize(22).fillColor('#1a2744').text('Test Results Summary', MARGIN, MARGIN);
  doc.moveDown(1);

  const barTop = doc.y;
  const barW = PAGE_W - 2 * MARGIN;
  const passW = (passCount / results.length) * barW;
  const knownW = (knownCount / results.length) * barW;
  const failW = (failCount / results.length) * barW;

  doc.rect(MARGIN, barTop, passW, 30).fill(COLOR_PASS);
  doc.rect(MARGIN + passW, barTop, knownW, 30).fill(COLOR_KNOWN);
  doc.rect(MARGIN + passW + knownW, barTop, failW || 0.5, 30).fill(COLOR_FAIL);

  doc.fontSize(12).fillColor('#fff');
  if (passW > 40) doc.text(`${passCount} Pass`, MARGIN + 8, barTop + 8, { width: passW - 16 });
  if (knownW > 40) doc.text(`${knownCount} Known`, MARGIN + passW + 8, barTop + 8, { width: knownW - 16 });
  if (failW > 30) doc.text(`${failCount} Fail`, MARGIN + passW + knownW + 4, barTop + 8, { width: failW - 8 });

  doc.moveDown(3);
  doc.fontSize(11).fillColor('#444');
  doc.text(`Total tests: ${results.length}`);
  doc.text(`Passed: ${passCount} (${((passCount / results.length) * 100).toFixed(1)}%)`);
  doc.text(`Failed: ${failCount} (${((failCount / results.length) * 100).toFixed(1)}%)`);
  doc.text(`Known edge cases: ${knownCount} (${((knownCount / results.length) * 100).toFixed(1)}%)`);
  doc.moveDown(1);
  doc.text(`Average volume removed: ${(results.filter(r => r.volumeError > 0).reduce((a, r) => a + r.volumeError, 0) / Math.max(1, results.filter(r => r.volumeError > 0).length)).toFixed(1)}%`);
  doc.text(`Average face count increase: ${(results.filter(r => r.faceCountAfter > 0).reduce((a, r) => a + (r.faceCountAfter - r.faceCountBefore), 0) / Math.max(1, results.filter(r => r.faceCountAfter > 0).length)).toFixed(1)} faces`);

  if (failCount > 0) {
    doc.moveDown(1);
    doc.fontSize(14).fillColor(COLOR_FAIL).text('Unexpected Failures:');
    doc.fontSize(9).fillColor('#555');
    for (const r of results.filter(r => r.status === 'fail')) {
      doc.text(`• ${r.name}: ${r.error || 'validation failed'}`);
    }
  }

  if (knownCount > 0) {
    doc.moveDown(1);
    doc.fontSize(14).fillColor(COLOR_KNOWN).text('Known BSPLINE Edge Cases:');
    doc.fontSize(9).fillColor('#555');
    for (const r of results.filter(r => r.status === 'known')) {
      doc.text(`• ${r.name}: ${r.error || 'known edge case'}`);
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
