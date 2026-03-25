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
      profiles.push({ points, closed: true });
    }

    // Build a combined list of traceable edges (segments, arcs, splines)
    // Each edge has p1 and p2 endpoints for tracing.
    const traceableEdges = [
      ...this.sketch.segments,
      ...this.sketch.arcs.map(arc => _arcAsEdge(arc)),
      ...this.sketch.splines,
    ];

    // Find all closed loops of connected edges in the sketch
    for (const edge of traceableEdges) {
      if (visited.has(edge.id || edge._arcId)) continue;
      
      const profile = this._traceProfileEdges(edge, traceableEdges, visited);
      if (profile && profile.closed) {
        profiles.push(profile);
      }
    }
    
    return profiles;
  }

  /**
   * Trace a profile starting from an edge, following connected edges
   * through matching p1/p2 endpoints.
   * @param {Object} startEdge - Starting edge (segment, arc-wrapper, or spline)
   * @param {Array} allEdges - All traceable edges
   * @param {Set} visited - Set of visited edge IDs
   * @returns {Object|null} Profile object or null
   */
  _traceProfileEdges(startEdge, allEdges, visited) {
    const points = [];
    const edgeId = e => e.id || e._arcId;
    
    let current = startEdge;
    let currentEnd = current.p2;      // PPoint: the end we're heading toward
    let prevEnd = current.p1;         // PPoint: the end we came from
    let startPoint = current.p1;      // PPoint: first point for closure check
    
    // Include the starting point of the profile
    points.push(startPoint);
    
    // Follow connected edges
    while (current) {
      if (visited.has(edgeId(current))) break;
      
      visited.add(edgeId(current));

      // Determine forward direction: does prevEnd match p1?
      const forward = (current.p1 === prevEnd);
      const edgePoints = _tessellateEdge(current, forward);
      // Skip the first point of each edge (it's already in the profile as the previous endpoint)
      for (let i = 1; i < edgePoints.length; i++) {
        points.push(edgePoints[i]);
      }
      
      // Find next connected edge
      const connected = allEdges.find(e => 
        !visited.has(edgeId(e)) && (e.p1 === currentEnd || e.p2 === currentEnd)
      );
      
      if (!connected) break;
      
      // Update for next iteration
      prevEnd = currentEnd;
      current = connected;
      currentEnd = (connected.p1 === prevEnd) ? connected.p2 : connected.p1;
      
      // Check if we closed the loop
      if (currentEnd === startPoint) {
        visited.add(edgeId(current));
        const closingForward = (current.p1 === prevEnd);
        const closingPoints = _tessellateEdge(current, closingForward);
        for (let i = 1; i < closingPoints.length; i++) {
          points.push(closingPoints[i]);
        }
        // Remove the duplicate closing point if it matches startPoint
        if (points.length > 1) {
          const last = points[points.length - 1];
          if (Math.abs(last.x - startPoint.x) < 1e-8 && Math.abs(last.y - startPoint.y) < 1e-8) {
            points.pop();
          }
        }
        return {
          points,
          closed: true,
        };
      }
    }
    
    // Not a closed loop
    return {
      points,
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
 * Wrap a PArc as a traceable edge with p1/p2 endpoints.
 * p1 = arc start, p2 = arc end. These are PPoint-like objects derived from
 * the arc's center, radius, and angles so the profile tracer can match them
 * against shared PPoint references from segments/splines.
 */
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

  // Fallback for unknown edge types
  return forward
    ? [{ x: edge.p1.x, y: edge.p1.y }, { x: edge.p2.x, y: edge.p2.y }]
    : [{ x: edge.p2.x, y: edge.p2.y }, { x: edge.p1.x, y: edge.p1.y }];
}
