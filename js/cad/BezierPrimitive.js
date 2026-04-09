// js/cad/BezierPrimitive.js — A bezier curve (cubic/quadratic) with per-vertex tangent handles
import { Primitive } from './Primitive.js';

const _DASH_PATTERNS = { 'dashed': [10, 5], 'dash-dot': [12, 4, 2, 4], 'dotted': [2, 4] };
function _constructionDash(style) { return _DASH_PATTERNS[style] || _DASH_PATTERNS['dashed']; }

/**
 * PBezier — A piecewise cubic/quadratic bezier curve defined by vertices with
 * optional tangent handles. Each vertex is a PPoint. Between consecutive
 * vertices, the curve is:
 *   - cubic  if both tangent handles are present,
 *   - quadratic if exactly one handle is present,
 *   - linear if neither handle is present.
 *
 * Tangent handles are stored as offsets (dx, dy) relative to each vertex.
 * A per-vertex `tangent` flag controls whether the handle is active.
 *
 * Endpoints: this.vertices[0].point  and  this.vertices[last].point
 */
export class PBezier extends Primitive {
  /**
   * @param {Array<{point: PPoint, handleIn?: {dx:number,dy:number}, handleOut?: {dx:number,dy:number}, tangent?: boolean}>} vertices
   *        At least 2 vertex descriptors. Each has a PPoint and optional handle offsets.
   */
  constructor(vertices) {
    super('bezier');
    if (!vertices || vertices.length < 2) {
      throw new Error('PBezier requires at least 2 vertices');
    }
    this.vertices = vertices.map(v => ({
      point: v.point,
      handleIn: v.handleIn ? { dx: v.handleIn.dx || 0, dy: v.handleIn.dy || 0 } : null,
      handleOut: v.handleOut ? { dx: v.handleOut.dx || 0, dy: v.handleOut.dy || 0 } : null,
      tangent: v.tangent !== false, // true = smooth tangent (in/out handles are mirrored)
    }));
  }

  /** All PPoints referenced by this bezier (for constraint solver). */
  get points() { return this.vertices.map(v => v.point); }

  /** First endpoint (for profile tracing) */
  get p1() { return this.vertices[0].point; }
  /** Last endpoint (for profile tracing) */
  get p2() { return this.vertices[this.vertices.length - 1].point; }

  // -----------------------------------------------------------------------
  // Segment evaluation
  // -----------------------------------------------------------------------

  /**
   * Get the number of bezier segments (one between each pair of consecutive vertices).
   */
  get segmentCount() { return this.vertices.length - 1; }

  /**
   * Evaluate a point on segment `segIdx` at parameter t ∈ [0,1].
   * Uses cubic bezier: B(t) = (1-t)³P0 + 3(1-t)²tC1 + 3(1-t)t²C2 + t³P3
   * Falls back to quadratic or linear when handles are absent.
   */
  evaluateSegment(segIdx, t) {
    const v0 = this.vertices[segIdx];
    const v1 = this.vertices[segIdx + 1];
    const p0x = v0.point.x, p0y = v0.point.y;
    const p3x = v1.point.x, p3y = v1.point.y;

    const ho = v0.handleOut;
    const hi = v1.handleIn;

    if (ho && hi) {
      // Cubic bezier
      const c1x = p0x + ho.dx, c1y = p0y + ho.dy;
      const c2x = p3x + hi.dx, c2y = p3y + hi.dy;
      const mt = 1 - t;
      return {
        x: mt * mt * mt * p0x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * p3x,
        y: mt * mt * mt * p0y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * p3y,
      };
    } else if (ho) {
      // Quadratic (only outgoing handle)
      const cx = p0x + ho.dx, cy = p0y + ho.dy;
      const mt = 1 - t;
      return {
        x: mt * mt * p0x + 2 * mt * t * cx + t * t * p3x,
        y: mt * mt * p0y + 2 * mt * t * cy + t * t * p3y,
      };
    } else if (hi) {
      // Quadratic (only incoming handle)
      const cx = p3x + hi.dx, cy = p3y + hi.dy;
      const mt = 1 - t;
      return {
        x: mt * mt * p0x + 2 * mt * t * cx + t * t * p3x,
        y: mt * mt * p0y + 2 * mt * t * cy + t * t * p3y,
      };
    } else {
      // Linear
      return {
        x: p0x + t * (p3x - p0x),
        y: p0y + t * (p3y - p0y),
      };
    }
  }

  /**
   * Evaluate point on the entire bezier at parameter t ∈ [0,1].
   */
  evaluateAt(t) {
    t = Math.max(0, Math.min(1, t));
    const n = this.segmentCount;
    const segT = t * n;
    const segIdx = Math.min(Math.floor(segT), n - 1);
    const localT = segT - segIdx;
    return this.evaluateSegment(segIdx, localT);
  }

  /**
   * Sample the bezier as a polyline.
   * @param {number} [segsPerSpan=16] samples per bezier segment
   * @returns {Array<{x:number,y:number}>}
   */
  tessellate2D(segsPerSpan = 16) {
    const pts = [];
    for (let s = 0; s < this.segmentCount; s++) {
      const steps = segsPerSpan;
      for (let i = 0; i <= steps; i++) {
        if (s > 0 && i === 0) continue; // avoid duplicate at segment boundary
        pts.push(this.evaluateSegment(s, i / steps));
      }
    }
    return pts;
  }

  // -----------------------------------------------------------------------
  // Vertex/handle manipulation
  // -----------------------------------------------------------------------

  /**
   * Set the tangent mode on a vertex. When tangent is true, the outgoing handle
   * is mirrored from the incoming handle (smooth join).
   */
  setTangent(vertexIndex, enabled) {
    const v = this.vertices[vertexIndex];
    if (!v) return;
    v.tangent = !!enabled;
    if (enabled && v.handleIn && v.handleOut) {
      // Mirror the outgoing handle from the incoming
      v.handleOut.dx = -v.handleIn.dx;
      v.handleOut.dy = -v.handleIn.dy;
    }
  }

  /**
   * Set a handle offset for a vertex.
   * @param {number} vertexIndex
   * @param {'in'|'out'} which
   * @param {number} dx
   * @param {number} dy
   */
  setHandle(vertexIndex, which, dx, dy) {
    const v = this.vertices[vertexIndex];
    if (!v) return;
    if (which === 'out') {
      if (!v.handleOut) v.handleOut = { dx: 0, dy: 0 };
      v.handleOut.dx = dx;
      v.handleOut.dy = dy;
      if (v.tangent && v.handleIn) {
        v.handleIn.dx = -dx;
        v.handleIn.dy = -dy;
      }
    } else {
      if (!v.handleIn) v.handleIn = { dx: 0, dy: 0 };
      v.handleIn.dx = dx;
      v.handleIn.dy = dy;
      if (v.tangent && v.handleOut) {
        v.handleOut.dx = -dx;
        v.handleOut.dy = -dy;
      }
    }
  }

  /**
   * Insert a new vertex at parameter t on segment segIdx.
   * @param {number} segIdx
   * @param {number} t
   * @param {import('./Point.js').PPoint} newPt - a PPoint already added to the scene
   * @returns the new vertex descriptor
   */
  insertVertex(segIdx, t, newPt) {

    // For cubic segments, use de Casteljau subdivision to get accurate handles
    const v0 = this.vertices[segIdx];
    const v1 = this.vertices[segIdx + 1];
    const p0 = v0.point, p3 = v1.point;
    const ho = v0.handleOut;
    const hi = v1.handleIn;

    let newVertex;
    if (ho && hi) {
      // Cubic de Casteljau split
      const c1x = p0.x + ho.dx, c1y = p0.y + ho.dy;
      const c2x = p3.x + hi.dx, c2y = p3.y + hi.dy;
      const q0x = p0.x + t * (c1x - p0.x), q0y = p0.y + t * (c1y - p0.y);
      const q1x = c1x + t * (c2x - c1x), q1y = c1y + t * (c2y - c1y);
      const q2x = c2x + t * (p3.x - c2x), q2y = c2y + t * (p3.y - c2y);
      const r0x = q0x + t * (q1x - q0x), r0y = q0y + t * (q1y - q0y);
      const r1x = q1x + t * (q2x - q1x), r1y = q1y + t * (q2y - q1y);

      // Update original handles
      v0.handleOut = { dx: q0x - p0.x, dy: q0y - p0.y };
      v1.handleIn = { dx: q2x - p3.x, dy: q2y - p3.y };

      newVertex = {
        point: newPt,
        handleIn: { dx: r0x - newPt.x, dy: r0y - newPt.y },
        handleOut: { dx: r1x - newPt.x, dy: r1y - newPt.y },
        tangent: true,
      };
    } else {
      newVertex = {
        point: newPt,
        handleIn: null,
        handleOut: null,
        tangent: false,
      };
    }

    this.vertices.splice(segIdx + 1, 0, newVertex);
    return newVertex;
  }

  /**
   * Remove a vertex at the given index (if not first or last).
   */
  removeVertex(vertexIndex) {
    if (vertexIndex <= 0 || vertexIndex >= this.vertices.length - 1) return false;
    if (this.vertices.length <= 2) return false;
    this.vertices.splice(vertexIndex, 1);
    return true;
  }

  // -----------------------------------------------------------------------
  // Primitive interface
  // -----------------------------------------------------------------------

  getBounds() {
    const pts = this.tessellate2D(16);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  getSnapPoints() {
    const snaps = [];
    for (const v of this.vertices) {
      snaps.push({ x: v.point.x, y: v.point.y, type: 'endpoint' });
    }
    const mid = this.evaluateAt(0.5);
    snaps.push({ x: mid.x, y: mid.y, type: 'midpoint' });
    return snaps;
  }

  distanceTo(px, py) {
    const pts = this.tessellate2D(32);
    let minDist = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = _distPointToSeg(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  draw(ctx, vp) {
    const pts = this.tessellate2D(16);
    if (pts.length < 2) return;

    if (this.construction) {
      ctx.save();
      ctx.setLineDash(_constructionDash(this.constructionDash));
    }

    ctx.beginPath();
    const s0 = vp.worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = vp.worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();

    if (this.construction) ctx.restore();

    // Draw handles when selected
    if (this.selected) {
      this._drawHandles(ctx, vp);
    }
  }

  /** Draw tangent handles and control point indicators. */
  _drawHandles(ctx, vp) {
    ctx.save();
    for (let vi = 0; vi < this.vertices.length; vi++) {
      const v = this.vertices[vi];
      const s = vp.worldToScreen(v.point.x, v.point.y);

      // Draw handle lines and handle points
      ctx.strokeStyle = v.tangent ? '#ff9800' : '#888';
      ctx.lineWidth = 1;

      if (v.handleIn) {
        const hx = v.point.x + v.handleIn.dx;
        const hy = v.point.y + v.handleIn.dy;
        const hs = vp.worldToScreen(hx, hy);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(hs.x, hs.y);
        ctx.stroke();
        // Handle point
        ctx.fillStyle = v.tangent ? '#ff9800' : '#888';
        ctx.beginPath();
        ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      if (v.handleOut) {
        const hx = v.point.x + v.handleOut.dx;
        const hy = v.point.y + v.handleOut.dy;
        const hs = vp.worldToScreen(hx, hy);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(hs.x, hs.y);
        ctx.stroke();
        // Handle point
        ctx.fillStyle = v.tangent ? '#ff9800' : '#888';
        ctx.beginPath();
        ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Vertex point (diamond for tangent, square for corner)
      ctx.fillStyle = '#00bfff';
      if (v.tangent) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
      } else {
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
      }
    }
    ctx.restore();
  }

  translate(dx, dy) {
    for (const v of this.vertices) {
      v.point.translate(dx, dy);
    }
  }

  serialize() {
    return {
      ...super.serialize(),
      vertices: this.vertices.map(v => ({
        point: v.point.id,
        handleIn: v.handleIn ? { dx: v.handleIn.dx, dy: v.handleIn.dy } : null,
        handleOut: v.handleOut ? { dx: v.handleOut.dx, dy: v.handleOut.dy } : null,
        tangent: v.tangent,
      })),
    };
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function _distPointToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
