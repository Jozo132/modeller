// js/cad/TessellationConfig.js — Global tessellation quality settings
//
// Provides a centralized configuration for tessellation quality across
// the entire CAD scene. All features inherit these settings instead of
// maintaining per-feature segment counts.
//
// See WASM_TESSELLATION_FEASIBILITY.md, Section 5.

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
   * @param {number} [opts.curveSegments=16]   - Arc/circle/ellipse/B-spline curve segments
   * @param {number} [opts.surfaceSegments=8]  - NURBS surface U/V subdivisions
   * @param {number} [opts.edgeSegments=16]    - Edge wireframe tessellation segments
   * @param {boolean} [opts.adaptiveSubdivision=true] - Enable adaptive refinement
   */
  constructor(opts = {}) {
    this.curveSegments = opts.curveSegments ?? 16;
    this.surfaceSegments = opts.surfaceSegments ?? 8;
    this.edgeSegments = opts.edgeSegments ?? 16;
    this.adaptiveSubdivision = opts.adaptiveSubdivision !== false;
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
