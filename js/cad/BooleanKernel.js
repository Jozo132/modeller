// js/cad/BooleanKernel.js — Exact B-Rep boolean operations
//
// Provides union, subtract, and intersect on exact B-Rep topology.
// Replaces mesh BSP with exact surface/surface intersection pipeline.
//
// Pipeline:
//   1. Intersect every candidate face pair
//   2. Compute exact intersection curves
//   3. Split support faces by intersection curves
//   4. Build trimmed face fragments in parameter space
//   5. Classify each fragment as inside, outside, or coincident
//   6. Keep or discard fragments according to boolean type
//   7. Stitch kept fragments into shells
//   8. Sew vertices and edges within tolerance
//   9. Validate shell orientation and closure
//  10. Tessellate the result for rendering

import { intersectBodies } from './Intersections.js';
import { splitFace, classifyFragment } from './FaceSplitter.js';
import { buildBody } from './ShellBuilder.js';
import { tessellateBody } from './Tessellation.js';
import { DEFAULT_TOLERANCE, Tolerance } from './Tolerance.js';

/**
 * Perform an exact boolean operation on two TopoBody operands.
 *
 * @param {import('./BRepTopology.js').TopoBody} bodyA
 * @param {import('./BRepTopology.js').TopoBody} bodyB
 * @param {'union'|'subtract'|'intersect'} operation
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {{
 *   body: import('./BRepTopology.js').TopoBody,
 *   mesh: {vertices: Array, faces: Array, edges: Array}
 * }}
 */
export function exactBooleanOp(bodyA, bodyB, operation, tol = DEFAULT_TOLERANCE) {
  // Step 1-2: Intersect candidate face pairs and compute intersection curves
  const intersections = intersectBodies(bodyA, bodyB, tol);

  // Step 3-4: Split faces by intersection curves
  const fragmentsA = _splitAllFaces(bodyA, intersections, 'A', tol);
  const fragmentsB = _splitAllFaces(bodyB, intersections, 'B', tol);

  // Step 5-6: Classify and select fragments
  const keptFragments = _classifyAndSelect(fragmentsA, fragmentsB, bodyA, bodyB, operation, tol);

  // Step 7-8: Stitch fragments into a result body
  const resultBody = buildBody(keptFragments, tol);

  // Step 9: Validate (caller can use BRepValidator)

  // Step 10: Tessellate for rendering
  const mesh = tessellateBody(resultBody);

  return { body: resultBody, mesh };
}

/**
 * Split all faces of a body by intersection curves.
 */
function _splitAllFaces(body, intersections, side, tol) {
  const fragments = [];
  const faceIntersectionMap = new Map();

  // Organize intersections by face
  for (const ix of intersections) {
    const face = side === 'A' ? ix.faceA : ix.faceB;
    if (!faceIntersectionMap.has(face.id)) {
      faceIntersectionMap.set(face.id, []);
    }

    for (const c of ix.curves) {
      faceIntersectionMap.get(face.id).push({
        curve: c.curve,
        paramsOnFace: side === 'A' ? c.paramsA : c.paramsB,
      });
    }
  }

  // Split each face
  for (const face of body.faces()) {
    const curves = faceIntersectionMap.get(face.id);
    if (curves && curves.length > 0) {
      const frags = splitFace(face, curves, tol);
      fragments.push(...frags);
    } else {
      fragments.push(face);
    }
  }

  return fragments;
}

/**
 * Classify fragments and select which to keep based on boolean operation.
 */
function _classifyAndSelect(fragmentsA, fragmentsB, bodyA, bodyB, operation, tol) {
  const kept = [];

  // Classify A fragments against B
  for (const frag of fragmentsA) {
    const cls = classifyFragment(frag, bodyB, tol);
    const keep = _shouldKeep(cls, operation, 'A');
    if (keep) kept.push(frag);
  }

  // Classify B fragments against A
  for (const frag of fragmentsB) {
    const cls = classifyFragment(frag, bodyA, tol);
    const keep = _shouldKeep(cls, operation, 'B');
    if (keep) {
      // For subtract, reverse face orientation for B fragments kept inside A
      if (operation === 'subtract' && cls === 'inside') {
        frag.sameSense = !frag.sameSense;
      }
      kept.push(frag);
    }
  }

  return kept;
}

/**
 * Determine whether to keep a fragment based on classification and operation.
 *
 * @param {'inside'|'outside'|'coincident'} classification
 * @param {'union'|'subtract'|'intersect'} operation
 * @param {'A'|'B'} operand
 * @returns {boolean}
 */
function _shouldKeep(classification, operation, operand) {
  switch (operation) {
    case 'union':
      // Keep outside fragments from both operands
      return classification === 'outside' || classification === 'coincident';

    case 'subtract':
      if (operand === 'A') {
        // Keep A outside B
        return classification === 'outside';
      } else {
        // Keep B inside A (reversed)
        return classification === 'inside';
      }

    case 'intersect':
      // Keep inside fragments from both operands
      return classification === 'inside' || classification === 'coincident';

    default:
      return false;
  }
}

/**
 * Check if two bodies have exact B-Rep topology.
 *
 * @param {import('./BRepTopology.js').TopoBody|null} body
 * @returns {boolean}
 */
export function hasExactTopology(body) {
  if (!body) return false;
  if (body.shells.length === 0) return false;
  for (const shell of body.shells) {
    if (shell.faces.length === 0) return false;
    for (const face of shell.faces) {
      if (!face.outerLoop) return false;
    }
  }
  return true;
}
