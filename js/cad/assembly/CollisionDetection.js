// js/cad/assembly/CollisionDetection.js — AABB broadphase collision detection
//
// Provides fast overlap checks between part instances using axis-aligned
// bounding boxes (AABBs) transformed to world space.

import { transformPoint } from './Transform3D.js';

// ── AABB utilities ──────────────────────────────────────────────────

/**
 * Compute the world-space AABB of a part instance.
 * Transforms all 8 corners of the local AABB and takes the min/max.
 *
 * @param {import('./PartInstance.js').PartInstance} instance
 * @returns {{ min: {x,y,z}, max: {x,y,z} } | null}
 */
export function computeWorldAABB(instance) {
  const bb = instance.definition.boundingBox;
  if (!bb) return null;

  const { min, max } = bb;
  const corners = [
    { x: min.x, y: min.y, z: min.z },
    { x: max.x, y: min.y, z: min.z },
    { x: min.x, y: max.y, z: min.z },
    { x: max.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z },
    { x: max.x, y: min.y, z: max.z },
    { x: min.x, y: max.y, z: max.z },
    { x: max.x, y: max.y, z: max.z },
  ];

  const first = transformPoint(instance.transform, corners[0]);
  const wMin = { x: first.x, y: first.y, z: first.z };
  const wMax = { x: first.x, y: first.y, z: first.z };

  for (let i = 1; i < 8; i++) {
    const p = transformPoint(instance.transform, corners[i]);
    wMin.x = Math.min(wMin.x, p.x);
    wMin.y = Math.min(wMin.y, p.y);
    wMin.z = Math.min(wMin.z, p.z);
    wMax.x = Math.max(wMax.x, p.x);
    wMax.y = Math.max(wMax.y, p.y);
    wMax.z = Math.max(wMax.z, p.z);
  }

  return { min: wMin, max: wMax };
}

/**
 * Test if two AABBs overlap.
 * @param {{ min:{x,y,z}, max:{x,y,z} }} a
 * @param {{ min:{x,y,z}, max:{x,y,z} }} b
 * @returns {boolean}
 */
export function aabbOverlap(a, b) {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
         a.min.y <= b.max.y && a.max.y >= b.min.y &&
         a.min.z <= b.max.z && a.max.z >= b.min.z;
}

/**
 * Compute the minimum clearance (gap) between two AABBs along each axis.
 * Returns negative values for overlap (penetration).
 *
 * @param {{ min:{x,y,z}, max:{x,y,z} }} a
 * @param {{ min:{x,y,z}, max:{x,y,z} }} b
 * @returns {{ x: number, y: number, z: number, min: number }}
 */
export function aabbClearance(a, b) {
  const dx = Math.max(a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(a.min.z - b.max.z, b.min.z - a.max.z);
  return { x: dx, y: dy, z: dz, min: Math.max(dx, dy, dz) };
}

// ── Broadphase ──────────────────────────────────────────────────────

/**
 * Run broadphase collision detection on a set of part instances.
 * Returns all pairs whose world-space AABBs overlap.
 *
 * Uses optional solver transforms if provided, otherwise uses instance transforms.
 *
 * @param {import('./PartInstance.js').PartInstance[]} instances
 * @param {Map<string,Float64Array>} [solvedTransforms] - optional solver output
 * @returns {Array<{ a: string, b: string, clearance: Object }>}
 */
export function broadphaseCollisions(instances, solvedTransforms) {
  // Build world AABBs
  const aabbs = [];
  for (const inst of instances) {
    if (!inst.definition.boundingBox) continue;
    // Use solved transform if available
    const saved = inst.transform;
    if (solvedTransforms && solvedTransforms.has(inst.id)) {
      inst.transform = solvedTransforms.get(inst.id);
    }
    const box = computeWorldAABB(inst);
    inst.transform = saved;
    if (box) aabbs.push({ id: inst.id, box });
  }

  // O(n²) brute-force for MVP (fine for small assemblies)
  const pairs = [];
  for (let i = 0; i < aabbs.length; i++) {
    for (let j = i + 1; j < aabbs.length; j++) {
      if (aabbOverlap(aabbs[i].box, aabbs[j].box)) {
        pairs.push({
          a: aabbs[i].id,
          b: aabbs[j].id,
          clearance: aabbClearance(aabbs[i].box, aabbs[j].box),
        });
      }
    }
  }
  return pairs;
}

/**
 * Query clearance between all instance pairs (including non-overlapping).
 *
 * @param {import('./PartInstance.js').PartInstance[]} instances
 * @param {Map<string,Float64Array>} [solvedTransforms]
 * @returns {Array<{ a: string, b: string, clearance: Object }>}
 */
export function clearanceQuery(instances, solvedTransforms) {
  const aabbs = [];
  for (const inst of instances) {
    if (!inst.definition.boundingBox) continue;
    const saved = inst.transform;
    if (solvedTransforms && solvedTransforms.has(inst.id)) {
      inst.transform = solvedTransforms.get(inst.id);
    }
    const box = computeWorldAABB(inst);
    inst.transform = saved;
    if (box) aabbs.push({ id: inst.id, box });
  }

  const results = [];
  for (let i = 0; i < aabbs.length; i++) {
    for (let j = i + 1; j < aabbs.length; j++) {
      results.push({
        a: aabbs[i].id,
        b: aabbs[j].id,
        clearance: aabbClearance(aabbs[i].box, aabbs[j].box),
      });
    }
  }
  return results;
}
