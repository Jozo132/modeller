// js/cad/SketchFeature.js — Sketch as a parametric feature
// Wraps a Sketch object as a feature in the parametric tree

import { Feature } from './Feature.js';
import { Sketch } from './Sketch.js';

/**
 * SketchFeature represents a 2D sketch in the parametric feature tree.
 * The sketch defines 2D geometry on a plane that can be used by 3D operations.
 */
export class SketchFeature extends Feature {
  constructor(name = 'Sketch', sketch = null) {
    super(name);
    this.type = 'sketch';
    
    // The underlying sketch object
    this.sketch = sketch || new Sketch();
    this.sketch.name = name;
    
    // Sketch plane definition (for 3D positioning)
    this.plane = {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },  // Default: XY plane
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
    };
  }

  /**
   * Execute this sketch feature.
   * @param {Object} context - Execution context
   * @returns {Object} Result with sketch geometry
   */
  execute(context) {
    // Solve constraints in the sketch
    this.sketch.solve();
    
    // Return the sketch as the result
    return {
      type: 'sketch',
      sketch: this.sketch,
      plane: this.plane,
      profiles: this.extractProfiles(),
    };
  }

  /**
   * Extract closed profiles from the sketch for use in 3D operations.
   * A profile is a closed loop of connected segments/arcs/splines, or a circle.
   * @returns {Array} Array of profile objects
   */
  extractProfiles() {
    const profiles = [];
    const visited = new Set();
    
    // Handle circles as closed profiles (a circle is inherently a closed loop)
    for (const circle of this.sketch.circles) {
      const numPoints = 32;
      const points = [];
      for (let i = 0; i < numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        points.push({
          x: circle.center.x + Math.cos(angle) * circle.radius,
          y: circle.center.y + Math.sin(angle) * circle.radius,
        });
      }
      profiles.push({
        points,
        closed: true,
        edges: [{
          type: 'circle',
          center: { x: circle.center.x, y: circle.center.y },
          radius: circle.radius,
          pointCount: numPoints,
        }],
      });
    }

    // Handle self-closing splines (p1 === p2): they form their own closed profile
    for (const spl of this.sketch.splines) {
      if (spl.construction || !spl.visible) continue;
      if (spl.p1 && spl.p2 && spl.p1 === spl.p2) {
        visited.add(spl.id);
        const pts = spl.tessellate2D(32);
        if (pts.length >= 3) {
          // Remove the duplicate closing point if present
          const last = pts[pts.length - 1];
          const first = pts[0];
          if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) {
            pts.pop();
          }
          profiles.push({
            points: pts,
            edges: [{ type: 'spline', pointStartIndex: 0, pointCount: pts.length }],
            closed: true,
          });
        }
      }
    }

    // Handle self-closing beziers (p1 === p2): they form their own closed profile
    for (const bez of this.sketch.beziers) {
      if (bez.construction || !bez.visible) continue;
      if (bez.p1 && bez.p2 && bez.p1 === bez.p2) {
        visited.add(bez.id);
        const pts = bez.tessellate2D(16);
        if (pts.length >= 3) {
          const last = pts[pts.length - 1];
          const first = pts[0];
          if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) {
            pts.pop();
          }
          profiles.push({
            points: pts,
            edges: [{ type: 'bezier', pointStartIndex: 0, pointCount: pts.length }],
            closed: true,
          });
        }
      }
    }

    // Build a combined list of traceable edges (segments, arcs, splines, beziers)
    // Each edge has p1 and p2 endpoints for tracing.
    // Exclude self-closing curves (already handled above).
    const traceableEdges = [
      ...this.sketch.segments,
      ...this.sketch.arcs.map(arc => _arcAsEdge(arc)),
      ...this.sketch.splines.filter(spl => !visited.has(spl.id)),
      ...this.sketch.beziers.filter(bez => !visited.has(bez.id)),
    ];

    // Build spatial adjacency map for fast lookups and angle-based junction handling
    const adjMap = _buildAdjacencyMap(traceableEdges);

    // Find all closed loops of connected edges in the sketch
    for (const edge of traceableEdges) {
      if (visited.has(edge.id || edge._arcId)) continue;
      
      const profile = this._traceProfileEdges(edge, traceableEdges, visited, adjMap);
      if (profile && profile.closed) {
        profiles.push(profile);
      }
    }
    
    // Classify nesting: even nesting depth = solid outer, odd = hole
    _classifyProfileNesting(profiles);

    return profiles;
  }

  /**
   * Trace a profile starting from an edge, following connected edges
   * through matching p1/p2 endpoints.
   * Uses angle-based selection at junctions (degree ≥ 3 vertices) to
   * pick the tightest CW turn, which traces the minimal face boundary.
   * @param {Object} startEdge - Starting edge (segment, arc-wrapper, or spline)
   * @param {Array} allEdges - All traceable edges
   * @param {Set} visited - Set of visited edge IDs
   * @param {Object} adjMap - Adjacency map from _buildAdjacencyMap
   * @returns {Object|null} Profile object or null
   */
  _traceProfileEdges(startEdge, allEdges, visited, adjMap) {
    const points = [];
    const edges = [];
    const edgeId = e => e.id || e._arcId;
    
    let current = startEdge;
    let currentEnd = current.p2;
    let prevEnd = current.p1;
    let startPoint = current.p1;
    
    // Include the starting point of the profile
    points.push(startPoint);
    
    // Follow connected edges
    while (current) {
      if (visited.has(edgeId(current))) break;
      
      visited.add(edgeId(current));

      // Determine forward direction: does prevEnd match p1?
      const forward = _ptEq(current.p1, prevEnd);
      const edgePoints = _tessellateEdge(current, forward);
      const pointStartIndex = points.length - 1; // index of the shared start point
      // Skip the first point of each edge (it's already in the profile as the previous endpoint)
      for (let i = 1; i < edgePoints.length; i++) {
        points.push(edgePoints[i]);
      }
      edges.push(_buildEdgeMeta(current, forward, pointStartIndex, edgePoints.length));
      
      // Find next connected edge using adjacency map with angle-based selection
      const candidates = adjMap.getCandidates(currentEnd, visited, edgeId);
      
      let connected = null;
      if (candidates.length === 1) {
        connected = candidates[0].edge;
      } else if (candidates.length > 1) {
        // Junction: pick the edge making the tightest CW turn from the
        // incoming direction. This traces the minimal face boundary (the
        // face to the left of the directed edge).
        const backAngle = Math.atan2(prevEnd.y - currentEnd.y, prevEnd.x - currentEnd.x);
        let bestDelta = Infinity;
        for (const cand of candidates) {
          const outAngle = Math.atan2(cand.otherEnd.y - currentEnd.y, cand.otherEnd.x - currentEnd.x);
          // CW angular distance from back direction
          let delta = backAngle - outAngle;
          // Normalize to (0, 2π] — exclude exact reverse (delta ≈ 0)
          while (delta < 1e-9) delta += Math.PI * 2;
          while (delta > Math.PI * 2 + 1e-9) delta -= Math.PI * 2;
          if (delta < bestDelta) {
            bestDelta = delta;
            connected = cand.edge;
          }
        }
      }
      
      if (!connected) break;
      
      // Update for next iteration
      prevEnd = currentEnd;
      current = connected;
      currentEnd = _ptEq(connected.p1, prevEnd) ? connected.p2 : connected.p1;
      
      // Check if we closed the loop
      if (_ptEq(currentEnd, startPoint)) {
        visited.add(edgeId(current));
        const closingForward = _ptEq(current.p1, prevEnd);
        const closingPoints = _tessellateEdge(current, closingForward);
        const closingStartIndex = points.length - 1;
        for (let i = 1; i < closingPoints.length; i++) {
          points.push(closingPoints[i]);
        }
        edges.push(_buildEdgeMeta(current, closingForward, closingStartIndex, closingPoints.length));
        // Remove the duplicate closing point if it matches startPoint
        if (points.length > 1) {
          const last = points[points.length - 1];
          if (_ptEq(last, startPoint)) {
            points.pop();
          }
        }
        return {
          points,
          edges,
          closed: true,
        };
      }
    }
    
    // Not a closed loop
    return {
      points,
      edges,
      closed: false,
    };
  }

  /**
   * Set the sketch plane.
   * @param {Object} plane - Plane definition with origin, normal, xAxis, yAxis
   */
  setPlane(plane) {
    this.plane = { ...this.plane, ...plane };
    this.modified = new Date();
  }

  /**
   * Serialize this sketch feature.
   */
  serialize() {
    return {
      ...super.serialize(),
      sketch: this.sketch.serialize(),
      plane: this.plane,
    };
  }

  /**
   * Deserialize a sketch feature from JSON.
   */
  static deserialize(data) {
    const feature = new SketchFeature();
    if (!data) return feature;
    
    // Deserialize base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'sketch';
    
    // Deserialize sketch
    if (data.sketch) {
      feature.sketch = Sketch.deserialize(data.sketch);
    }
    
    // Deserialize plane
    if (data.plane) {
      feature.plane = data.plane;
    }
    
    return feature;
  }
}

// -----------------------------------------------------------------------
// Profile tracing helpers
// -----------------------------------------------------------------------

/**
 * Classify an array of closed profiles by nesting depth using even-odd rule.
 * Each profile gets:
 *   - `nestingDepth` (0 = outermost, 1 = first hole, 2 = island inside hole, etc.)
 *   - `isHole` (true if nestingDepth is odd)
 *   - `parentIndex` (index of the immediate parent profile, or -1)
 *   - `holes` (array of child profile indices that are direct holes of this profile)
 */
function _classifyProfileNesting(profiles) {
  if (profiles.length <= 1) {
    for (const p of profiles) {
      p.nestingDepth = 0;
      p.isHole = false;
      p.parentIndex = -1;
      p.holes = [];
    }
    return;
  }

  // Compute signed area and a representative interior point for each profile
  const meta = profiles.map((profile, idx) => {
    const pts = profile.points;
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    area *= 0.5;
    // Use the midpoint of the first edge, nudged inward via the edge normal
    const p0 = pts[0], p1 = pts[1 % pts.length];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    // Inward normal depends on winding; for CCW (area>0) inward is to the right
    const sign = area >= 0 ? 1 : -1;
    const testPt = {
      x: (p0.x + p1.x) / 2 + sign * dy / len * 1e-6,
      y: (p0.y + p1.y) / 2 - sign * dx / len * 1e-6,
    };
    return { idx, absArea: Math.abs(area), testPt };
  });

  // For each profile, count how many other profiles contain its test point
  // and find the direct parent (smallest containing profile)
  for (const m of meta) {
    let depth = 0;
    let bestParent = -1;
    let bestParentArea = Infinity;
    for (const other of meta) {
      if (other.idx === m.idx) continue;
      if (_pointInPolygon(m.testPt, profiles[other.idx].points)) {
        depth++;
        if (other.absArea < bestParentArea) {
          bestParentArea = other.absArea;
          bestParent = other.idx;
        }
      }
    }

    profiles[m.idx].nestingDepth = depth;
    profiles[m.idx].isHole = (depth % 2) === 1;
    profiles[m.idx].parentIndex = bestParent;
    profiles[m.idx].holes = [];
  }

  // Build holes arrays: each outer profile's direct holes
  for (let i = 0; i < profiles.length; i++) {
    const pi = profiles[i].parentIndex;
    if (pi >= 0 && profiles[i].isHole) {
      profiles[pi].holes.push(i);
    }
  }
}

/**
 * Build a spatial adjacency map for fast edge lookups at vertices.
 * Groups edges by quantized endpoint coordinates so that getCandidates()
 * is O(degree) instead of O(n) at each vertex.
 * @param {Array} edges - All traceable edges (segments, arc-wrappers, splines)
 * @returns {{getCandidates: Function}} Adjacency map with lookup method
 */
function _buildAdjacencyMap(edges) {
  const cellSize = 1e-4; // must be > PT_TOL to group nearby points
  const grid = new Map();
  const ckey = (x, y) => `${Math.round(x / cellSize)},${Math.round(y / cellSize)}`;

  for (const edge of edges) {
    const eid = edge.id || edge._arcId;
    // Register both directions of each edge
    for (const [thisEnd, otherEnd] of [[edge.p1, edge.p2], [edge.p2, edge.p1]]) {
      const key = ckey(thisEnd.x, thisEnd.y);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ edge, eid, thisEnd, otherEnd });
    }
  }

  return {
    /**
     * Get all unvisited edge candidates at a given vertex.
     * @param {{x:number,y:number}} pt - Vertex position
     * @param {Set} visitedSet - Set of visited edge IDs
     * @param {Function} edgeIdFn - Function to extract edge ID
     * @returns {Array<{edge, otherEnd}>}
     */
    getCandidates(pt, visitedSet, edgeIdFn) {
      const cx = Math.round(pt.x / cellSize);
      const cy = Math.round(pt.y / cellSize);
      const result = [];
      // Check this cell and 8 neighbours to handle boundary tolerance
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const entries = grid.get(`${cx + dx},${cy + dy}`);
          if (!entries) continue;
          for (const entry of entries) {
            if (visitedSet.has(entry.eid)) continue;
            if (_ptEq(entry.thisEnd, pt)) {
              result.push(entry);
            }
          }
        }
      }
      return result;
    }
  };
}

/**
 * Point-in-polygon test using ray casting (even-odd rule).
 */
function _pointInPolygon(pt, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Wrap a PArc as a traceable edge with p1/p2 endpoints.
 * p1 = arc start, p2 = arc end. These are PPoint-like objects derived from
 * the arc's center, radius, and angles so the profile tracer can match them
 * against shared PPoint references from segments/splines.
 */
const PT_TOL = 1e-6;

function _ptEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < PT_TOL && Math.abs(a.y - b.y) < PT_TOL;
}

function _arcAsEdge(arc) {
  // Use the actual center PPoint to derive start/end positions.
  // For profile tracing to work, arcs need to share PPoints with other edges.
  // We create lightweight point-like proxies that the tracer can use.
  const sp = arc.startPt;
  const ep = arc.endPt;
  return {
    _arcId: arc.id,
    id: arc.id,
    type: 'arc',
    arc,
    // p1/p2 must be the PPoint objects shared with connecting edges.
    // Since arcs in this sketch system don't store endpoint PPoints directly,
    // we need to find the nearest scene point for each endpoint.
    p1: _findMatchingPoint(arc, sp),
    p2: _findMatchingPoint(arc, ep),
  };
}

/** Find the point in the arc's center's parent that matches (px, py). */
function _findMatchingPoint(arc, pt) {
  // Return a lightweight point-like object for matching.
  // Profile tracing compares by object identity (===), so arcs won't connect
  // to segments unless they share actual PPoint references. For now, return
  // a coordinate-only proxy. The profile tracer already falls back to
  // coordinate comparison.
  return { x: pt.x, y: pt.y, _proxyFor: arc.id };
}

/**
 * Build edge metadata for a traced edge, preserving exact geometry info.
 * @param {Object} edge - The traceable edge (segment, arc-wrapper, or spline)
 * @param {boolean} forward - Traversal direction
 * @param {number} pointStartIndex - Index in the profile points array where this edge starts
 * @param {number} pointCount - Number of tessellation points for this edge (including start)
 * @returns {Object} Edge metadata
 */
function _buildEdgeMeta(edge, forward, pointStartIndex, pointCount) {
  const meta = {
    type: edge.type || 'segment',
    pointStartIndex,
    pointCount,
  };
  if (edge.type === 'arc' && edge.arc) {
    const arc = edge.arc;
    let startAngle = arc.startAngle;
    let endAngle = arc.endAngle;
    let sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    meta.center = { x: arc.center.x, y: arc.center.y };
    meta.radius = arc.radius;
    meta.startAngle = forward ? startAngle : startAngle + sweep;
    meta.sweepAngle = forward ? sweep : -sweep;
  }
  return meta;
}

/**
 * Tessellate an edge (segment, arc-wrapper, or spline) into 2D points.
 * @param {Object} edge - The traceable edge
 * @param {boolean} forward - true if traversing p1→p2, false if p2→p1
 * @returns {Array<{x: number, y: number}>} - Array of 2D points including start and end
 */
function _tessellateEdge(edge, forward) {
  if (edge.type === 'segment') {
    // Segments are straight lines: just start and end
    return forward
      ? [{ x: edge.p1.x, y: edge.p1.y }, { x: edge.p2.x, y: edge.p2.y }]
      : [{ x: edge.p2.x, y: edge.p2.y }, { x: edge.p1.x, y: edge.p1.y }];
  }

  if (edge.type === 'arc' && edge.arc) {
    // Arc: tessellate into polyline
    const arc = edge.arc;
    const numSegs = 16;
    let startA = arc.startAngle;
    let endA = arc.endAngle;
    let sweep = endA - startA;
    if (sweep <= 0) sweep += Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= numSegs; i++) {
      const a = startA + (i / numSegs) * sweep;
      pts.push({
        x: arc.center.x + Math.cos(a) * arc.radius,
        y: arc.center.y + Math.sin(a) * arc.radius,
      });
    }
    return forward ? pts : pts.reverse();
  }

  if (edge.type === 'spline') {
    // Spline: tessellate using the spline's own method
    const pts = edge.tessellate2D(32);
    return forward ? pts : [...pts].reverse();
  }

  if (edge.type === 'bezier') {
    // Bezier: tessellate using the bezier's own method
    const pts = edge.tessellate2D(16);
    return forward ? pts : [...pts].reverse();
  }

  // Fallback for unknown edge types
  return forward
    ? [{ x: edge.p1.x, y: edge.p1.y }, { x: edge.p2.x, y: edge.p2.y }]
    : [{ x: edge.p2.x, y: edge.p2.y }, { x: edge.p1.x, y: edge.p1.y }];
}
