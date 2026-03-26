#!/usr/bin/env node
// tools/check-evaluator-bypass.js — Lint guard for GeometryEvaluator unification
//
// Scans core CAD source files for direct curve/surface evaluation calls that
// bypass GeometryEvaluator. Run as part of CI to ensure new code goes through
// the unified evaluator layer.
//
// Usage:
//   node tools/check-evaluator-bypass.js [--fix]
//
// Exit code:
//   0 — no bypass detected
//   1 — bypass detected (prints locations)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ─── Configuration ───────────────────────────────────────────────────

// Core files that MUST use GeometryEvaluator (no direct evaluate/normal)
const CORE_GLOBS = [
  'js/cad/CurveCurveIntersect.js',
  'js/cad/CurveSurfaceIntersect.js',
  'js/cad/SurfaceSurfaceIntersect.js',
  'js/cad/Containment.js',
  'js/cad/FaceSplitter.js',
  'js/cad/Tessellator2/EdgeSampler.js',
  'js/cad/Tessellator2/FaceTriangulator.js',
  'js/cad/Tessellator2/Refinement.js',
];

// Patterns that indicate direct bypass (when found in core files)
const BYPASS_PATTERNS = [
  // Direct curve evaluation (but not inside a class definition or GeometryEvaluator itself)
  { regex: /\bcurve\.evaluate\s*\(/g, description: 'direct curve.evaluate()' },
  { regex: /\bsurface\.evaluate\s*\(/g, description: 'direct surface.evaluate()' },
  { regex: /\bsurface\.normal\s*\(/g, description: 'direct surface.normal()' },
  { regex: /\b(?:surf[AB]|plane[AB]|cylinder)\.evaluate\s*\(/g, description: 'direct surfX.evaluate()' },
  { regex: /\b(?:surf[AB]|plane[AB]|cylinder)\.normal\s*\(/g, description: 'direct surfX.normal()' },
  { regex: /\b[cp][AB]\.evaluate\s*\(/g, description: 'direct cX.evaluate()' },
];

// Lines containing these are allowed (exceptions)
const ALLOWED_PATTERNS = [
  /GeometryEvaluator/,           // Using the evaluator correctly
  /typeof\s+.*evaluate/,         // Checking if method exists
  /\/\//,                        // Comment lines (partial — refined below)
  /surface\.evaluate\s*===\s*/,  // Type checking
  /\.evaluate\s*&&/,             // Conditional check
];

// ─── Scanner ─────────────────────────────────────────────────────────

let violations = 0;

for (const relPath of CORE_GLOBS) {
  const filePath = path.join(rootDir, relPath);
  if (!fs.existsSync(filePath)) continue;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Track catch block depth: lines inside catch blocks are allowed
  // (they represent last-resort fallback for degenerate geometry)
  let catchDepth = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();

    // Track catch blocks (simple brace counting after catch)
    if (/\bcatch\s*\(/.test(line)) catchDepth++;
    if (catchDepth > 0) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      // When we see the closing brace that ends the catch block, decrement
      if (closes > opens) catchDepth = Math.max(0, catchDepth - 1);
      // Skip lines inside catch blocks (intentional fallback)
      continue;
    }

    // Skip pure comment lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    for (const pattern of BYPASS_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        // Check allowed patterns
        const isAllowed = ALLOWED_PATTERNS.some(ap => ap.test(line));
        if (isAllowed) continue;

        violations++;
        console.log(`  ${relPath}:${lineIdx + 1}: ${pattern.description}`);
        console.log(`    ${trimmed}`);
      }
    }
  }
}

// ─── Report ──────────────────────────────────────────────────────────

if (violations === 0) {
  console.log('✓ No GeometryEvaluator bypasses detected in core files.');
  process.exit(0);
} else {
  console.log(`\n✗ ${violations} GeometryEvaluator bypass(es) detected.`);
  console.log('  Core evaluation must go through GeometryEvaluator.evalCurve/evalSurface.');
  console.log('  See js/cad/GeometryEvaluator.js for the unified API.');
  process.exit(1);
}
