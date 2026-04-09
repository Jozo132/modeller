// js/cad/SplinePrimitive.js — A cubic B-spline defined by control points in 2D sketch space
import { Primitive } from './Primitive.js';

const _DASH_PATTERNS = { 'dashed': [10, 5], 'dash-dot': [12, 4, 2, 4], 'dotted': [2, 4] };
function _constructionDash(style) { return _DASH_PATTERNS[style] || _DASH_PATTERNS['dashed']; }

/**
 * PSpline — A cubic B-spline curve defined by control points.
 *
 * Each control point is a PPoint reference so the curve participates in the
 * constraint solver (dragging a control point reshapes the spline).
 *
 * Endpoints:  this.points[0]  and  this.points[this.points.length - 1]
 * These are the "p1" / "p2" of the spline for profile-tracing.
 */
export class PSpline extends Primitive {
  /**
   * @param {import('./Point.js').PPoint[]} controlPoints — at least 2 PPoints
   */
  constructor(controlPoints) {
    super('spline');
    if (!controlPoints || controlPoints.length < 2) {
      throw new Error('PSpline requires at least 2 control points');
    }
    this.points = controlPoints; // PPoint[]
  }

  /** First endpoint (for profile tracing) */
  get p1() { return this.points[0]; }
  /** Last endpoint (for profile tracing) */
  get p2() { return this.points[this.points.length - 1]; }

  // -----------------------------------------------------------------------
  // Cubic B-spline evaluation using clamped uniform knot vector
  // -----------------------------------------------------------------------

  /**
   * Build clamped uniform knot vector for the spline.
   * degree = min(3, n-1) where n = number of control points.
   */
  _knotVector() {
    const n = this.points.length;
    const p = Math.min(3, n - 1); // degree
    const m = n + p + 1;          // knot count
    const knots = new Array(m);
    for (let i = 0; i < m; i++) {
      if (i <= p) knots[i] = 0;
      else if (i >= m - p - 1) knots[i] = 1;
      else knots[i] = (i - p) / (n - p);
    }
    return { knots, degree: p };
  }

  /**
   * Evaluate point on the B-spline at parameter t ∈ [0,1].
   * Uses the Cox–de Boor algorithm.
   * @param {number} t
   * @returns {{x: number, y: number}}
   */
  evaluateAt(t) {
    const n = this.points.length;
    if (n === 1) return { x: this.points[0].x, y: this.points[0].y };
    // Clamp
    t = Math.max(0, Math.min(1, t));
    if (t >= 1) return { x: this.points[n - 1].x, y: this.points[n - 1].y };

    const { knots, degree: p } = this._knotVector();

    // Find knot span
    let span = p;
    for (let i = p; i < n; i++) {
      if (t >= knots[i] && t < knots[i + 1]) { span = i; break; }
    }

    // Basis functions (Cox–de Boor)
    const N = new Array(p + 1).fill(0);
    N[0] = 1;
    const left = new Array(p + 1);
    const right = new Array(p + 1);

    for (let j = 1; j <= p; j++) {
      left[j] = t - knots[span + 1 - j];
      right[j] = knots[span + j] - t;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        const denom = right[r + 1] + left[j - r];
        if (Math.abs(denom) < 1e-14) {
          N[r] = saved;
          saved = 0;
        } else {
          const temp = N[r] / denom;
          N[r] = saved + right[r + 1] * temp;
          saved = left[j - r] * temp;
        }
      }
      N[j] = saved;
    }

    let x = 0, y = 0;
    for (let i = 0; i <= p; i++) {
      const cp = this.points[span - p + i];
      x += N[i] * cp.x;
      y += N[i] * cp.y;
    }
    return { x, y };
  }

  /**
   * Sample the spline as a polyline with the given number of segments.
   * @param {number} [numSegs=32]
   * @returns {Array<{x: number, y: number}>}
   */
  tessellate2D(numSegs = 32) {
    const pts = [];
    for (let i = 0; i <= numSegs; i++) {
      pts.push(this.evaluateAt(i / numSegs));
    }
    return pts;
  }

  /**
   * Insert a new control point at parameter t on the spline using knot insertion.
   * @param {number} t - Parameter value ∈ [0,1] where the new point should be inserted.
   * @param {import('./Point.js').PPoint} newPt - PPoint already added to the scene.
   * @returns {number} Index of the inserted control point.
   */
  insertControlPoint(t, newPt) {
    // Find the span and insert position
    const pt = this.evaluateAt(t);
    newPt.x = pt.x;
    newPt.y = pt.y;
    // Insert at the appropriate position (between the two nearest control points)
    const n = this.points.length;
    let bestIdx = 1;
    if (n > 2) {
      // Find the pair of adjacent control points closest to the evaluated point
      let bestDist = Infinity;
      for (let i = 0; i < n - 1; i++) {
        const mx = (this.points[i].x + this.points[i + 1].x) / 2;
        const my = (this.points[i].y + this.points[i + 1].y) / 2;
        const d = Math.hypot(pt.x - mx, pt.y - my);
        if (d < bestDist) { bestDist = d; bestIdx = i + 1; }
      }
    }
    this.points.splice(bestIdx, 0, newPt);
    return bestIdx;
  }

  /**
   * Remove a control point at the given index (if not first or last endpoint).
   * @param {number} index - Index of the control point to remove.
   * @returns {boolean} Whether the removal succeeded.
   */
  removeControlPoint(index) {
    if (index <= 0 || index >= this.points.length - 1) return false;
    if (this.points.length <= 2) return false;
    this.points.splice(index, 1);
    return true;
  }

  // -----------------------------------------------------------------------
  // Primitive interface
  // -----------------------------------------------------------------------

  getBounds() {
    const pts = this.tessellate2D(32);
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
    const sp = this.p1;
    const ep = this.p2;
    const mid = this.evaluateAt(0.5);
    const snaps = [
      { x: sp.x, y: sp.y, type: 'endpoint' },
      { x: ep.x, y: ep.y, type: 'endpoint' },
      { x: mid.x, y: mid.y, type: 'midpoint' },
    ];
    // Also add control points as snap targets
    for (const cp of this.points) {
      snaps.push({ x: cp.x, y: cp.y, type: 'control' });
    }
    return snaps;
  }

  distanceTo(px, py) {
    const pts = this.tessellate2D(64);
    let minDist = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = _distPointToSeg(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  draw(ctx, vp) {
    const pts = this.tessellate2D(32);
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
  }

  translate(dx, dy) {
    for (const p of this.points) {
      p.translate(dx, dy);
    }
  }

  serialize() {
    return {
      ...super.serialize(),
      controlPoints: this.points.map(p => p.id),
    };
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Distance from point (px,py) to line segment (ax,ay)-(bx,by). */
function _distPointToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
