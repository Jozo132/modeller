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
      points = this._sampleCurve(edge.curve, segments);
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
   * Sample a NURBS curve uniformly.
   * @private
   */
  _sampleCurve(curve, segments) {
    const pts = [];
    const uMin = curve.knots[0];
    const uMax = curve.knots[curve.knots.length - 1];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const u = uMin + t * (uMax - uMin);
      const result = GeometryEvaluator.evalCurve(curve, u);
      pts.push({ x: result.p.x, y: result.p.y, z: result.p.z });
    }
    return pts;
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
