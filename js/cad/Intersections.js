// js/cad/Intersections.js — High-level intersection dispatch
//
// Provides a unified entry point for all intersection operations.
// Dispatches to specialized routines based on geometry types.

import { curveCurveIntersect } from './CurveCurveIntersect.js';
import { curveSurfaceIntersect } from './CurveSurfaceIntersect.js';
import { surfaceSurfaceIntersect } from './SurfaceSurfaceIntersect.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { SurfaceType } from './BRepTopology.js';

/**
 * Intersect two curves.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curveA
 * @param {import('./NurbsCurve.js').NurbsCurve} curveB
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{paramA: number, paramB: number, point: {x,y,z}}>}
 */
export function intersectCurves(curveA, curveB, tol = DEFAULT_TOLERANCE) {
  return curveCurveIntersect(curveA, curveB, tol);
}

/**
 * Intersect a curve with a surface.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curve
 * @param {import('./NurbsSurface.js').NurbsSurface} surface
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{paramT: number, paramU: number, paramV: number, point: {x,y,z}}>}
 */
export function intersectCurveSurface(curve, surface, tol = DEFAULT_TOLERANCE) {
  return curveSurfaceIntersect(curve, surface, tol);
}

/**
 * Intersect two surfaces.
 *
 * @param {import('./NurbsSurface.js').NurbsSurface} surfA
 * @param {string} typeA - Surface type
 * @param {import('./NurbsSurface.js').NurbsSurface} surfB
 * @param {string} typeB - Surface type
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{curve: import('./NurbsCurve.js').NurbsCurve, paramsA: Array<{u,v}>, paramsB: Array<{u,v}>}>}
 */
export function intersectSurfaces(surfA, typeA, surfB, typeB, tol = DEFAULT_TOLERANCE) {
  return surfaceSurfaceIntersect(surfA, typeA, surfB, typeB, tol);
}

/**
 * Intersect all candidate face pairs from two bodies.
 * Returns intersection curves organized by face pair.
 *
 * @param {import('./BRepTopology.js').TopoBody} bodyA
 * @param {import('./BRepTopology.js').TopoBody} bodyB
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{faceA: import('./BRepTopology.js').TopoFace, faceB: import('./BRepTopology.js').TopoFace, curves: Array}>}
 */
export function intersectBodies(bodyA, bodyB, tol = DEFAULT_TOLERANCE) {
  const results = [];
  const facesA = bodyA.faces();
  const facesB = bodyB.faces();

  for (const fA of facesA) {
    for (const fB of facesB) {
      // Quick bounding box check could go here
      if (!fA.surface || !fB.surface) continue;

      const curves = intersectSurfaces(
        fA.surface, fA.surfaceType,
        fB.surface, fB.surfaceType,
        tol,
      );

      if (curves.length > 0) {
        results.push({ faceA: fA, faceB: fB, curves });
      }
    }
  }

  return results;
}
