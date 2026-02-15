import assert from "assert";
import {
  init, render, getCommandBufferPtr, getCommandBufferLen,
  clearEntities, addEntitySegment, addEntityCircle, addEntityArc, addEntityPoint,
  setSnapPosition, setCursorPosition,
  clearSolver, addSolverPoint, addSolverConstraint, solveSolver,
  getSolverPointX, getSolverPointY, getSolverConverged, getSolverIterations,
  ENTITY_FLAG_VISIBLE, ENTITY_FLAG_SELECTED,
  SOLVER_COINCIDENT, SOLVER_HORIZONTAL, SOLVER_VERTICAL, SOLVER_DISTANCE,
} from "../build/debug.js";

// Initialize with a canvas size
init(800, 600);

// Render should produce a non-empty command buffer
render();
const len = getCommandBufferLen();
assert.ok(len > 0, "Command buffer should have content after render");
assert.ok(getCommandBufferPtr() > 0, "Command buffer pointer should be non-zero");

// --- Test 2D entity rendering ---
clearEntities();
const segIdx = addEntitySegment(0, 0, 100, 100, ENTITY_FLAG_VISIBLE, 1, 1, 1, 1);
assert.strictEqual(segIdx, 0, "First segment should have index 0");

const circIdx = addEntityCircle(50, 50, 25, ENTITY_FLAG_VISIBLE | ENTITY_FLAG_SELECTED, 0, 1, 0, 1);
assert.strictEqual(circIdx, 0, "First circle should have index 0");

const arcIdx = addEntityArc(0, 0, 10, 0, 3.14, ENTITY_FLAG_VISIBLE, 1, 0, 0, 1);
assert.strictEqual(arcIdx, 0, "First arc should have index 0");

const ptIdx = addEntityPoint(10, 20, 5, ENTITY_FLAG_VISIBLE, 1, 1, 0, 1);
assert.strictEqual(ptIdx, 0, "First point should have index 0");

// Render with entities
render();
const len2 = getCommandBufferLen();
assert.ok(len2 > len, "Command buffer should be larger with entities");

// --- Test constraint solver ---
clearSolver();
// Two points at (0,0) and (10,5) with coincident constraint
const p0 = addSolverPoint(0, 0, 1); // fixed
const p1 = addSolverPoint(10, 5, 0); // free
addSolverConstraint(SOLVER_COINCIDENT, p0, p1, -1, -1, 0);

const converged = solveSolver();
assert.strictEqual(converged, 1, "Solver should converge for coincident constraint");
assert.ok(getSolverConverged() === 1, "getSolverConverged should report converged");

// After solving, p1 should be at (0,0) since p0 is fixed
const x1 = getSolverPointX(p1);
const y1 = getSolverPointY(p1);
assert.ok(Math.abs(x1) < 1e-4, `Point 1 x should be ~0 after coincident, got ${x1}`);
assert.ok(Math.abs(y1) < 1e-4, `Point 1 y should be ~0 after coincident, got ${y1}`);

// --- Test horizontal constraint ---
clearSolver();
const ph0 = addSolverPoint(0, 0, 1); // fixed
const ph1 = addSolverPoint(100, 50, 0); // free
addSolverConstraint(SOLVER_HORIZONTAL, ph0, ph1, -1, -1, 0);
solveSolver();
const yh = getSolverPointY(ph1);
assert.ok(Math.abs(yh - 0) < 1e-4, `Point y should be ~0 after horizontal constraint, got ${yh}`);

// --- Test distance constraint ---
clearSolver();
const pd0 = addSolverPoint(0, 0, 1); // fixed
const pd1 = addSolverPoint(50, 0, 0); // free
addSolverConstraint(SOLVER_DISTANCE, pd0, pd1, -1, -1, 100);
solveSolver();
const xd = getSolverPointX(pd1);
const yd = getSolverPointY(pd1);
const dist = Math.sqrt(xd * xd + yd * yd);
assert.ok(Math.abs(dist - 100) < 0.01, `Distance should be ~100, got ${dist}`);

console.log("ok");
