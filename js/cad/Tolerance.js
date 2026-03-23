// js/cad/Tolerance.js — Tolerance policy module for the exact B-Rep kernel
//
// Provides a centralized, explicit tolerance policy used by every geometric
// operation in the kernel: intersection, sewing, classification, export.
//
// Every boolean decision must use the same tolerance policy.

/**
 * Tolerance — Centralized tolerance policy for the CAD kernel.
 *
 * All numeric comparisons in intersection, classification, sewing, and
 * export code should reference this singleton so that tolerance values
 * are consistent and testable.
 */
export class Tolerance {
  /**
   * @param {Object} [opts] - Override default tolerances
   */
  constructor(opts = {}) {
    /** Modeling epsilon — smallest meaningful geometric distance */
    this.modelingEpsilon = opts.modelingEpsilon ?? 1e-8;

    /** Point coincidence tolerance — two points closer than this are identical */
    this.pointCoincidence = opts.pointCoincidence ?? 1e-6;

    /** Edge overlap tolerance — edges within this distance are coincident */
    this.edgeOverlap = opts.edgeOverlap ?? 1e-6;

    /** Angular parallelism tolerance (radians) — normals within this are parallel */
    this.angularParallelism = opts.angularParallelism ?? 1e-6;

    /** Sewing tolerance — gap tolerance for topology stitching */
    this.sewing = opts.sewing ?? 1e-4;

    /** Export tolerance — accuracy target for STEP/STL output */
    this.exportTolerance = opts.exportTolerance ?? 1e-6;

    /** Intersection tolerance — convergence tolerance for surface/curve intersections */
    this.intersection = opts.intersection ?? 1e-7;

    /** Classification tolerance — in/out point classification threshold */
    this.classification = opts.classification ?? 1e-5;
  }

  /**
   * Check if two points are coincident within tolerance.
   * @param {{x:number,y:number,z:number}} a
   * @param {{x:number,y:number,z:number}} b
   * @returns {boolean}
   */
  pointsCoincident(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) < this.pointCoincidence;
  }

  /**
   * Check if a scalar is effectively zero.
   * @param {number} value
   * @returns {boolean}
   */
  isZero(value) {
    return Math.abs(value) < this.modelingEpsilon;
  }

  /**
   * Check if two normals are parallel within angular tolerance.
   * @param {{x:number,y:number,z:number}} n1
   * @param {{x:number,y:number,z:number}} n2
   * @returns {boolean}
   */
  normalsParallel(n1, n2) {
    const dot = n1.x * n2.x + n1.y * n2.y + n1.z * n2.z;
    return Math.abs(Math.abs(dot) - 1.0) < this.angularParallelism;
  }

  /**
   * Check if two normals point in the same direction.
   * @param {{x:number,y:number,z:number}} n1
   * @param {{x:number,y:number,z:number}} n2
   * @returns {boolean}
   */
  normalsSameDirection(n1, n2) {
    const dot = n1.x * n2.x + n1.y * n2.y + n1.z * n2.z;
    return dot > 1.0 - this.angularParallelism;
  }

  /**
   * Distance between two 3D points.
   * @param {{x:number,y:number,z:number}} a
   * @param {{x:number,y:number,z:number}} b
   * @returns {number}
   */
  distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Classify a point relative to a plane.
   * @param {{x:number,y:number,z:number}} point
   * @param {{normal:{x:number,y:number,z:number}, d:number}} plane - plane.normal·P + plane.d = 0
   * @returns {'front'|'back'|'on'}
   */
  classifyPoint(point, plane) {
    const dist = plane.normal.x * point.x + plane.normal.y * point.y +
                 plane.normal.z * point.z + plane.d;
    if (dist > this.classification) return 'front';
    if (dist < -this.classification) return 'back';
    return 'on';
  }

  /**
   * Clone with overrides.
   * @param {Object} [overrides]
   * @returns {Tolerance}
   */
  clone(overrides = {}) {
    return new Tolerance({ ...this, ...overrides });
  }

  /**
   * Serialize to plain object.
   */
  serialize() {
    return {
      modelingEpsilon: this.modelingEpsilon,
      pointCoincidence: this.pointCoincidence,
      edgeOverlap: this.edgeOverlap,
      angularParallelism: this.angularParallelism,
      sewing: this.sewing,
      exportTolerance: this.exportTolerance,
      intersection: this.intersection,
      classification: this.classification,
    };
  }

  /**
   * Deserialize from plain object.
   * @param {Object} data
   * @returns {Tolerance}
   */
  static deserialize(data) {
    return new Tolerance(data);
  }
}

/** Default global tolerance instance */
export const DEFAULT_TOLERANCE = new Tolerance();
