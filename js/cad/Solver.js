// js/cad/Solver.js — Removed legacy array-based sketch solver

export function solve() {
  throw new Error('The legacy solve(constraints, opts) entry point was removed. Use Scene.solve() with the native sketch-toolkit solver.');
}
