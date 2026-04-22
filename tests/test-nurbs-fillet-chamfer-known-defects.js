import './_watchdog.mjs';
/**
 * tests/test-nurbs-fillet-chamfer-known-defects.js
 *
 * Runs ONLY the known-defect NURBS fillet/chamfer variants extracted from
 * test-nurbs-fillet-chamfer-variants.js. These tests are expected to fail
 * today — they exist to make regressions surface when the underlying
 * kernel defects are fixed, and to keep the fast-path variants file under
 * the per-file time budget.
 *
 * The healthy variants run in test-nurbs-fillet-chamfer-variants.js under
 * NURBS_VARIANTS_MODE=skip-defects (the default). This driver sets the
 * mode to defects-only and re-imports the shared suite.
 */
process.env.NURBS_VARIANTS_MODE = 'defects-only';
process.env.NURBS_VARIANTS_SECTIONS = '*';
await import('./test-nurbs-fillet-chamfer-variants.js');
