// js/cad/StepImportFeature.js — Imported STEP solid feature
//
// Represents geometry imported from a STEP file as a parametric solid.
// The primary output is the exact B-Rep topology (TopoBody) extracted
// from the STEP file.  A tessellated display mesh is generated as a
// secondary post-processing step for UI rendering only.
// See ARCHITECTURE.md, Rules 1-4.

import { Feature, claimFeatureId } from './Feature.js';
import { importSTEP } from './StepImport.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { getFlag } from '../featureFlags.js';
import { telemetry } from '../telemetry.js';
import { globalTessConfig } from './TessellationConfig.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from './CbrepEncoding.js';

const _now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

function _measureSync(timings, key, label, fn) {
  const start = _now();
  try {
    return fn();
  } finally {
    timings[key] = telemetry.recordTimer(label, _now() - start, start);
  }
}

async function _measureAsync(timings, key, label, fn) {
  const start = _now();
  try {
    return await fn();
  } finally {
    timings[key] = telemetry.recordTimer(label, _now() - start, start);
  }
}

/**
 * StepImportFeature represents a solid body imported from a STEP file.
 * It produces a 'solid' result whose primary output is the exact
 * TopoBody; the tessellated mesh is for display only.
 */
export class StepImportFeature extends Feature {
  /**
   * @param {string} name - Feature name
   * @param {string} stepData - Raw STEP file contents
   * @param {Object} [options]
   * @param {number} [options.curveSegments=64] - Tessellation segments for curves
   */
  constructor(name = 'STEP Import', stepData = '', options = {}) {
    super(name);
    this.type = 'step-import';

    /** Raw STEP file string (stored for re-tessellation / serialization) */
    this.stepData = stepData;

    /** Tessellation quality */
    this.curveSegments = options.curveSegments ?? 64;

    /** Cached parsed mesh (set after first execute) */
    this._cachedMesh = null;

    /** Last execute timing snapshot */
    this._lastExecuteTimings = null;

    /** Last asynchronous IR cache timing snapshot */
    this._lastIrCacheTimings = null;

    /** Body instance currently represented by the last successful/pending IR write */
    this._shadowWriteBody = null;

    /** Most recent execution tree, used to attach late CBREP payloads */
    this._lastExecutionTree = null;
  }

  /**
   * Execute the feature: parse the STEP data and produce solid geometry.
   *
   * The primary output is the exact B-Rep topology (TopoBody).
   * The tessellated mesh is generated as post-processing for display only.
   *
   * @param {Object} _context - Execution context (unused — no dependencies)
   * @returns {{ type:'solid', geometry:Object, solid:Object, body:Object, volume:number, boundingBox:Object }}
   */
  execute(_context) {
    if (!this.stepData) {
      throw new Error('No STEP data provided');
    }

    this._lastExecutionTree = _context?.tree || null;

    const executeStart = _now();
    let cacheHit = true;

    // Re-use cached result unless global tessellation config changed
    const currentSegments = globalTessConfig.curveSegments;
    if (!this._cachedMesh || this._cachedMesh.curveSegments !== currentSegments) {
      cacheHit = false;
      const buildTimings = {};
      const buildStart = _now();
      const result = importSTEP(this.stepData, { curveSegments: currentSegments });
      const edgeResult = _measureSync(buildTimings, 'edgeAnalysisMs', 'step:feature:edge-analysis', () =>
        computeFeatureEdges(result.faces),
      );
      const volume = _measureSync(buildTimings, 'volumeMs', 'step:feature:volume', () =>
        this._estimateVolume({ faces: result.faces }),
      );
      const boundingBox = _measureSync(buildTimings, 'boundsMs', 'step:feature:bounds', () =>
        this._computeBoundingBox({ faces: result.faces }),
      );

      this._cachedMesh = {
        ...result,
        curveSegments: currentSegments,
        edgeResult,
        volume,
        boundingBox,
        featureTimings: {
          ...buildTimings,
          coldStartMs: telemetry.recordTimer('step:feature:cold-build', _now() - buildStart, buildStart),
        },
      };
    }

    // Primary output: exact B-Rep topology
    const body = this._cachedMesh.body;
    if (body) {
      for (const face of body.faces()) {
        face.shared = { sourceFeatureId: this.id };
      }

      if (this._irBytes && this._irHash && !this._shadowWriteBody) {
        this._shadowWriteBody = body;
      }

      // Shadow-write: canonicalize and cache the IR when flag is enabled.
      // Fire-and-forget — does not block the return path.
      if (getFlag('CAD_USE_IR_CACHE') && body !== this._shadowWriteBody) {
        this._shadowWriteIR(body);
      }
    }

    // Secondary output: tessellated display mesh
    const geometry = {
      vertices: this._cachedMesh.vertices,
      faces: this._cachedMesh.faces,
      edges: this._cachedMesh.edgeResult?.edges || [],
      paths: this._cachedMesh.edgeResult?.paths || [],
      visualEdges: this._cachedMesh.edgeResult?.visualEdges || [],
    };

    // Tag mesh faces with this feature's id
    for (const f of geometry.faces) {
      if (!f.shared) f.shared = { sourceFeatureId: this.id };
    }

    const timings = {
      cacheHit,
      totalMs: telemetry.recordTimer('step:feature:execute', _now() - executeStart, executeStart),
      coldStartMs: this._cachedMesh.featureTimings?.coldStartMs ?? 0,
      edgeAnalysisMs: this._cachedMesh.featureTimings?.edgeAnalysisMs ?? 0,
      volumeMs: this._cachedMesh.featureTimings?.volumeMs ?? 0,
      boundsMs: this._cachedMesh.featureTimings?.boundsMs ?? 0,
      import: this._cachedMesh.timings ? { ...this._cachedMesh.timings } : null,
      irCache: this._lastIrCacheTimings ? { ...this._lastIrCacheTimings } : null,
    };
    this._lastExecuteTimings = timings;

    return {
      type: 'solid',
      geometry,
      solid: { geometry, body },
      body,
      volume: this._cachedMesh.volume,
      boundingBox: this._cachedMesh.boundingBox,
      irHash: this._irHash || null,
      cbrepBuffer: this._irBytes || null,
      timings,
    };
  }

  /**
   * STEP-imported geometry must not be restored via the generic CBREP
   * fast-restore path. The JS-side CBREP roundtrip (readCbrep → TopoBody →
   * tessellateBody) produces visibly corrupt output because the restored
   * body loses analytic-surface metadata that the WASM STEP pipeline
   * originally attached (axes, xDirs, periodic-surface seam flags,
   * surfaceInfo for cylinders/cones/tori), and the JS tessellator falls
   * back to 3D CDT on faces whose UV domain becomes degenerate. Since the
   * raw STEP text is always kept in `this.stepData`, re-running execute()
   * on restore is both authoritative and cheap (importSTEP internally
   * caches by content hash).
   *
   * @returns {boolean} false — always force a full replay for this feature.
   */
  canFastRestoreFromCbrep() {
    return false;
  }

  _applyIrCachePayload(hash, buf) {
    this._irHash = hash;
    this._irBytes = buf;

    if (this.result && this.result.type === 'solid') {
      this.result.irHash = hash;
      this.result.cbrepBuffer = buf;
    }

    if (this._lastExecutionTree && typeof this._lastExecutionTree.attachCbrep === 'function') {
      this._lastExecutionTree.attachCbrep(this.id, buf, hash);
    }
  }

  /**
   * Shadow-write canonical IR to cache (fire-and-forget).
   * Gated by CAD_USE_IR_CACHE flag. Errors are silently ignored so
   * the legacy return path is never affected.
   *
   * On completion, sets:
   *   this._irHash  {string}      — 16-char hex content hash
   *   this._irBytes {ArrayBuffer} — canonical CBREP v0 payload
   *
   * @param {Object} body - TopoBody to serialize
   */
  _shadowWriteIR(body) {
    if (!body || body === this._shadowWriteBody) return;
    this._shadowWriteBody = body;
    this._lastIrCacheTimings = null;

    (async () => {
      const timings = {};
      const totalStart = _now();
      const { canonicalize } = await import('../../packages/ir/canonicalize.js');
      const { writeCbrep } = await import('../../packages/ir/writer.js');
      const { hashCbrep } = await import('../../packages/ir/hash.js');
      const canon = _measureSync(timings, 'canonicalizeMs', 'step:import:ir:canonicalize', () =>
        canonicalize(body),
      );
      const buf = _measureSync(timings, 'writeMs', 'step:import:ir:write', () =>
        writeCbrep(canon),
      );
      const hash = _measureSync(timings, 'hashMs', 'step:import:ir:hash', () =>
        hashCbrep(buf),
      );
      this._applyIrCachePayload(hash, buf);

      const mode = getFlag('CAD_IR_CACHE_MODE');
      if (mode === 'fs') {
        const { NodeFsCacheStore } = await import('../../packages/cache/NodeFsCacheStore.js');
        const store = new NodeFsCacheStore('.cbrep-cache');
        await _measureAsync(timings, 'storeMs', 'step:import:ir:store', async () => {
          await store.put(hash, buf);
        });
      } else if (mode === 'idb') {
        const { BrowserIdbCacheStore } = await import('../../packages/cache/BrowserIdbCacheStore.js');
        const store = new BrowserIdbCacheStore();
        await _measureAsync(timings, 'storeMs', 'step:import:ir:store', async () => {
          await store.put(hash, buf);
        });
      }
      // 'memory' and 'none': IR bytes kept on this._irBytes only
      this._lastIrCacheTimings = {
        mode,
        ...timings,
        totalMs: telemetry.recordTimer('step:import:ir:total', _now() - totalStart, totalStart),
      };
    })().catch(() => {
      // Shadow-write must never break the legacy path
      if (this._shadowWriteBody === body) {
        this._shadowWriteBody = null;
      }
    });
  }

  /**
   * Estimate volume from the mesh using the divergence theorem.
   */
  _estimateVolume(geometry) {
    let vol = 0;
    for (const face of geometry.faces) {
      const verts = face.vertices;
      if (verts.length < 3) continue;
      // Signed volume of tetrahedron formed with origin
      const a = verts[0], b = verts[1], c = verts[2];
      vol += (a.x * (b.y * c.z - b.z * c.y) +
              a.y * (b.z * c.x - b.x * c.z) +
              a.z * (b.x * c.y - b.y * c.x)) / 6;
    }
    return Math.abs(vol);
  }

  /**
   * Compute axis-aligned bounding box from geometry.
   */
  _computeBoundingBox(geometry) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const face of geometry.faces) {
      for (const v of face.vertices) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
      }
    }

    if (!isFinite(minX)) {
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }

    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };
  }

  // -------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------

  serialize() {
    const serialized = {
      ...super.serialize(),
      stepData: this.stepData,
      curveSegments: this.curveSegments,
      irHash: this._irHash || null,
    };

    if (this._irBytes) {
      serialized.cbrepPayload = arrayBufferToBase64(this._irBytes);
    }

    return serialized;
  }

  static deserialize(data) {
    const feature = new StepImportFeature();
    if (!data) return feature;

    // Restore base feature properties
    Object.assign(feature, Feature.deserialize(data));
    feature.type = 'step-import';

    // Restore STEP-specific properties
    feature.stepData = data.stepData || '';
    feature.curveSegments = data.curveSegments ?? 64;
    feature._irHash = data.irHash || null;
    if (data.cbrepPayload) {
      try {
        feature._irBytes = base64ToArrayBuffer(data.cbrepPayload);
      } catch {
        feature._irBytes = null;
      }
    }

    return feature;
  }
}
