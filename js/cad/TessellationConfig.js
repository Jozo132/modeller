// js/cad/TessellationConfig.js — Global tessellation quality settings
//
// Provides a centralized configuration for tessellation quality across
// the entire CAD scene. All features inherit these settings instead of
// maintaining per-feature segment counts.
//
// Usage:
//   import { globalTessConfig } from './TessellationConfig.js';
//   const segs = globalTessConfig.surfaceSegments; // always current
//   globalTessConfig.applyPreset('fine');           // updates everywhere
//
// The serialized `tessellator` field is retained for backward compatibility
// with older configs and diagnostics. The live runtime path is always
// native WASM / OCCT-first.
//
// Quality presets: draft, normal, fine, ultra

/**
 * Global tessellation quality configuration.
 *
 * All features in the scene should reference this config for their
 * tessellation resolution. Changing these values triggers a full
 * re-tessellation of the scene from cached exact topology.
 */
export class TessellationConfig {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.curveSegments=64]   - Arc/circle/ellipse/B-spline curve segments
   * @param {number} [opts.surfaceSegments=16]  - NURBS surface U/V subdivisions
  * @param {number} [opts.edgeSegments=64]    - Edge wireframe tessellation segments
  * @param {boolean} [opts.adaptiveSubdivision=true] - Enable adaptive refinement
  * @param {'legacy'|'robust'} [opts.tessellator='legacy'] - Compatibility-only serialized field; ignored by the live runtime route.
   */
  constructor(opts = {}) {
    this.curveSegments = opts.curveSegments ?? 64;
    this.surfaceSegments = opts.surfaceSegments ?? 16;
    this.edgeSegments = opts.edgeSegments ?? 64;
    this.adaptiveSubdivision = opts.adaptiveSubdivision !== false;
    /** @type {'legacy'|'robust'} */
    this.tessellator = opts.tessellator ?? 'legacy';
  }

  /**
   * Apply a named quality preset.
   * @param {'draft'|'normal'|'fine'|'ultra'} preset
   */
  applyPreset(preset) {
    switch (preset) {
      case 'draft':
        this.curveSegments = 8;
        this.surfaceSegments = 4;
        this.edgeSegments = 8;
        break;
      case 'normal':
        this.curveSegments = 16;
        this.surfaceSegments = 8;
        this.edgeSegments = 16;
        break;
      case 'fine':
        this.curveSegments = 32;
        this.surfaceSegments = 16;
        this.edgeSegments = 32;
        break;
      case 'ultra':
        this.curveSegments = 64;
        this.surfaceSegments = 32;
        this.edgeSegments = 64;
        break;
      default:
        break;
    }
  }

  /**
   * Get the current preset name, or 'custom' if values don't match a preset.
   * @returns {'draft'|'normal'|'fine'|'ultra'|'custom'}
   */
  getPreset() {
    if (this.curveSegments === 8 && this.surfaceSegments === 4 && this.edgeSegments === 8) return 'draft';
    if (this.curveSegments === 16 && this.surfaceSegments === 8 && this.edgeSegments === 16) return 'normal';
    if (this.curveSegments === 32 && this.surfaceSegments === 16 && this.edgeSegments === 32) return 'fine';
    if (this.curveSegments === 64 && this.surfaceSegments === 32 && this.edgeSegments === 64) return 'ultra';
    return 'custom';
  }

  /**
   * Serialize to a plain object.
   */
  serialize() {
    return {
      curveSegments: this.curveSegments,
      surfaceSegments: this.surfaceSegments,
      edgeSegments: this.edgeSegments,
      adaptiveSubdivision: this.adaptiveSubdivision,
      tessellator: this.tessellator,
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {Object} data
   * @returns {TessellationConfig}
   */
  static deserialize(data) {
    if (!data) return new TessellationConfig();
    return new TessellationConfig(data);
  }
}

// ─── Module-level global singleton ──────────────────────────────────
//
// Every call site that needs tessellation parameters imports this once.
// Part.tessellationConfig still exists for serialization into .cmod, but
// at runtime the global config is the authoritative source of truth.

/** @type {TessellationConfig} */
export const globalTessConfig = new TessellationConfig();

/**
 * Return the tessellation options object expected by tessellateBody /
 * tessellateBodyWasm / importSTEP.  Callers can spread or pass directly.
 *
 * @returns {{ edgeSegments: number, surfaceSegments: number, curveSegments: number }}
 */
export function getTessOptions() {
  return {
    edgeSegments: globalTessConfig.edgeSegments,
    surfaceSegments: globalTessConfig.surfaceSegments,
    curveSegments: globalTessConfig.curveSegments,
  };
}
