// assembly/solver.ts — Gauss-Seidel constraint solver in WASM
// Mirrors the JS Solver.js but runs constraint iterations in WASM for speed.

// Constraint type IDs
export const CONSTRAINT_COINCIDENT: i32    = 0;
export const CONSTRAINT_HORIZONTAL: i32    = 1;
export const CONSTRAINT_VERTICAL: i32      = 2;
export const CONSTRAINT_DISTANCE: i32      = 3;
export const CONSTRAINT_FIXED: i32         = 4;
export const CONSTRAINT_PARALLEL: i32      = 5;
export const CONSTRAINT_PERPENDICULAR: i32 = 6;
export const CONSTRAINT_EQUAL_LENGTH: i32  = 7;
export const CONSTRAINT_TANGENT: i32       = 8;
export const CONSTRAINT_ANGLE: i32         = 9;

/**
 * SolverPoint — a 2D point that can be moved by constraints.
 */
export class SolverPoint {
  x: f32;
  y: f32;
  fixed: bool;

  constructor(x: f32 = 0, y: f32 = 0, fixed: bool = false) {
    this.x = x;
    this.y = y;
    this.fixed = fixed;
  }
}

/**
 * SolverConstraint — a single constraint referencing point indices.
 */
export class SolverConstraint {
  type: i32;
  p1: i32;  // index into point array
  p2: i32;  // index into point array (or -1 if unused)
  p3: i32;  // for perpendicular/parallel (second line p3-p4)
  p4: i32;
  value: f32; // for distance/angle constraints

  constructor() {
    this.type = 0;
    this.p1 = -1;
    this.p2 = -1;
    this.p3 = -1;
    this.p4 = -1;
    this.value = 0;
  }
}

/**
 * ConstraintSolver — Gauss-Seidel iterative constraint solver.
 */
export class ConstraintSolver {
  points: Array<SolverPoint>;
  constraints: Array<SolverConstraint>;
  maxIterations: i32;
  tolerance: f32;

  // Results
  converged: bool;
  iterations: i32;
  maxError: f32;

  constructor() {
    this.points = new Array<SolverPoint>();
    this.constraints = new Array<SolverConstraint>();
    this.maxIterations = 200;
    this.tolerance = 1e-6;
    this.converged = false;
    this.iterations = 0;
    this.maxError = 0;
  }

  clear(): void {
    this.points = new Array<SolverPoint>();
    this.constraints = new Array<SolverConstraint>();
  }

  addPoint(x: f32, y: f32, fixed: bool): i32 {
    const p = new SolverPoint(x, y, fixed);
    this.points.push(p);
    return this.points.length - 1;
  }

  addConstraint(type: i32, p1: i32, p2: i32, p3: i32, p4: i32, value: f32): i32 {
    const c = new SolverConstraint();
    c.type = type;
    c.p1 = p1;
    c.p2 = p2;
    c.p3 = p3;
    c.p4 = p4;
    c.value = value;
    this.constraints.push(c);
    return this.constraints.length - 1;
  }

  /**
   * Run the solver. Returns true if converged.
   */
  solve(): bool {
    const n = this.constraints.length;
    if (n == 0) {
      this.converged = true;
      this.iterations = 0;
      this.maxError = 0;
      return true;
    }

    for (let iter: i32 = 0; iter < this.maxIterations; iter++) {
      let maxErr: f32 = 0;
      for (let ci: i32 = 0; ci < n; ci++) {
        const c = unchecked(this.constraints[ci]);
        const err = this.computeError(c);
        if (err > maxErr) maxErr = err;
        if (err > this.tolerance) {
          this.applyConstraint(c);
        }
      }
      if (maxErr <= this.tolerance) {
        this.converged = true;
        this.iterations = iter + 1;
        this.maxError = maxErr;
        return true;
      }
    }

    this.converged = false;
    this.iterations = this.maxIterations;
    this.maxError = 0;
    // Compute final error
    for (let ci: i32 = 0; ci < n; ci++) {
      const err = this.computeError(unchecked(this.constraints[ci]));
      if (err > this.maxError) this.maxError = err;
    }
    return false;
  }

  private computeError(c: SolverConstraint): f32 {
    switch (c.type) {
      case CONSTRAINT_COINCIDENT: return this.errorCoincident(c);
      case CONSTRAINT_HORIZONTAL: return this.errorHorizontal(c);
      case CONSTRAINT_VERTICAL: return this.errorVertical(c);
      case CONSTRAINT_DISTANCE: return this.errorDistance(c);
      case CONSTRAINT_FIXED: return this.errorFixed(c);
      case CONSTRAINT_PARALLEL: return this.errorParallel(c);
      case CONSTRAINT_PERPENDICULAR: return this.errorPerpendicular(c);
      case CONSTRAINT_EQUAL_LENGTH: return this.errorEqualLength(c);
      default: return 0;
    }
  }

  private applyConstraint(c: SolverConstraint): void {
    switch (c.type) {
      case CONSTRAINT_COINCIDENT: this.applyCoincident(c); break;
      case CONSTRAINT_HORIZONTAL: this.applyHorizontal(c); break;
      case CONSTRAINT_VERTICAL: this.applyVertical(c); break;
      case CONSTRAINT_DISTANCE: this.applyDistance(c); break;
      case CONSTRAINT_FIXED: this.applyFixed(c); break;
      case CONSTRAINT_PARALLEL: this.applyParallel(c); break;
      case CONSTRAINT_PERPENDICULAR: this.applyPerpendicular(c); break;
      case CONSTRAINT_EQUAL_LENGTH: this.applyEqualLength(c); break;
    }
  }

  // --- Coincident ---
  private errorCoincident(c: SolverConstraint): f32 {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return <f32>Math.sqrt(<f64>(dx * dx + dy * dy));
  }

  private applyCoincident(c: SolverConstraint): void {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    if (a.fixed && b.fixed) return;
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    if (a.fixed) {
      b.x = a.x; b.y = a.y;
    } else if (b.fixed) {
      a.x = b.x; a.y = b.y;
    } else {
      a.x = mx; a.y = my;
      b.x = mx; b.y = my;
    }
  }

  // --- Horizontal ---
  private errorHorizontal(c: SolverConstraint): f32 {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    return <f32>Math.abs(<f64>(a.y - b.y));
  }

  private applyHorizontal(c: SolverConstraint): void {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    if (a.fixed && b.fixed) return;
    const my = (a.y + b.y) * 0.5;
    if (a.fixed) {
      b.y = a.y;
    } else if (b.fixed) {
      a.y = b.y;
    } else {
      a.y = my; b.y = my;
    }
  }

  // --- Vertical ---
  private errorVertical(c: SolverConstraint): f32 {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    return <f32>Math.abs(<f64>(a.x - b.x));
  }

  private applyVertical(c: SolverConstraint): void {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    if (a.fixed && b.fixed) return;
    const mx = (a.x + b.x) * 0.5;
    if (a.fixed) {
      b.x = a.x;
    } else if (b.fixed) {
      a.x = b.x;
    } else {
      a.x = mx; b.x = mx;
    }
  }

  // --- Distance ---
  private errorDistance(c: SolverConstraint): f32 {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = <f32>Math.sqrt(<f64>(dx * dx + dy * dy));
    return <f32>Math.abs(<f64>(dist - c.value));
  }

  private applyDistance(c: SolverConstraint): void {
    const a = unchecked(this.points[c.p1]);
    const b = unchecked(this.points[c.p2]);
    if (a.fixed && b.fixed) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = <f32>Math.sqrt(<f64>(dx * dx + dy * dy));
    if (dist < 1e-9) return;
    const factor = (c.value - dist) / dist * 0.5;
    const mx = dx * factor;
    const my = dy * factor;
    if (a.fixed) {
      b.x += mx * 2; b.y += my * 2;
    } else if (b.fixed) {
      a.x -= mx * 2; a.y -= my * 2;
    } else {
      a.x -= mx; a.y -= my;
      b.x += mx; b.y += my;
    }
  }

  // --- Fixed ---
  private errorFixed(c: SolverConstraint): f32 {
    const p = unchecked(this.points[c.p1]);
    // value encodes target x in p3/p4 as float reinterpret, but simpler:
    // For fixed constraints, we use p2 index = -1, value = 0
    // The point should already be marked fixed, so error is 0.
    if (p.fixed) return 0;
    return 1.0;
  }

  private applyFixed(c: SolverConstraint): void {
    const p = unchecked(this.points[c.p1]);
    p.fixed = true;
  }

  // --- Parallel ---
  private errorParallel(c: SolverConstraint): f32 {
    const a1 = unchecked(this.points[c.p1]);
    const a2 = unchecked(this.points[c.p2]);
    const b1 = unchecked(this.points[c.p3]);
    const b2 = unchecked(this.points[c.p4]);
    const dx1 = a2.x - a1.x;
    const dy1 = a2.y - a1.y;
    const dx2 = b2.x - b1.x;
    const dy2 = b2.y - b1.y;
    // Cross product should be 0 for parallel
    const cross = dx1 * dy2 - dy1 * dx2;
    const len1 = <f32>Math.sqrt(<f64>(dx1 * dx1 + dy1 * dy1));
    const len2 = <f32>Math.sqrt(<f64>(dx2 * dx2 + dy2 * dy2));
    if (len1 < 1e-9 || len2 < 1e-9) return 0;
    return <f32>Math.abs(<f64>(cross / (len1 * len2)));
  }

  private applyParallel(c: SolverConstraint): void {
    const a1 = unchecked(this.points[c.p1]);
    const a2 = unchecked(this.points[c.p2]);
    const b1 = unchecked(this.points[c.p3]);
    const b2 = unchecked(this.points[c.p4]);
    const dx1 = a2.x - a1.x;
    const dy1 = a2.y - a1.y;
    const len1 = <f32>Math.sqrt(<f64>(dx1 * dx1 + dy1 * dy1));
    const len2dx = b2.x - b1.x;
    const len2dy = b2.y - b1.y;
    const len2 = <f32>Math.sqrt(<f64>(len2dx * len2dx + len2dy * len2dy));
    if (len1 < 1e-9 || len2 < 1e-9) return;
    // Rotate line 2 to be parallel with line 1
    const ux = dx1 / len1;
    const uy = dy1 / len1;
    const dot = (len2dx * ux + len2dy * uy);
    const sign: f32 = dot >= 0 ? 1.0 : -1.0;
    if (!b2.fixed) {
      b2.x = b1.x + ux * len2 * sign;
      b2.y = b1.y + uy * len2 * sign;
    }
  }

  // --- Perpendicular ---
  private errorPerpendicular(c: SolverConstraint): f32 {
    const a1 = unchecked(this.points[c.p1]);
    const a2 = unchecked(this.points[c.p2]);
    const b1 = unchecked(this.points[c.p3]);
    const b2 = unchecked(this.points[c.p4]);
    const dx1 = a2.x - a1.x;
    const dy1 = a2.y - a1.y;
    const dx2 = b2.x - b1.x;
    const dy2 = b2.y - b1.y;
    const len1 = <f32>Math.sqrt(<f64>(dx1 * dx1 + dy1 * dy1));
    const len2 = <f32>Math.sqrt(<f64>(dx2 * dx2 + dy2 * dy2));
    if (len1 < 1e-9 || len2 < 1e-9) return 0;
    // Dot product should be 0 for perpendicular
    const dot = dx1 * dx2 + dy1 * dy2;
    return <f32>Math.abs(<f64>(dot / (len1 * len2)));
  }

  private applyPerpendicular(c: SolverConstraint): void {
    const a1 = unchecked(this.points[c.p1]);
    const a2 = unchecked(this.points[c.p2]);
    const b1 = unchecked(this.points[c.p3]);
    const b2 = unchecked(this.points[c.p4]);
    const dx1 = a2.x - a1.x;
    const dy1 = a2.y - a1.y;
    const len1 = <f32>Math.sqrt(<f64>(dx1 * dx1 + dy1 * dy1));
    const len2dx = b2.x - b1.x;
    const len2dy = b2.y - b1.y;
    const len2 = <f32>Math.sqrt(<f64>(len2dx * len2dx + len2dy * len2dy));
    if (len1 < 1e-9 || len2 < 1e-9) return;
    // Perpendicular direction to line 1
    const px: f32 = -dy1 / len1;
    const py: f32 = dx1 / len1;
    const dot = (len2dx * px + len2dy * py);
    const sign: f32 = dot >= 0 ? 1.0 : -1.0;
    if (!b2.fixed) {
      b2.x = b1.x + px * len2 * sign;
      b2.y = b1.y + py * len2 * sign;
    }
  }

  // --- Equal Length ---
  private errorEqualLength(c: SolverConstraint): f32 {
    const a1 = unchecked(this.points[c.p1]);
    const a2 = unchecked(this.points[c.p2]);
    const b1 = unchecked(this.points[c.p3]);
    const b2 = unchecked(this.points[c.p4]);
    const dx1 = a2.x - a1.x;
    const dy1 = a2.y - a1.y;
    const dx2 = b2.x - b1.x;
    const dy2 = b2.y - b1.y;
    const len1 = <f32>Math.sqrt(<f64>(dx1 * dx1 + dy1 * dy1));
    const len2 = <f32>Math.sqrt(<f64>(dx2 * dx2 + dy2 * dy2));
    return <f32>Math.abs(<f64>(len1 - len2));
  }

  private applyEqualLength(c: SolverConstraint): void {
    const a1 = unchecked(this.points[c.p1]);
    const a2 = unchecked(this.points[c.p2]);
    const b1 = unchecked(this.points[c.p3]);
    const b2 = unchecked(this.points[c.p4]);
    const dx1 = a2.x - a1.x;
    const dy1 = a2.y - a1.y;
    const dx2 = b2.x - b1.x;
    const dy2 = b2.y - b1.y;
    const len1 = <f32>Math.sqrt(<f64>(dx1 * dx1 + dy1 * dy1));
    const len2 = <f32>Math.sqrt(<f64>(dx2 * dx2 + dy2 * dy2));
    if (len1 < 1e-9 && len2 < 1e-9) return;
    const avg = (len1 + len2) * 0.5;
    // Adjust line 2 length to match average
    if (len2 > 1e-9 && !b2.fixed) {
      const scale = avg / len2;
      b2.x = b1.x + dx2 * scale;
      b2.y = b1.y + dy2 * scale;
    }
    // Adjust line 1 length to match average
    if (len1 > 1e-9 && !a2.fixed) {
      const scale = avg / len1;
      a2.x = a1.x + dx1 * scale;
      a2.y = a1.y + dy1 * scale;
    }
  }

  /**
   * Read point position after solving
   */
  getPointX(index: i32): f32 {
    return unchecked(this.points[index]).x;
  }

  getPointY(index: i32): f32 {
    return unchecked(this.points[index]).y;
  }
}
