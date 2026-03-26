// tests/test-assembly-design.js — Assembly Design MVP test suite
//
// Covers:
//   - Part definitions and instances (data model)
//   - Insert part / place-instance workflows
//   - Five mate types: coincident, concentric, distance, angle, planar
//   - Deterministic hybrid solver (spanning-tree + loop correction)
//   - DOF diagnostics (under/over-constrained detection)
//   - Mate-sequence replay determinism
//   - Broadphase collision detection and clearance queries
//   - BOM roll-up and summary
//   - Serialization round-trip

import assert from 'assert';

import {
  PartDefinition, resetPartDefinitionIds,
  PartInstance, resetPartInstanceIds,
  Mate, MateType, resetMateIds,
  pointFeature, axisFeature, planeFeature,
  solveMate, mateResidual, solveAssembly,
  computeWorldAABB, aabbOverlap, aabbClearance,
  broadphaseCollisions, clearanceQuery,
  generateBOM, bomSummary,
  identity, fromTranslation, fromRotationX, fromRotationY, fromRotationZ,
  fromAxisAngle, multiply, invertRigid,
  transformPoint, transformDirection, extractPosition, transformsEqual,
  vec3Dot, vec3Cross, vec3Length, vec3Normalize, vec3Sub,
} from '../js/cad/assembly/index.js';

import { Assembly } from '../js/cad/Assembly.js';

// ── Harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    ${err.message}`);
  }
}

function approx(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `expected ${a} ≈ ${b} (tol ${tol})`);
}

function approxVec(a, b, tol = 1e-9) {
  approx(a.x, b.x, tol);
  approx(a.y, b.y, tol);
  approx(a.z, b.z, tol);
}

// Reset counters before tests
function resetAll() {
  resetPartDefinitionIds();
  resetPartInstanceIds();
  resetMateIds();
}

// ═════════════════════════════════════════════════════════════════════
console.log('Assembly Design MVP — Transform3D');
// ═════════════════════════════════════════════════════════════════════

test('identity is correct', () => {
  const m = identity();
  assert.strictEqual(m.length, 16);
  assert.strictEqual(m[0], 1); assert.strictEqual(m[5], 1);
  assert.strictEqual(m[10], 1); assert.strictEqual(m[15], 1);
  assert.strictEqual(m[1], 0); assert.strictEqual(m[3], 0);
});

test('fromTranslation', () => {
  const m = fromTranslation(1, 2, 3);
  const p = transformPoint(m, { x: 0, y: 0, z: 0 });
  approxVec(p, { x: 1, y: 2, z: 3 });
});

test('rotationX 90°', () => {
  const m = fromRotationX(Math.PI / 2);
  const p = transformPoint(m, { x: 0, y: 1, z: 0 });
  approxVec(p, { x: 0, y: 0, z: 1 });
});

test('rotationY 90°', () => {
  const m = fromRotationY(Math.PI / 2);
  const p = transformPoint(m, { x: 0, y: 0, z: 1 });
  approxVec(p, { x: 1, y: 0, z: 0 });
});

test('rotationZ 90°', () => {
  const m = fromRotationZ(Math.PI / 2);
  const p = transformPoint(m, { x: 1, y: 0, z: 0 });
  approxVec(p, { x: 0, y: 1, z: 0 });
});

test('multiply identity', () => {
  const a = fromTranslation(1, 2, 3);
  const b = identity();
  assert.ok(transformsEqual(multiply(a, b), a));
  assert.ok(transformsEqual(multiply(b, a), a));
});

test('multiply translation + rotation', () => {
  const t = fromTranslation(10, 0, 0);
  const r = fromRotationZ(Math.PI / 2);
  const m = multiply(t, r);
  // First rotate, then translate
  const p = transformPoint(m, { x: 1, y: 0, z: 0 });
  approxVec(p, { x: 10, y: 1, z: 0 });
});

test('invertRigid round-trip', () => {
  const m = multiply(fromTranslation(1, 2, 3), fromRotationY(0.5));
  const inv = invertRigid(m);
  const roundTrip = multiply(m, inv);
  assert.ok(transformsEqual(roundTrip, identity()));
});

test('transformDirection ignores translation', () => {
  const m = fromTranslation(100, 200, 300);
  const d = transformDirection(m, { x: 1, y: 0, z: 0 });
  approxVec(d, { x: 1, y: 0, z: 0 });
});

test('fromAxisAngle 90° about Z', () => {
  const m = fromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
  const p = transformPoint(m, { x: 1, y: 0, z: 0 });
  approxVec(p, { x: 0, y: 1, z: 0 });
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Data model');
// ═════════════════════════════════════════════════════════════════════

test('PartDefinition creation', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Bolt', material: 'Steel', mass: 0.05 });
  assert.strictEqual(def.name, 'Bolt');
  assert.strictEqual(def.material, 'Steel');
  approx(def.mass, 0.05);
  assert.ok(def.id.startsWith('partdef_'));
});

test('PartDefinition setBoundingBox', () => {
  const def = new PartDefinition({ name: 'Block' });
  def.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });
  assert.deepStrictEqual(def.boundingBox.min, { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual(def.boundingBox.max, { x: 10, y: 10, z: 10 });
});

test('PartInstance creation', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Nut' });
  const inst = new PartInstance(def, { grounded: true });
  assert.strictEqual(inst.definitionId, def.id);
  assert.strictEqual(inst.grounded, true);
  assert.ok(transformsEqual(inst.transform, identity()));
});

test('PartInstance setTransform', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Washer' });
  const inst = new PartInstance(def);
  const t = fromTranslation(5, 5, 5);
  inst.setTransform(t);
  assert.ok(transformsEqual(inst.transform, t));
});

test('Mate creation', () => {
  resetAll();
  const m = new Mate({
    type: MateType.COINCIDENT,
    instanceA: 'a',
    instanceB: 'b',
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 1, y: 0, z: 0 }),
  });
  assert.strictEqual(m.type, 'coincident');
  assert.strictEqual(m.dofRemoved, 3);
});

test('Feature constructors', () => {
  const pt = pointFeature({ x: 1, y: 2, z: 3 });
  assert.strictEqual(pt.type, 'point');
  assert.deepStrictEqual(pt.origin, { x: 1, y: 2, z: 3 });

  const ax = axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
  assert.strictEqual(ax.type, 'axis');
  approx(ax.direction.z, 1); // normalized

  const pl = planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 });
  assert.strictEqual(pl.type, 'plane');
  approx(pl.normal.y, 1); // normalized
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Mate solving');
// ═════════════════════════════════════════════════════════════════════

test('coincident point-point', () => {
  resetAll();
  const tA = fromTranslation(10, 0, 0);
  const tB = identity();
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: 'a', instanceB: 'b',
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });
  const solved = solveMate(mate, tA, tB);
  const pB = transformPoint(solved, { x: 0, y: 0, z: 0 });
  approxVec(pB, { x: 10, y: 0, z: 0 });
});

test('coincident point-point with offset features', () => {
  resetAll();
  const tA = identity();
  const tB = identity();
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: 'a', instanceB: 'b',
    featureA: pointFeature({ x: 5, y: 0, z: 0 }),
    featureB: pointFeature({ x: -3, y: 0, z: 0 }),
  });
  const solved = solveMate(mate, tA, tB);
  const pB = transformPoint(solved, { x: -3, y: 0, z: 0 });
  approxVec(pB, { x: 5, y: 0, z: 0 });
});

test('coincident plane-plane', () => {
  resetAll();
  const tA = identity();
  const tB = fromTranslation(0, 0, 5);
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: 'a', instanceB: 'b',
    featureA: planeFeature({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });
  const solved = solveMate(mate, tA, tB);
  const pB = transformPoint(solved, { x: 0, y: 0, z: 0 });
  // B's plane origin should be on A's plane at z=10
  approx(pB.z, 10);
});

test('concentric axes', () => {
  resetAll();
  const tA = identity();
  const tB = fromTranslation(5, 3, 0);
  const mate = new Mate({
    type: MateType.CONCENTRIC,
    instanceA: 'a', instanceB: 'b',
    featureA: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });
  const solved = solveMate(mate, tA, tB);
  const oB = extractPosition(solved);
  // Should have zero lateral offset (x, y near 0), z free
  approx(oB.x, 0);
  approx(oB.y, 0);
});

test('distance plane-plane', () => {
  resetAll();
  const tA = identity();
  const tB = fromTranslation(0, 0, 0);
  const mate = new Mate({
    type: MateType.DISTANCE,
    instanceA: 'a', instanceB: 'b',
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    value: 25,
  });
  const solved = solveMate(mate, tA, tB);
  const oB = transformPoint(solved, { x: 0, y: 0, z: 0 });
  approx(oB.z, 25);
});

test('angle between planes', () => {
  resetAll();
  const tA = identity();
  const tB = identity();
  const mate = new Mate({
    type: MateType.ANGLE,
    instanceA: 'a', instanceB: 'b',
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    value: Math.PI / 4, // 45 degrees
  });
  const solved = solveMate(mate, tA, tB);
  const nB = transformDirection(solved, { x: 0, y: 0, z: 1 });
  const nA = { x: 0, y: 0, z: 1 };
  const angle = Math.acos(Math.max(-1, Math.min(1, vec3Dot(nA, nB))));
  approx(angle, Math.PI / 4, 1e-6);
});

test('planar mate', () => {
  resetAll();
  const tA = identity();
  const tB = fromTranslation(5, 5, 10);
  const mate = new Mate({
    type: MateType.PLANAR,
    instanceA: 'a', instanceB: 'b',
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });
  const solved = solveMate(mate, tA, tB);
  const oB = transformPoint(solved, { x: 0, y: 0, z: 0 });
  // B should be on A's plane (z=0), but x/y free
  approx(oB.z, 0);
});

test('mateResidual zero for satisfied mate', () => {
  resetAll();
  const tA = fromTranslation(10, 0, 0);
  const tB = fromTranslation(10, 0, 0);
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: 'a', instanceB: 'b',
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });
  approx(mateResidual(mate, tA, tB), 0);
});

test('mateResidual non-zero for unsatisfied mate', () => {
  resetAll();
  const tA = identity();
  const tB = fromTranslation(5, 0, 0);
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: 'a', instanceB: 'b',
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });
  assert.ok(mateResidual(mate, tA, tB) > 0);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Hybrid solver');
// ═════════════════════════════════════════════════════════════════════

test('solver: grounded instance stays fixed', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Base' });
  const base = new PartInstance(def, { grounded: true, transform: fromTranslation(1, 2, 3) });
  const { transforms } = solveAssembly([base], []);
  assert.ok(transformsEqual(transforms.get(base.id), fromTranslation(1, 2, 3)));
});

test('solver: two parts with coincident point mate', () => {
  resetAll();
  const defA = new PartDefinition({ name: 'A' });
  const defB = new PartDefinition({ name: 'B' });
  const instA = new PartInstance(defA, { grounded: true });
  const instB = new PartInstance(defB, { transform: fromTranslation(100, 0, 0) });

  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: instA.id,
    instanceB: instB.id,
    featureA: pointFeature({ x: 5, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });

  const result = solveAssembly([instA, instB], [mate]);
  const pB = transformPoint(result.transforms.get(instB.id), { x: 0, y: 0, z: 0 });
  approxVec(pB, { x: 5, y: 0, z: 0 });
});

test('solver: three-part chain', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Link' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const c = new PartInstance(def);

  const m1 = new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 10, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });
  const m2 = new Mate({
    type: MateType.COINCIDENT,
    instanceA: b.id, instanceB: c.id,
    featureA: pointFeature({ x: 10, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });

  const result = solveAssembly([a, b, c], [m1, m2]);
  const pC = transformPoint(result.transforms.get(c.id), { x: 0, y: 0, z: 0 });
  approxVec(pC, { x: 20, y: 0, z: 0 });
});

test('solver: auto-ground first instance if none grounded', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Part' });
  const a = new PartInstance(def);
  const b = new PartInstance(def, { transform: fromTranslation(10, 0, 0) });

  const mate = new Mate({
    type: MateType.DISTANCE,
    instanceA: a.id, instanceB: b.id,
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    value: 5,
  });

  const result = solveAssembly([a, b], [mate]);
  // A should stay at origin (auto-grounded)
  const pA = extractPosition(result.transforms.get(a.id));
  approxVec(pA, { x: 0, y: 0, z: 0 });
  // B should be at distance 5 along X
  const pB = extractPosition(result.transforms.get(b.id));
  approx(pB.x, 5);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Deterministic replay');
// ═════════════════════════════════════════════════════════════════════

test('same mate sequence gives identical transforms', () => {
  resetAll();
  function buildAndSolve() {
    resetAll();
    const defA = new PartDefinition({ name: 'Base' });
    const defB = new PartDefinition({ name: 'Arm' });
    const defC = new PartDefinition({ name: 'Grip' });

    const a = new PartInstance(defA, { grounded: true });
    const b = new PartInstance(defB, { transform: fromTranslation(50, 50, 50) });
    const c = new PartInstance(defC, { transform: fromTranslation(-10, -10, -10) });

    const m1 = new Mate({
      type: MateType.COINCIDENT,
      instanceA: a.id, instanceB: b.id,
      featureA: pointFeature({ x: 10, y: 0, z: 0 }),
      featureB: pointFeature({ x: 0, y: 0, z: 0 }),
    });
    const m2 = new Mate({
      type: MateType.DISTANCE,
      instanceA: b.id, instanceB: c.id,
      featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
      featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
      value: 15,
    });

    return solveAssembly([a, b, c], [m1, m2]);
  }

  const r1 = buildAndSolve();
  const r2 = buildAndSolve();

  // Instance IDs are deterministic (counters reset)
  for (const [id, t1] of r1.transforms) {
    const t2 = r2.transforms.get(id);
    assert.ok(t2, `Missing transform for ${id}`);
    assert.ok(transformsEqual(t1, t2, 1e-9), `Transforms differ for ${id}`);
  }
});

test('replay with different initial positions converges to same result', () => {
  resetAll();
  function solve(bInitial) {
    resetAll();
    const def = new PartDefinition({ name: 'Part' });
    const a = new PartInstance(def, { grounded: true });
    const b = new PartInstance(def, { transform: bInitial });

    const mate = new Mate({
      type: MateType.COINCIDENT,
      instanceA: a.id, instanceB: b.id,
      featureA: pointFeature({ x: 20, y: 0, z: 0 }),
      featureB: pointFeature({ x: 0, y: 0, z: 0 }),
    });

    return solveAssembly([a, b], [mate]);
  }

  const r1 = solve(fromTranslation(0, 0, 0));
  const r2 = solve(fromTranslation(999, -999, 123));

  for (const [id, t1] of r1.transforms) {
    const t2 = r2.transforms.get(id);
    assert.ok(transformsEqual(t1, t2, 1e-9), `Transforms differ for ${id}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — DOF diagnostics');
// ═════════════════════════════════════════════════════════════════════

test('fully constrained assembly has DOF=0 and status ok', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Part' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def, { grounded: true });

  const result = solveAssembly([a, b], []);
  assert.strictEqual(result.diagnostics.totalDOF, 0);
  assert.strictEqual(result.diagnostics.status, 'ok');
});

test('under-constrained: free-floating part', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Part' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def); // not grounded, no mates

  const result = solveAssembly([a, b], []);
  assert.ok(result.diagnostics.totalDOF > 0);
  assert.strictEqual(result.diagnostics.status, 'under-constrained');
});

test('under-constrained: disconnected instance reported', () => {
  resetAll();
  const defA = new PartDefinition({ name: 'A' });
  const defB = new PartDefinition({ name: 'B' });
  const defC = new PartDefinition({ name: 'C' });
  const a = new PartInstance(defA, { grounded: true });
  const b = new PartInstance(defB);
  const c = new PartInstance(defC);

  // Only connect a → b, c is disconnected
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });

  const result = solveAssembly([a, b, c], [mate]);
  assert.ok(result.diagnostics.disconnected.includes(c.id));
  assert.strictEqual(result.diagnostics.status, 'under-constrained');
});

test('DOF accounting per instance', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Part' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);

  // Coincident removes 3 DOF from b → leaves 3
  const mate = new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });

  const result = solveAssembly([a, b], [mate]);
  const dofA = result.diagnostics.instanceDOF.find(d => d.id === a.id);
  const dofB = result.diagnostics.instanceDOF.find(d => d.id === b.id);
  assert.strictEqual(dofA.dof, 0); // grounded
  assert.strictEqual(dofB.dof, 3); // 6 - 3
});

test('concentric removes 4 DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Cylinder' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);

  const mate = new Mate({
    type: MateType.CONCENTRIC,
    instanceA: a.id, instanceB: b.id,
    featureA: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });

  const result = solveAssembly([a, b], [mate]);
  const dofB = result.diagnostics.instanceDOF.find(d => d.id === b.id);
  assert.strictEqual(dofB.dof, 2); // 6 - 4
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Collision detection');
// ═════════════════════════════════════════════════════════════════════

test('AABB overlap detection', () => {
  const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const b = { min: { x: 5, y: 5, z: 5 }, max: { x: 15, y: 15, z: 15 } };
  const c = { min: { x: 20, y: 20, z: 20 }, max: { x: 30, y: 30, z: 30 } };
  assert.ok(aabbOverlap(a, b));
  assert.ok(!aabbOverlap(a, c));
});

test('AABB clearance', () => {
  const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const b = { min: { x: 15, y: 0, z: 0 }, max: { x: 25, y: 10, z: 10 } };
  const cl = aabbClearance(a, b);
  approx(cl.x, 5); // 5 unit gap in X
  approx(cl.min, 5);
});

test('computeWorldAABB with identity', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Box' });
  def.setBoundingBox({ x: -1, y: -1, z: -1 }, { x: 1, y: 1, z: 1 });
  const inst = new PartInstance(def);
  const bb = computeWorldAABB(inst);
  approxVec(bb.min, { x: -1, y: -1, z: -1 });
  approxVec(bb.max, { x: 1, y: 1, z: 1 });
});

test('computeWorldAABB with rotation', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Box' });
  def.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const inst = new PartInstance(def, { transform: fromRotationZ(Math.PI / 2) });
  const bb = computeWorldAABB(inst);
  // After 90° Z rotation, X becomes Y
  approx(bb.max.y, 10, 1e-6);
  approx(bb.max.x, 0, 1e-6);
});

test('broadphaseCollisions: overlapping boxes', () => {
  resetAll();
  const defA = new PartDefinition({ name: 'A' });
  defA.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });
  const defB = new PartDefinition({ name: 'B' });
  defB.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });

  const a = new PartInstance(defA, { transform: identity() });
  const b = new PartInstance(defB, { transform: fromTranslation(5, 5, 5) });

  const collisions = broadphaseCollisions([a, b]);
  assert.strictEqual(collisions.length, 1);
  assert.strictEqual(collisions[0].a, a.id);
  assert.strictEqual(collisions[0].b, b.id);
});

test('broadphaseCollisions: separated boxes', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Box' });
  def.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });

  const a = new PartInstance(def, { transform: identity() });
  const b = new PartInstance(def, { transform: fromTranslation(100, 0, 0) });

  const collisions = broadphaseCollisions([a, b]);
  assert.strictEqual(collisions.length, 0);
});

test('clearanceQuery returns all pairs', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Box' });
  def.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });

  const a = new PartInstance(def);
  const b = new PartInstance(def, { transform: fromTranslation(5, 0, 0) });
  const c = new PartInstance(def, { transform: fromTranslation(10, 0, 0) });

  const results = clearanceQuery([a, b, c]);
  assert.strictEqual(results.length, 3); // C(3,2) = 3 pairs
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — BOM');
// ═════════════════════════════════════════════════════════════════════

test('generateBOM groups by definition', () => {
  resetAll();
  const bolt = new PartDefinition({ name: 'Bolt', material: 'Steel', mass: 0.01 });
  const plate = new PartDefinition({ name: 'Plate', material: 'Aluminum', mass: 2.0 });

  const instances = [
    new PartInstance(bolt),
    new PartInstance(bolt),
    new PartInstance(bolt),
    new PartInstance(plate),
  ];

  const bom = generateBOM([bolt, plate], instances);
  assert.strictEqual(bom.length, 2);

  const boltEntry = bom.find(e => e.name === 'Bolt');
  assert.strictEqual(boltEntry.quantity, 3);
  approx(boltEntry.totalMass, 0.03);

  const plateEntry = bom.find(e => e.name === 'Plate');
  assert.strictEqual(plateEntry.quantity, 1);
  approx(plateEntry.totalMass, 2.0);
});

test('bomSummary', () => {
  resetAll();
  const bolt = new PartDefinition({ name: 'Bolt', mass: 0.01 });
  const nut = new PartDefinition({ name: 'Nut', mass: 0.005 });

  const instances = [
    new PartInstance(bolt),
    new PartInstance(bolt),
    new PartInstance(nut),
    new PartInstance(nut),
  ];

  const bom = generateBOM([bolt, nut], instances);
  const summary = bomSummary(bom);
  assert.strictEqual(summary.totalParts, 4);
  assert.strictEqual(summary.uniqueParts, 2);
  approx(summary.totalMass, 0.03);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Assembly class integration');
// ═════════════════════════════════════════════════════════════════════

test('Assembly insertPart and solve', () => {
  resetAll();
  const asm = new Assembly('TestAsm');
  const defBase = new PartDefinition({ name: 'Base' });
  defBase.setBoundingBox({ x: -5, y: -5, z: -5 }, { x: 5, y: 5, z: 5 });
  const defArm = new PartDefinition({ name: 'Arm' });
  defArm.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 20, y: 2, z: 2 });

  const base = asm.insertPart(defBase, { grounded: true });
  const arm = asm.insertPart(defArm, { transform: fromTranslation(50, 0, 0) });

  asm.addMate(new Mate({
    type: MateType.COINCIDENT,
    instanceA: base.id,
    instanceB: arm.id,
    featureA: pointFeature({ x: 5, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  }));

  const result = asm.solve();
  const armPos = extractPosition(arm.transform);
  approxVec(armPos, { x: 5, y: 0, z: 0 });
  assert.ok(result.diagnostics);
});

test('Assembly removeInstance removes related mates', () => {
  resetAll();
  const asm = new Assembly('TestAsm');
  const def = new PartDefinition({ name: 'Part' });
  const a = asm.insertPart(def, { grounded: true });
  const b = asm.insertPart(def);
  const c = asm.insertPart(def);

  asm.addMate(new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  }));
  asm.addMate(new Mate({
    type: MateType.COINCIDENT,
    instanceA: b.id, instanceB: c.id,
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  }));

  assert.strictEqual(asm.mates.length, 2);
  asm.removeInstance(b.id);
  assert.strictEqual(asm.instances.length, 2);
  assert.strictEqual(asm.mates.length, 0); // both mates referenced b
});

test('Assembly detectCollisions', () => {
  resetAll();
  const asm = new Assembly('CollisionTest');
  const def = new PartDefinition({ name: 'Box' });
  def.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });

  asm.insertPart(def, { grounded: true });
  asm.insertPart(def, { transform: fromTranslation(5, 0, 0) });

  const collisions = asm.detectCollisions();
  assert.strictEqual(collisions.length, 1);
});

test('Assembly generateBOM', () => {
  resetAll();
  const asm = new Assembly('BOMTest');
  const bolt = new PartDefinition({ name: 'Bolt', mass: 0.01 });
  asm.insertPart(bolt);
  asm.insertPart(bolt);
  asm.insertPart(bolt);

  const bom = asm.generateBOM();
  assert.strictEqual(bom.length, 1);
  assert.strictEqual(bom[0].quantity, 3);
});

test('Assembly getBOMSummary', () => {
  resetAll();
  const asm = new Assembly('SummaryTest');
  const bolt = new PartDefinition({ name: 'Bolt', mass: 0.01 });
  const plate = new PartDefinition({ name: 'Plate', mass: 1.5 });
  asm.insertPart(bolt);
  asm.insertPart(bolt);
  asm.insertPart(plate);

  const summary = asm.getBOMSummary();
  assert.strictEqual(summary.totalParts, 3);
  assert.strictEqual(summary.uniqueParts, 2);
  approx(summary.totalMass, 1.52);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Serialization');
// ═════════════════════════════════════════════════════════════════════

test('Assembly serialize/deserialize round-trip', () => {
  resetAll();
  const asm = new Assembly('RoundTrip');
  asm.description = 'test assembly';
  const defA = new PartDefinition({ name: 'PartA', material: 'Steel', mass: 1 });
  defA.setBoundingBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });
  const defB = new PartDefinition({ name: 'PartB', material: 'Aluminum', mass: 0.5 });

  const a = asm.insertPart(defA, { grounded: true });
  const b = asm.insertPart(defB, { transform: fromTranslation(20, 0, 0) });

  asm.addMate(new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 10, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  }));

  const json = asm.serialize();
  const restored = Assembly.deserialize(json);

  assert.strictEqual(restored.name, 'RoundTrip');
  assert.strictEqual(restored.description, 'test assembly');
  assert.strictEqual(restored.definitions.size, 2);
  assert.strictEqual(restored.instances.length, 2);
  assert.strictEqual(restored.mates.length, 1);
  assert.strictEqual(restored.mates[0].type, MateType.COINCIDENT);
});

test('PartDefinition serialize/deserialize', () => {
  resetAll();
  const def = new PartDefinition({ name: 'Gear', material: 'Brass', mass: 0.25 });
  def.setBoundingBox({ x: -5, y: -5, z: -1 }, { x: 5, y: 5, z: 1 });
  const data = def.serialize();
  const restored = PartDefinition.deserialize(data);
  assert.strictEqual(restored.name, 'Gear');
  assert.strictEqual(restored.material, 'Brass');
  approx(restored.mass, 0.25);
  assert.deepStrictEqual(restored.boundingBox.min, { x: -5, y: -5, z: -1 });
});

test('Mate serialize/deserialize', () => {
  resetAll();
  const mate = new Mate({
    type: MateType.DISTANCE,
    instanceA: 'inst_1', instanceB: 'inst_2',
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
    value: 42,
  });
  const data = mate.serialize();
  const restored = Mate.deserialize(data);
  assert.strictEqual(restored.type, MateType.DISTANCE);
  assert.strictEqual(restored.value, 42);
  assert.strictEqual(restored.instanceA, 'inst_1');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\nAssembly Design MVP — Curated DOF suite');
// ═════════════════════════════════════════════════════════════════════

test('DOF suite: single grounded part → 0 DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const r = solveAssembly([a], []);
  assert.strictEqual(r.diagnostics.totalDOF, 0);
  assert.strictEqual(r.diagnostics.status, 'ok');
});

test('DOF suite: free part → 6 DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const r = solveAssembly([a, b], []);
  const bDof = r.diagnostics.instanceDOF.find(d => d.id === b.id);
  assert.strictEqual(bDof.dof, 6);
});

test('DOF suite: coincident → 3 remaining DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const m = new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });
  const r = solveAssembly([a, b], [m]);
  assert.strictEqual(r.diagnostics.instanceDOF.find(d => d.id === b.id).dof, 3);
});

test('DOF suite: concentric → 2 remaining DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const m = new Mate({
    type: MateType.CONCENTRIC,
    instanceA: a.id, instanceB: b.id,
    featureA: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });
  const r = solveAssembly([a, b], [m]);
  assert.strictEqual(r.diagnostics.instanceDOF.find(d => d.id === b.id).dof, 2);
});

test('DOF suite: distance → 5 remaining DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const m = new Mate({
    type: MateType.DISTANCE,
    instanceA: a.id, instanceB: b.id,
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    value: 10,
  });
  const r = solveAssembly([a, b], [m]);
  assert.strictEqual(r.diagnostics.instanceDOF.find(d => d.id === b.id).dof, 5);
});

test('DOF suite: angle → 5 remaining DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const m = new Mate({
    type: MateType.ANGLE,
    instanceA: a.id, instanceB: b.id,
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    value: Math.PI / 6,
  });
  const r = solveAssembly([a, b], [m]);
  assert.strictEqual(r.diagnostics.instanceDOF.find(d => d.id === b.id).dof, 5);
});

test('DOF suite: planar → 3 remaining DOF', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const m = new Mate({
    type: MateType.PLANAR,
    instanceA: a.id, instanceB: b.id,
    featureA: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: planeFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });
  const r = solveAssembly([a, b], [m]);
  assert.strictEqual(r.diagnostics.instanceDOF.find(d => d.id === b.id).dof, 3);
});

test('DOF suite: coincident + concentric → 0 remaining DOF (fully constrained)', () => {
  resetAll();
  const def = new PartDefinition({ name: 'P' });
  const a = new PartInstance(def, { grounded: true });
  const b = new PartInstance(def);
  const m1 = new Mate({
    type: MateType.COINCIDENT,
    instanceA: a.id, instanceB: b.id,
    featureA: pointFeature({ x: 0, y: 0, z: 0 }),
    featureB: pointFeature({ x: 0, y: 0, z: 0 }),
  });
  const m2 = new Mate({
    type: MateType.CONCENTRIC,
    instanceA: a.id, instanceB: b.id,
    featureA: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    featureB: axisFeature({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
  });
  // 3 (coincident) + 4 (concentric) = 7, clamped to 0
  const r = solveAssembly([a, b], [m1, m2]);
  assert.strictEqual(r.diagnostics.instanceDOF.find(d => d.id === b.id).dof, 0);
});

// ═════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
