// js/cad/Tessellator2/EdgeSampler.js — Shared edge sampling with caching

import { GeometryEvaluator } from '../GeometryEvaluator.js';

/**
 * Generate a cache key for an edge + config combination.
 */
function edgeCacheKey(edgeId, segments) {
  return `${edgeId}:${segments}`;
}

function isSimpleLineCurve(curve) {
  return !!curve
    && curve.degree === 1
    && Array.isArray(curve.controlPoints)
    && curve.controlPoints.length === 2;
}

function _dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/**
 * EdgeSampler — samples each topological edge exactly once per config
 * and caches results. Adjacent faces sharing an edge reuse identical
 * boundary vertex arrays instead of resampling independently.
 */
export class EdgeSampler {
  constructor() {
    /** @type {Map<string, Array<{x:number,y:number,z:number}>>} */
    this._cache = new Map();
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Clear the sample cache.
   */
  clear() {
    this._cache.clear();
  }

  /**
   * Sample an edge with the given number of segments.
   * Returns cached results if available.
   *
   * @param {import('../BRepTopology.js').TopoEdge} edge
   * @param {number} segments
   * @returns {Array<{x:number,y:number,z:number}>} Points from startVertex to endVertex
   */
  sampleEdge(edge, segments) {
    const key = edgeCacheKey(edge.id, segments);
    if (this._cache.has(key)) {
      this._hits++;
      return this._cache.get(key);
    }

    this._misses++;
    let points;
    if (isSimpleLineCurve(edge.curve)) {
      points = this._sampleLinear(edge.startVertex.point, edge.endVertex.point, 1);
    } else if (edge.curve) {
      points = this._sampleCurve(edge.curve, segments, edge.startVertex.point, edge.endVertex.point);
    } else {
      points = this._sampleLinear(edge.startVertex.point, edge.endVertex.point, segments);
    }

    // Tag shared boundary samples so removeCollinearPoints preserves the
    // exact edge discretization on every adjacent face. Curved shared edges
    // are especially sensitive: if one face drops intermediate samples and
    // the other keeps them, MeshStitcher sees T-junctions and leaves holes.
    if (points.length > 0) {
      points[0]._isVertex = true;
      points[points.length - 1]._isVertex = true;
      if (edge.curve && !isSimpleLineCurve(edge.curve)) {
        for (const point of points) point._preserveBoundarySample = true;
      }
    }

    this._cache.set(key, points);
    return points;
  }

  /** Return cache statistics. */
  get stats() {
    return { hits: this._hits, misses: this._misses, cached: this._cache.size };
  }

  /**
   * Get samples for a coedge, respecting orientation.
   * If sameSense is false, the samples are returned in reverse order.
   *
   * @param {import('../BRepTopology.js').TopoCoEdge} coedge
   * @param {number} segments
   * @returns {Array<{x:number,y:number,z:number}>}
   */
  sampleCoEdge(coedge, segments) {
    const forwardSamples = this.sampleEdge(coedge.edge, segments);
    if (coedge.sameSense) {
      return forwardSamples;
    }
    // Return a reversed shallow copy — same point objects, reversed order
    return [...forwardSamples].reverse();
  }

  /**
   * Sample a NURBS curve uniformly between the edge vertex positions.
   *
   * The curve's knot domain may extend beyond the trim defined by the
   * edge vertices (common for B-spline EDGE_CURVE in STEP).  Find the
   * parameter values corresponding to the start/end vertex positions and
   * sample only that sub-range.  The first and last samples are set to
   * the exact vertex positions to guarantee watertight stitching.
   *
   * @param {Object} curve
   * @param {number} segments
   * @param {{x:number,y:number,z:number}} [startPt] - Edge start vertex position
   * @param {{x:number,y:number,z:number}} [endPt] - Edge end vertex position
   * @returns {Array<{x:number,y:number,z:number}>}
   * @private
   */
  _sampleCurve(curve, segments, startPt, endPt) {
    const uMin = curve.knots[0];
    const uMax = curve.knots[curve.knots.length - 1];

    let tStart = uMin;
    let tEnd = uMax;

    // If vertex positions are provided, find the curve parameters that
    // correspond to them.  This handles trimmed B-spline edge curves
    // where the knot domain is larger than the edge.
    if (startPt || endPt) {
      const evalStart = GeometryEvaluator.evalCurve(curve, uMin);
      const evalEnd = GeometryEvaluator.evalCurve(curve, uMax);

      const needsTrim = (startPt && endPt) && (
        _dist3D(evalStart.p, startPt) > 1e-4 || _dist3D(evalEnd.p, endPt) > 1e-4
      );

      if (needsTrim) {
        // Find parameter for startPt — sample curve and find closest
        tStart = this._findCurveParam(curve, startPt, uMin, uMax);
        tEnd = this._findCurveParam(curve, endPt, uMin, uMax);

        // Ensure tStart < tEnd (swap if reversed)
        if (tStart > tEnd) {
          const tmp = tStart;
          tStart = tEnd;
          tEnd = tmp;
          // If swapped, we need to reverse the startPt/endPt too
          const tmpPt = startPt;
          startPt = endPt;
          endPt = tmpPt;
        }
      }
    }

    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const u = tStart + t * (tEnd - tStart);
      const result = GeometryEvaluator.evalCurve(curve, u);
      pts.push({ x: result.p.x, y: result.p.y, z: result.p.z });
    }

    // Snap first and last samples to exact vertex positions for watertight mesh
    if (startPt && pts.length > 0) {
      pts[0].x = startPt.x;
      pts[0].y = startPt.y;
      pts[0].z = startPt.z;
    }
    if (endPt && pts.length > 1) {
      pts[pts.length - 1].x = endPt.x;
      pts[pts.length - 1].y = endPt.y;
      pts[pts.length - 1].z = endPt.z;
    }

    return pts;
  }

  /**
   * Find the parameter value on a curve closest to a 3D point.
   * Uses coarse sampling followed by bisection refinement.
   *
   * @param {Object} curve
   * @param {{x:number,y:number,z:number}} target
   * @param {number} uMin
   * @param {number} uMax
   * @returns {number}
   * @private
   */
  _findCurveParam(curve, target, uMin, uMax) {
    // Coarse sampling
    const nSamples = 64;
    let bestU = uMin;
    let bestDist = Infinity;
    for (let i = 0; i <= nSamples; i++) {
      const u = uMin + (i / nSamples) * (uMax - uMin);
      const p = GeometryEvaluator.evalCurve(curve, u).p;
      const d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2 + (p.z - target.z) ** 2;
      if (d < bestDist) { bestDist = d; bestU = u; }
    }

    // Bisection refinement
    const step = (uMax - uMin) / nSamples;
    let lo = Math.max(uMin, bestU - step);
    let hi = Math.min(uMax, bestU + step);
    for (let iter = 0; iter < 20; iter++) {
      const uA = (2 * lo + hi) / 3;
      const uB = (lo + 2 * hi) / 3;
      const pA = GeometryEvaluator.evalCurve(curve, uA).p;
      const pB = GeometryEvaluator.evalCurve(curve, uB).p;
      const dA = (pA.x - target.x) ** 2 + (pA.y - target.y) ** 2 + (pA.z - target.z) ** 2;
      const dB = (pB.x - target.x) ** 2 + (pB.y - target.y) ** 2 + (pB.z - target.z) ** 2;
      if (dA < dB) hi = uB; else lo = uA;
    }

    return (lo + hi) / 2;
  }

  /**
   * Linearly interpolate between two points.
   * @private
   */
  _sampleLinear(start, end, segments) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      pts.push({
        x: start.x + t * (end.x - start.x),
        y: start.y + t * (end.y - start.y),
        z: start.z + t * (end.z - start.z),
      });
    }
    return pts;
  }
}
