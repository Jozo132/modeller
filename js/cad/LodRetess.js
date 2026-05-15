// js/cad/LodRetess.js — LoD band-change retessellation (H21 consumer)
//
// Wires `LodManager.onRetessellate(segsU, segsV)` → feature tree. When the
// camera-distance band crosses a threshold, every solid feature result in
// the active part needs its mesh re-triangulated at the new density. This
// is the consumer half of H21; the active path now always re-runs native
// tessellation at the new density instead of carrying JS incremental state
// across bands.
//
// Design choices:
// - DO NOT call `featureTree.executeAll()`. A band crossing changes only
//   tessellation density, not feature inputs, so the BRep kernel work
//   (booleans, fillets, chamfers) must NOT re-run. Retessellation here
//   operates on the already-computed `result.solid.topoBody` of each
//   feature.
// - `globalTessConfig` is updated BEFORE retessellating so downstream
//   consumers (`Tessellation.tessellateBody` default opts, StepImportWasm,
//   etc.) see the new segment count on their next call.
// - Density changes always retessellate from exact topology. No incremental
//   cache is carried across LoD bands on the live WASM path.
// - Failure is non-fatal per-feature: a thrown tessellator is logged and
//   the old geometry is preserved. This mirrors the defensive behavior of
//   `executeAll()`'s try/catch.

import { tessellateBody } from './Tessellation.js';
import { globalTessConfig } from './TessellationConfig.js';

/**
 * Retessellate every solid feature result in the part at a new LoD band.
 *
 * @param {object} part Part instance with `featureTree.features` + `.results`.
 * @param {number} segsU Edge (curve) segment count — a.k.a. LoD-U band.
 * @param {number} segsV Surface segment count — a.k.a. LoD-V band.
 * @param {object} [deps] Injection hook for tests. Defaults to the live
 *   `tessellateBody` + `globalTessConfig`.
 * @returns {{ retessellated: string[], skipped: string[], failed: string[] }}
 *   Lists of feature IDs per outcome. `retessellated` means a new mesh was
 *   stamped onto the result; `skipped` means the feature had no solid
 *   topology to work with; `failed` means tessellation threw (original
 *   geometry preserved).
 */
export function retessellateForLod(part, segsU, segsV, deps = {}) {
  const tess = deps.tessellateBody || tessellateBody;
  const cfg = deps.globalTessConfig || globalTessConfig;

  const result = { retessellated: [], skipped: [], failed: [] };
  if (!part || !part.featureTree) return result;

  // Clamp inputs to strictly-positive integers. LodManager always emits
  // valid bands, but callers may round-trip through a serialization layer
  // that reconstructs NaN/undefined/0.
  const sU = Number.isFinite(segsU) && segsU > 0 ? Math.round(segsU) : 0;
  const sV = Number.isFinite(segsV) && segsV > 0 ? Math.round(segsV) : 0;
  if (sU === 0 || sV === 0) return result;

  // Publish new density so every downstream tessellator call picks it up.
  // Three fields are kept in sync to match the existing tess-quality
  // dropdown handler in js/main.js:2174-2180.
  cfg.surfaceSegments = sV;
  cfg.edgeSegments = sU;
  cfg.curveSegments = sU;

  // Mirror onto the part's own tessellationConfig so .cmod serialization
  // captures the band-active density.
  if (part.tessellationConfig) {
    Object.assign(part.tessellationConfig, cfg);
  }

  const tree = part.featureTree;
  const features = Array.isArray(tree.features) ? tree.features : [];
  const results = tree.results || {};

  for (const feature of features) {
    const r = results[feature.id];
    if (!r || r.suppressed || r.error) {
      result.skipped.push(feature.id);
      continue;
    }
    const topoBody = r.solid?.topoBody || r.topoBody;
    if (!topoBody) {
      result.skipped.push(feature.id);
      continue;
    }

    try {
      const mesh = tess(topoBody, {
        validate: false,
        surfaceSegments: sV,
        edgeSegments: sU,
        // No `incrementalCache` here: a density change would invalidate
        // every face anyway (configKey mismatch), so passing it would just
        // be wasted allocation. Fresh tessellation is simpler and correct.
      });

      // Stamp the new mesh onto the result. Preserve the CBREP buffer,
      // handle metadata, and volume/boundingBox fields untouched — only
      // `geometry` and the `solid.geometry` alias should change on LoD.
      r.geometry = mesh;
      if (r.solid) r.solid.geometry = mesh;
      result.retessellated.push(feature.id);
    } catch (err) {
      // Non-fatal: keep the old geometry, let the next executeAll fix it.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[LodRetess] feature ${feature.id} retessellation failed:`, err?.message || err);
      }
      result.failed.push(feature.id);
    }
  }

  return result;
}
