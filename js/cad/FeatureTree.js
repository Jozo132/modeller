// js/cad/FeatureTree.js — Manages the parametric feature tree
// The feature tree maintains an ordered list of features and handles:
// - Feature execution in dependency order
// - Recursive recalculation when features change
// - Dependency validation
// - Feature reordering

import { Feature } from './Feature.js';
import { DirtyFaceTracker, stampDirtyFieldsOnResult } from './DirtyFaceTracker.js';
import {
  createOcctSketchModelingCheckpoint,
  cloneOcctCheckpointMeshSnapshot,
  disposeOcctSketchModelingShape,
  rehydrateOcctFeatureDisplayGeometry,
  restoreOcctSketchModelingCheckpoint,
} from './occt/OcctSketchModeling.js';

/**
 * FeatureTree manages the ordered list of parametric features.
 * When a feature is modified, all dependent features are automatically recalculated.
 */
export class FeatureTree {
  constructor() {
    // Ordered list of features
    this.features = [];
    
    // Map of feature ID to feature object for fast lookup
    this.featureMap = new Map();
    
    // Execution results cache
    this.results = {};
    
    // Recalculation state
    this.isRecalculating = false;
    this.needsRecalculation = false;

    // Monotonic revision counter — bumped every time a solid result is produced.
    // Each solid result gets stamped with the current value as exactBodyRevisionId.
    this._revisionCounter = 0;

    // Optional WASM B-Rep handle registry. Set via setHandleRegistry().
    // When present, solid results get a wasmHandleId allocated on production
    // and released on replacement/removal.
    this._handleRegistry = null;

    // Optional residency manager for lazy CBREP restore and eviction.
    // Set via setResidencyManager(). Works alongside _handleRegistry.
    this._residencyManager = null;

    // Map from wasmHandleId (number) → featureId (string) for reverse lookup.
    // Needed because WASM setFeatureId takes u32 (revision counter), not a string.
    this._handleToFeatureId = new Map();

    // C3: dirty-face tracker. Every successful solid result is stamped with
    // allFacesDirty=true by default; features that know which faces they
    // mutated can opt in to discrete tracking via markFaceDirty / markFacesDirty
    // before the feature returns. Consumers (incremental tessellation cache,
    // render dirty-rect propagation) read result.allFacesDirty /
    // result.invalidatedFaceIds and then call clearDirtyFaces(featureId).
    this._dirtyFaces = new DirtyFaceTracker();

    // Optional dependency bundle for rebuilding display results from CBREP
    // checkpoints without replaying expensive feature operations.
    this._fastRestoreDeps = null;
  }

  // -----------------------------------------------------------------------
  // WASM B-Rep handle registry integration
  // -----------------------------------------------------------------------

  /**
   * Attach a WasmBrepHandleRegistry for automatic handle lifecycle management.
   * When set, solid results are stamped with exactBodyRevisionId and optionally
   * allocated a wasmHandleId that is released when the result is replaced.
   * @param {import('./WasmBrepHandleRegistry.js').WasmBrepHandleRegistry|null} registry
   */
  setHandleRegistry(registry) {
    this._handleRegistry = registry;
  }

  /**
   * Attach a HandleResidencyManager for lazy CBREP restore and eviction.
   * @param {import('./HandleResidencyManager.js').HandleResidencyManager|null} mgr
   */
  setResidencyManager(mgr) {
    this._residencyManager = mgr;
  }

  /**
   * Attach synchronous restore dependencies used by rollback/checkpoint paths.
   * @param {{ readCbrep: Function, tessellateBody: Function, computeFeatureEdges: Function, calculateMeshVolume: Function, calculateBoundingBox: Function }|null} deps
   */
  setFastRestoreDeps(deps) {
    this._fastRestoreDeps = this._hasValidFastRestoreDeps(deps) ? deps : null;
  }

  _hasValidFastRestoreDeps(deps) {
    return !!deps &&
      typeof deps.readCbrep === 'function' &&
      typeof deps.tessellateBody === 'function' &&
      typeof deps.computeFeatureEdges === 'function' &&
      typeof deps.calculateMeshVolume === 'function' &&
      typeof deps.calculateBoundingBox === 'function';
  }

  _getFeatureCbrepCacheVersion(feature) {
    if (!feature || typeof feature.getCbrepCacheVersion !== 'function') return null;
    const version = feature.getCbrepCacheVersion();
    return version == null ? null : String(version);
  }

  _isCbrepCheckpointCompatible(feature, entry) {
    const expectedVersion = this._getFeatureCbrepCacheVersion(feature);
    if (!expectedVersion) return true;
    return !!entry && entry.version === expectedVersion;
  }

  _hasOcctCheckpoint(entry) {
    return !!entry?.occt &&
      typeof entry.occt === 'object' &&
      typeof entry.occt.brep === 'string' &&
      entry.occt.brep.length > 0;
  }

  _getOcctCheckpointMeta(checkpoint) {
    const revision = checkpoint?.revision && typeof checkpoint.revision === 'object'
      ? checkpoint.revision
      : null;
    return {
      revisionId: revision?.revisionId ?? null,
      topologyHash: revision?.topologyHash ?? null,
    };
  }

  _getResultOcctHandle(result) {
    const handle = result?.occtShapeHandle || result?.geometry?.occtShapeHandle || 0;
    return Number.isInteger(handle) && handle > 0 ? handle : 0;
  }

  _rememberOcctCheckpoint(result, checkpoint) {
    if (!result || !checkpoint || typeof checkpoint !== 'object') return false;
    result.occtCheckpoint = checkpoint;
    const meta = this._getOcctCheckpointMeta(checkpoint);
    const topology = result._occtModeling?.topology || result.geometry?._occtModeling?.topology || null;
    const revisionId = meta.revisionId || topology?.revisionId || null;
    const topologyHash = meta.topologyHash || topology?.topologyHash || null;
    if (revisionId) result.occtRevisionId = revisionId;
    if (topologyHash) {
      result.occtTopologyHash = topologyHash;
      if (result.irHash == null) result.irHash = topologyHash;
    }
    return true;
  }

  _readOcctCheckpointVolume(restored, geometry) {
    const candidates = [
      restored?.volume,
      restored?.massProperties?.volume,
      restored?.properties?.volume,
      restored?.topology?.volume,
      geometry?._occtModeling?.topology?.volume,
    ];
    for (const candidate of candidates) {
      if (Number.isFinite(candidate)) return Number(candidate);
    }
    return null;
  }

  _readOcctCheckpointBoundingBox(restored, geometry) {
    const candidates = [
      restored?.boundingBox,
      restored?.massProperties?.boundingBox,
      restored?.properties?.boundingBox,
      restored?.topology?.boundingBox,
      geometry?._occtModeling?.topology?.boundingBox,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') return candidate;
    }
    return null;
  }

  _ensureSolidResultOcctCheckpoint(result) {
    if (!result || result.type !== 'solid') return false;
    if (this._hasOcctCheckpoint({ occt: result.occtCheckpoint })) {
      return this._rememberOcctCheckpoint(result, result.occtCheckpoint);
    }

    const handle = this._getResultOcctHandle(result);
    if (!handle) return false;

    try {
      const checkpoint = createOcctSketchModelingCheckpoint(handle);
      return this._rememberOcctCheckpoint(result, checkpoint);
    } catch (err) {
      result._occtCheckpointError = err?.message || String(err);
      return false;
    }
  }

  _normalizeLiveSolidResultFromOcctCheckpoint(featureId, feature, result) {
    if (!feature || !result || result.type !== 'solid') return result;
    if (feature.type !== 'fillet' && feature.type !== 'chamfer') return result;
    if (!this._ensureSolidResultOcctCheckpoint(result)) return result;

    try {
      const restored = this._buildSolidResultFromOcctCheckpoint(
        featureId,
        result.occtCheckpoint,
        null,
        this._getFeatureCbrepCacheVersion(feature),
      );
      if (restored?.geometry && result.geometry) {
        restored.geometry._selectionCompatEdges = Array.isArray(result.geometry.edges) ? result.geometry.edges : [];
        restored.geometry._selectionCompatPaths = Array.isArray(result.geometry.paths) ? result.geometry.paths : [];
        restored.geometry._selectionCompatOcctFeatureEdges = Array.isArray(result.geometry._occtFeatureEdges)
          ? result.geometry._occtFeatureEdges
          : [];
        restored.geometry._selectionCompatOcctFeaturePaths = Array.isArray(result.geometry._occtFeaturePaths)
          ? result.geometry._occtFeaturePaths
          : [];
      }
      this._releaseResultHandle(result, featureId);
      return restored;
    } catch (error) {
      result._occtCheckpointRestoreError = error?.message || String(error);
      return result;
    }
  }

  /**
   * Attach a CBREP payload to an existing solid result after asynchronous IR
   * production completes, and mirror it into residency for lazy restore.
   * @param {string} featureId
   * @param {ArrayBuffer|Uint8Array} cbrepBuffer
   * @param {string|number|null} [irHash=null]
   * @returns {boolean}
   */
  attachCbrep(featureId, cbrepBuffer, irHash = null) {
    const feature = this.featureMap.get(featureId);
    const result = this.results[featureId];
    if (!feature || !result || result.type !== 'solid' || !cbrepBuffer) {
      return false;
    }

    result.cbrepBuffer = cbrepBuffer;
    if (irHash != null) {
      result.irHash = irHash;
    }
    const cacheVersion = this._getFeatureCbrepCacheVersion(feature);
    if (cacheVersion) result.cbrepCacheVersion = cacheVersion;

    if (this._residencyManager) {
      this._residencyManager.storeCbrep(featureId, cbrepBuffer, result.irHash ?? 0);
      this._residencyManager.markAccessed(featureId);
    }

    // H1: Hydrate the CBREP into the live WASM handle so the exact body is
    // actually resident in the kernel instead of staying UNMATERIALIZED.
    // Without this, attachCbrep stores bytes but the handle never becomes
    // queryable — residency is plumbed but never pays off.
    const reg = this._handleRegistry;
    const handleId = result.wasmHandleId;
    if (reg && reg.ready && handleId && typeof reg.hydrateForHandle === 'function') {
      const bytes = cbrepBuffer instanceof Uint8Array
        ? cbrepBuffer
        : new Uint8Array(cbrepBuffer);
      if (bytes.byteLength > 0) {
        if (typeof reg.setResidency === 'function' && reg.HYDRATING !== undefined) {
          reg.setResidency(handleId, reg.HYDRATING);
        }
        const ok = reg.hydrateForHandle(handleId, bytes);
        if (ok) {
          if (typeof reg.setResidency === 'function' && reg.RESIDENT !== undefined) {
            reg.setResidency(handleId, reg.RESIDENT);
          }
          if (typeof reg.bumpRevision === 'function') {
            reg.bumpRevision(handleId);
          }
          result.wasmHandleResident = true;
        } else if (typeof reg.setResidency === 'function' && reg.STALE !== undefined) {
          reg.setResidency(handleId, reg.STALE);
          result.wasmHandleResident = false;
        }
      }
    }

    return true;
  }

  /**
   * H3/H4: For every existing solid result that already carries a CBREP
   * payload, allocate a handle in the currently-attached registry and hydrate
   * it. Returns true when every solid result was restored from cache; false
   * if at least one solid result lacked a CBREP (in which case the caller
   * must fall back to replay).
   *
   * This lets `setWasmHandleSubsystem` avoid calling `executeAll()` when the
   * feature tree was just deserialized with cached CBREPs.
   *
   * @returns {boolean} true if the entire tree is now handle-resident.
   */
  hydrateExistingResultsFromCbrep() {
    const reg = this._handleRegistry;
    if (!reg || !reg.ready) return false;
    if (typeof reg.hydrateForHandle !== 'function' || typeof reg.alloc !== 'function') {
      return false;
    }

    let allResident = true;
    for (const feature of this.features) {
      const result = this.results[feature.id];
      if (!result || result.type !== 'solid') continue;

      const cbrep = result.cbrepBuffer;
      if (!cbrep) {
        allResident = false;
        continue;
      }

      // Release any stale handle that may still be stamped on the result
      // from a previous registry before we allocate a fresh one here.
      if (result.wasmHandleId && typeof reg.release === 'function') {
        reg.release(result.wasmHandleId);
        this._handleToFeatureId.delete(result.wasmHandleId);
        result.wasmHandleId = 0;
      }

      const handle = reg.alloc();
      if (!handle) {
        allResident = false;
        continue;
      }

      this._revisionCounter++;
      result.exactBodyRevisionId = this._revisionCounter;
      result.wasmHandleId = handle;
      if (typeof reg.setFeatureId === 'function') {
        reg.setFeatureId(handle, this._revisionCounter);
      }
      this._handleToFeatureId.set(handle, feature.id);

      const bytes = cbrep instanceof Uint8Array ? cbrep : new Uint8Array(cbrep);
      if (typeof reg.setResidency === 'function' && reg.HYDRATING !== undefined) {
        reg.setResidency(handle, reg.HYDRATING);
      }
      const ok = reg.hydrateForHandle(handle, bytes);
      if (ok) {
        if (typeof reg.setResidency === 'function' && reg.RESIDENT !== undefined) {
          reg.setResidency(handle, reg.RESIDENT);
        }
        if (typeof reg.bumpRevision === 'function') {
          reg.bumpRevision(handle);
        }
        result.wasmHandleResident = true;
        if (this._residencyManager) {
          this._residencyManager.storeCbrep(feature.id, cbrep, result.irHash ?? 0);
          this._residencyManager.markAccessed(feature.id);
        }
      } else {
        if (typeof reg.setResidency === 'function' && reg.STALE !== undefined) {
          reg.setResidency(handle, reg.STALE);
        }
        result.wasmHandleResident = false;
        allResident = false;
      }
    }
    return allResident;
  }

  /**
  * Fast-restore solid results directly from serialized OCCT checkpoints
  * without running `executeAll()`. Sketch features still execute (cheap —
  * just constraint-solving) so downstream code that reads
  * `context.results[sketchId].sketch` still works.
   *
  * Returns true when every non-sketch feature was restored from a compatible
  * checkpoint and the tree is fully populated. Returns false (without
  * mutating `this.results`) when any solid feature lacks a usable
  * checkpoint, so the caller can fall back to `executeAll()`.
   *
  * @param {Object|null|undefined} checkpoints - serialized { [id]: { occt? } }
   * @param {Object|null|undefined} deps
   * @returns {boolean}
   */
  tryFastRestoreFromCheckpoints(checkpoints, deps) {
    if (!checkpoints || typeof checkpoints !== 'object') return false;

    // Coverage pre-check — do NOT mutate state until we know every required
    // checkpoint is present and decodes. Sketch features and suppressed
    // features don't need checkpoints.
    for (const feature of this.features) {
      if (feature.suppressed) continue;
      if (feature.type === 'sketch') continue;
      const entry = checkpoints[feature.id];
      if (!this._hasOcctCheckpoint(entry)) return false;
    }

    // Build results in order. Sketch features run their execute(); solid
    // features are rebuilt from OCCT checkpoints. Any failure aborts and
    // returns false after restoring the pre-call state.
    const savedResults = this.results;
    this.results = {};

    try {
      for (const feature of this.features) {
        if (feature.suppressed) {
          this.results[feature.id] = { suppressed: true };
          continue;
        }

        if (feature.type === 'sketch') {
          const context = { results: this.results, tree: this };
          if (!feature.canExecute(context)) {
            feature.error = 'Dependencies not satisfied';
            this.results[feature.id] = { error: feature.error };
            continue;
          }
          const sketchResult = feature.execute(context);
          feature.result = sketchResult;
          feature.error = null;
          this.results[feature.id] = sketchResult;
          continue;
        }

        const entry = checkpoints[feature.id];
        const result = this._buildSolidResultFromSerializedCheckpoint(
          feature.id,
          feature,
          entry,
          deps,
          this._getFeatureCbrepCacheVersion(feature),
        );
        feature.result = result;
        feature.error = null;
        if (feature._irHash == null && result.irHash != null) {
          feature._irHash = result.irHash;
        }
        this._stampSolidResult(feature.id, result);
        this.results[feature.id] = result;
      }
    } catch (err) {
      // Restore prior state and let caller fall back to executeAll().
      // Release any handles allocated during the aborted fast-restore first.
      for (const fid of Object.keys(this.results)) {
        this._releaseResultHandle(this.results[fid], fid);
      }
      this.results = savedResults;
      console.warn(`[FeatureTree] fast-restore aborted: ${err && err.message}`);
      return false;
    }

    return true;
  }

  /**
   * Stamp a solid result with revision metadata and (optionally) allocate a
   * WASM handle. Called internally after each successful feature execution.
   * @param {string} featureId
   * @param {Object} result
   */
  _stampSolidResult(featureId, result) {
    if (!result || result.type !== 'solid') return;

    // Assign a monotonic revision id
    this._revisionCounter++;
    result.exactBodyRevisionId = this._revisionCounter;

    const feature = this.featureMap.get(featureId);
    this._ensureSolidResultCheckpoint(featureId, result, feature);

    // Propagate irHash from the feature instance if available
    if (feature && feature._irHash) {
      result.irHash = feature._irHash;
    }

    // Adopt a WASM handle if the feature produced one natively. This keeps
    // direct kernel feature builders resident instead of allocating a second
    // unmaterialized handle that would need CBREP hydration later.
    if (this._handleRegistry && this._handleRegistry.ready) {
      const reg = this._handleRegistry;
      const existingHandle = result.wasmHandleId || result.geometry?.wasmHandleId || 0;
      if (existingHandle && typeof reg.isValid === 'function' && reg.isValid(existingHandle)) {
        result.wasmHandleId = existingHandle;
        result.wasmHandleResident = true;
        if (result.geometry) {
          result.geometry.wasmHandleId = existingHandle;
          result.geometry.wasmHandleResident = true;
        }
        if (typeof reg.setResidency === 'function') reg.setResidency(existingHandle, reg.RESIDENT);
        reg.setFeatureId(existingHandle, this._revisionCounter);
        reg.bumpRevision(existingHandle);
        this._handleToFeatureId.set(existingHandle, featureId);
      } else {
        const handle = reg.alloc();
        if (handle !== 0) {
          result.wasmHandleId = handle;
          reg.setResidency(handle, reg.UNMATERIALIZED);
          reg.setFeatureId(handle, this._revisionCounter);
          reg.bumpRevision(handle);
          // Maintain JS-side reverse lookup: handle → featureId (string)
          this._handleToFeatureId.set(handle, featureId);
        }
      }
    }

    if (this._residencyManager) {
      this._residencyManager.markAccessed(featureId);
    }

    // C3: default every new solid result to allFacesDirty=true. Feature
    // execute() implementations that report discrete face-level mutations
    // (via DirtyFaceTracker.markFacesDirty before returning) will override
    // this default; for now the whole-body signal matches legacy behavior.
    if (!result._dirtyOverride) {
      this._dirtyFaces.markAllDirty(featureId);
    }
    stampDirtyFieldsOnResult(result, featureId, this._dirtyFaces);
  }

  _ensureSolidResultCheckpoint(featureId, result, feature = null) {
    if (!result || result.type !== 'solid') return false;
    const captured = this._ensureSolidResultOcctCheckpoint(result);
    if (captured && feature && !feature._irHash && result.irHash) {
      feature._irHash = result.irHash;
    }
    return captured;
  }

  _buildSolidResultFromSerializedCheckpoint(featureId, feature, entry, deps, cbrepCacheVersion = null) {
    if (this._hasOcctCheckpoint(entry)) {
      return this._buildSolidResultFromOcctCheckpoint(
        featureId,
        entry.occt,
        deps,
        cbrepCacheVersion,
        this._cloneOcctDisplayMeshSnapshot(entry.mesh),
      );
    }
    throw new Error(`missing OCCT checkpoint for ${featureId}`);
  }

  _cloneOcctDisplayMeshSnapshot(mesh) {
    return cloneOcctCheckpointMeshSnapshot(mesh);
  }

  _serializeOcctDisplayMeshSnapshot(geometry) {
    if (!geometry || !Array.isArray(geometry.faces) || geometry.faces.length === 0) return null;
    const snapshot = {
      faces: geometry.faces,
      edges: Array.isArray(geometry.edges) ? geometry.edges : [],
      paths: Array.isArray(geometry.paths) ? geometry.paths : [],
      visualEdges: Array.isArray(geometry.visualEdges) ? geometry.visualEdges : [],
    };
    if (Array.isArray(geometry._occtFeatureEdges)) snapshot._occtFeatureEdges = geometry._occtFeatureEdges;
    if (Array.isArray(geometry._occtFeaturePaths)) snapshot._occtFeaturePaths = geometry._occtFeaturePaths;
    if (Array.isArray(geometry._selectionCompatEdges)) snapshot._selectionCompatEdges = geometry._selectionCompatEdges;
    if (Array.isArray(geometry._selectionCompatPaths)) snapshot._selectionCompatPaths = geometry._selectionCompatPaths;
    if (Array.isArray(geometry._selectionCompatOcctFeatureEdges)) snapshot._selectionCompatOcctFeatureEdges = geometry._selectionCompatOcctFeatureEdges;
    if (Array.isArray(geometry._selectionCompatOcctFeaturePaths)) snapshot._selectionCompatOcctFeaturePaths = geometry._selectionCompatOcctFeaturePaths;
    if (geometry._occtModeling && typeof geometry._occtModeling === 'object') snapshot._occtModeling = geometry._occtModeling;
    if (geometry._occt && typeof geometry._occt === 'object') snapshot._occt = geometry._occt;
    if (geometry._tessellator != null) snapshot._tessellator = geometry._tessellator;
    return this._cloneOcctDisplayMeshSnapshot(snapshot);
  }

  _buildSolidResultFromOcctCheckpoint(featureId, checkpoint, deps, cbrepCacheVersion = null, meshSnapshot = null) {
    const feature = this.featureMap.get(featureId) || null;
    const restored = restoreOcctSketchModelingCheckpoint(checkpoint, null, meshSnapshot);
    const geometry = restored?.geometry || restored?.mesh || null;
    if (!geometry || !Array.isArray(geometry.faces) || geometry.faces.length === 0) {
      throw new Error(`empty OCCT checkpoint restore for ${featureId}`);
    }
    if (!(restored?.occtShapeHandle > 0)) {
      throw new Error(`missing OCCT handle after checkpoint restore for ${featureId}`);
    }

    const hasNativeFeatureEdges = Array.isArray(geometry.edges) && geometry.edges.length > 0
      && Array.isArray(geometry.paths) && geometry.paths.length > 0;
    if (!Array.isArray(geometry.edges)) geometry.edges = [];
    if (!Array.isArray(geometry.paths)) geometry.paths = [];
    if (!Array.isArray(geometry.visualEdges)) geometry.visualEdges = geometry.edges;
    if (!hasNativeFeatureEdges) {
      geometry._occtMissingFeatureEdges = true;
    }

    if (feature && (feature.type === 'fillet' || feature.type === 'chamfer')) {
      const sourceResult = this._getPreviousSolidCheckpointSourceResult(featureId);
      const sourceTopology = sourceResult?.geometry?._occtModeling?.topology || null;
      rehydrateOcctFeatureDisplayGeometry(geometry, feature.type, sourceTopology);
    }

    const volume = this._readOcctCheckpointVolume(restored, geometry);
    const boundingBox = this._readOcctCheckpointBoundingBox(restored, geometry);

    const result = {
      type: 'solid',
      geometry,
      solid: { geometry, body: geometry.topoBody || null },
      body: geometry.topoBody || null,
      volume,
      boundingBox,
      occtShapeHandle: restored.occtShapeHandle,
      occtShapeResident: true,
      _occtModeling: restored._occtModeling || geometry._occtModeling || null,
      occtCheckpoint: checkpoint,
      _restoredFromCheckpoint: true,
    };
    if (cbrepCacheVersion) result.cbrepCacheVersion = cbrepCacheVersion;
    this._rememberOcctCheckpoint(result, checkpoint);
    return result;
  }

  _getPreviousSolidCheckpointSourceResult(featureId) {
    const featureIndex = this.getFeatureIndex(featureId);
    if (featureIndex < 0) return null;
    for (let index = featureIndex - 1; index >= 0; index -= 1) {
      const feature = this.features[index];
      if (!feature || feature.suppressed) continue;
      const result = this.results[feature.id];
      if (result && result.type === 'solid' && !result.error) {
        return result;
      }
    }
    return null;
  }

  _restoreSolidResultFromCheckpoint(featureId, deps = this._fastRestoreDeps) {
    const feature = this.featureMap.get(featureId);
    const oldResult = this.results[featureId];
    if (!feature || !oldResult || oldResult.type !== 'solid') return false;
    const hasOcctCheckpoint = this._hasOcctCheckpoint({ occt: oldResult.occtCheckpoint });
    if (!hasOcctCheckpoint) return false;

    let nextResult;
    try {
      nextResult = this._buildSolidResultFromOcctCheckpoint(featureId, oldResult.occtCheckpoint, deps, this._getFeatureCbrepCacheVersion(feature));
    } catch (err) {
      oldResult._checkpointRestoreError = err?.message || String(err);
      return false;
    }

    this._releaseResultHandle(oldResult, featureId);
    feature.result = nextResult;
    feature.error = null;
    if (feature._irHash == null && nextResult.irHash != null) {
      feature._irHash = nextResult.irHash;
    }
    this._stampSolidResult(featureId, nextResult);
    this.results[featureId] = nextResult;
    return true;
  }

  /**
   * Release the WASM handle associated with an old result being replaced.
   * @param {Object} oldResult
   */
  _releaseResultHandle(oldResult, featureId) {
    if (!oldResult) return;
    if (oldResult.wasmHandleId) {
      if (this._handleRegistry && this._handleRegistry.ready) {
        this._handleRegistry.release(oldResult.wasmHandleId);
        this._handleToFeatureId.delete(oldResult.wasmHandleId);
        oldResult.wasmHandleId = 0;
      }
    }
    const occtHandle = oldResult.occtShapeHandle || oldResult.geometry?.occtShapeHandle || 0;
    if (occtHandle) {
      disposeOcctSketchModelingShape(occtHandle);
      oldResult.occtShapeHandle = 0;
      if (oldResult.geometry) oldResult.geometry.occtShapeHandle = 0;
    }
    if (featureId && this._residencyManager) {
      this._residencyManager.remove(featureId);
    }
  }

  // -----------------------------------------------------------------------
  // Feature management
  // -----------------------------------------------------------------------

  /**
   * Add a feature to the tree.
   * @param {Feature} feature - The feature to add
   * @param {number} index - Optional index to insert at (default: append)
   * @returns {Feature} The added feature
   */
  addFeature(feature, index = -1) {
    if (!feature) return null;
    
    // Validate dependencies exist
    for (const depId of feature.getDependencies()) {
      if (!this.featureMap.has(depId)) {
        throw new Error(`Cannot add feature ${feature.name}: dependency ${depId} not found`);
      }
    }
    
    // Add to tree
    if (index >= 0 && index < this.features.length) {
      this.features.splice(index, 0, feature);
    } else {
      this.features.push(feature);
    }
    
    this.featureMap.set(feature.id, feature);
    
    // Recalculate from this feature onward
    this.recalculateFrom(feature.id);
    
    return feature;
  }

  /**
   * Remove a feature from the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID to remove
   * @returns {boolean} True if removed
   */
  removeFeature(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    
    if (!feature) return false;
    
    // Check if any other features depend on this one
    const dependents = this.getDependents(featureId);
    if (dependents.length > 0) {
      const names = dependents.map(f => f.name).join(', ');
      throw new Error(`Cannot remove feature ${feature.name}: other features depend on it (${names})`);
    }
    
    // Remove from tree
    const idx = this.features.indexOf(feature);
    if (idx >= 0) {
      this.features.splice(idx, 1);
    }
    
    this.featureMap.delete(featureId);
    this._releaseResultHandle(this.results[featureId], featureId);
    delete this.results[featureId];
    this._dirtyFaces.clear(featureId);
    
    return true;
  }

  /**
   * Get a feature by ID.
   * @param {string} featureId - The feature ID
   * @returns {Feature|null} The feature or null if not found
   */
  getFeature(featureId) {
    return this.featureMap.get(featureId) || null;
  }

  /**
   * Get the index of a feature in the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID
   * @returns {number} Index or -1 if not found
   */
  getFeatureIndex(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    return feature ? this.features.indexOf(feature) : -1;
  }

  /**
   * Reorder a feature in the tree.
   * @param {string|Feature} featureOrId - Feature or feature ID to move
   * @param {number} newIndex - New index position
   * @returns {boolean} True if reordered
   */
  reorderFeature(featureOrId, newIndex) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    
    if (!feature) return false;
    
    const oldIndex = this.features.indexOf(feature);
    if (oldIndex < 0 || newIndex < 0 || newIndex >= this.features.length) {
      return false;
    }
    
    // Validate reordering won't break dependencies
    if (!this.canReorder(featureId, newIndex)) {
      throw new Error(`Cannot reorder feature ${feature.name}: would break dependencies`);
    }
    
    // Perform reorder
    this.features.splice(oldIndex, 1);
    this.features.splice(newIndex, 0, feature);
    
    // Recalculate from the earlier of the two positions
    const recalcFrom = Math.min(oldIndex, newIndex);
    if (recalcFrom < this.features.length) {
      this.recalculateFrom(this.features[recalcFrom].id);
    }
    
    return true;
  }

  /**
   * Check if a feature can be reordered to a new position.
   * @param {string} featureId - Feature ID
   * @param {number} newIndex - Proposed new index
   * @returns {boolean} True if reordering is valid
   */
  canReorder(featureId, newIndex) {
    const feature = this.featureMap.get(featureId);
    if (!feature) return false;
    
    // Check all dependencies come before the new position
    for (const depId of feature.getDependencies()) {
      const depIndex = this.getFeatureIndex(depId);
      if (depIndex >= newIndex) {
        return false; // Dependency would be after this feature
      }
    }
    
    // Check all dependents come after the new position
    const dependents = this.getDependents(featureId);
    for (const dependent of dependents) {
      const depIndex = this.features.indexOf(dependent);
      if (depIndex <= newIndex) {
        return false; // Dependent would be before this feature
      }
    }
    
    return true;
  }

  // -----------------------------------------------------------------------
  // Dependency tracking
  // -----------------------------------------------------------------------

  /**
   * Get all features that depend on a given feature (direct dependents only).
   * @param {string} featureId - The feature ID
   * @returns {Feature[]} Array of dependent features
   */
  getDependents(featureId) {
    return this.features.filter(f => 
      f.getDependencies().includes(featureId)
    );
  }

  /**
   * Get all features that a given feature depends on (transitive closure).
   * @param {string} featureId - The feature ID
   * @returns {Feature[]} Array of dependency features in execution order
   */
  getAllDependencies(featureId) {
    const feature = this.featureMap.get(featureId);
    if (!feature) return [];
    
    const visited = new Set();
    const result = [];
    
    const visit = (f) => {
      if (visited.has(f.id)) return;
      visited.add(f.id);
      
      for (const depId of f.getDependencies()) {
        const dep = this.featureMap.get(depId);
        if (dep) {
          visit(dep);
        }
      }
      
      result.push(f);
    };
    
    visit(feature);
    
    // Remove the feature itself from the result
    return result.slice(0, -1);
  }

  /**
   * Get all features that depend on a given feature (transitive closure).
   * @param {string} featureId - The feature ID
   * @returns {Feature[]} Array of dependent features
   */
  getAllDependents(featureId) {
    const visited = new Set();
    const result = [];
    
    const visit = (fid) => {
      const dependents = this.getDependents(fid);
      for (const dep of dependents) {
        if (!visited.has(dep.id)) {
          visited.add(dep.id);
          result.push(dep);
          visit(dep.id);
        }
      }
    };
    
    visit(featureId);
    return result;
  }

  // -----------------------------------------------------------------------
  // Execution and recalculation
  // -----------------------------------------------------------------------

  /**
   * Execute all features in the tree.
   * @returns {Object} Execution results
   */
  executeAll() {
    // Release all existing handles before clearing results
    for (const fid of Object.keys(this.results)) {
      this._releaseResultHandle(this.results[fid], fid);
    }
    this.results = {};
    
    for (const feature of this.features) {
      if (feature.suppressed) {
        this.results[feature.id] = { suppressed: true };
        continue;
      }
      
      try {
        const context = { results: this.results, tree: this };
        
        if (!feature.canExecute(context)) {
          feature.error = 'Dependencies not satisfied';
          this.results[feature.id] = { error: feature.error };
          continue;
        }
        
        const executedResult = feature.execute(context);
        const result = this._normalizeLiveSolidResultFromOcctCheckpoint(feature.id, feature, executedResult);
        feature.result = result;
        feature.error = null;
        this._stampSolidResult(feature.id, result);
        this.results[feature.id] = result;
        // H3/H4: capture the input fingerprint so future recalculateFrom
        // passes can short-circuit downstream features whose inputs are
        // unchanged.
        feature._lastInputFingerprint = this._computeInputFingerprint(feature);
      } catch (error) {
        feature.error = error.message;
        this.results[feature.id] = { error: error.message };
        console.error(`Error executing feature ${feature.name}:`, error);
      }
    }
    
    return this.results;
  }

  /**
   * Apply a rollback cutoff using cached results when possible. Features at
   * or after activeFeatureCount are suppressed for display/history-tree state,
   * but their existing result payloads are preserved so dragging the rollback
   * handle forward can be instant when inputs have not changed.
   * @param {number} activeFeatureCount
   * @param {Object|null} [deps]
   * @returns {{replayed:boolean, restored:number}}
   */
  applyRollbackSuppression(activeFeatureCount, deps = this._fastRestoreDeps) {
    const pos = Math.max(0, Math.min(this.features.length, Number.isFinite(activeFeatureCount) ? activeFeatureCount : this.features.length));
    let needsReplay = false;
    let restored = 0;

    for (let i = 0; i < this.features.length; i++) {
      const feature = this.features[i];
      const shouldSuppress = i >= pos;
      if (shouldSuppress) {
        if (!feature.suppressed) feature.suppress();
        continue;
      }

      if (feature.suppressed) feature.unsuppress();
      const result = this.results[feature.id];
      if (!result || result.error || result.suppressed) {
        needsReplay = true;
        continue;
      }
      if (feature.type !== 'sketch' && result.type !== 'solid') {
        needsReplay = true;
      }
    }

    if (needsReplay) {
      this.executeAll();
      return { replayed: true, restored };
    }

    for (let i = 0; i < pos; i++) {
      const feature = this.features[i];
      if (feature.type === 'sketch') continue;
      if (this._restoreSolidResultFromCheckpoint(feature.id, deps)) {
        restored++;
      }
    }
    return { replayed: false, restored };
  }

  /**
   * Recalculate all features starting from a specific feature.
   * @param {string|Feature} featureOrId - Feature or feature ID to start from
   */
  recalculateFrom(featureOrId) {
    if (this.isRecalculating) {
      this.needsRecalculation = true;
      return;
    }
    
    this.isRecalculating = true;
    
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const startIndex = this.getFeatureIndex(featureId);
    
    if (startIndex < 0) {
      this.isRecalculating = false;
      return;
    }
    
    // Execute features from startIndex onward
    for (let i = startIndex; i < this.features.length; i++) {
      const feature = this.features[i];
      
      if (feature.suppressed) {
        this._releaseResultHandle(this.results[feature.id], feature.id);
        this.results[feature.id] = { suppressed: true };
        continue;
      }
      
      try {
        const context = { results: this.results, tree: this };
        
        if (!feature.canExecute(context)) {
          feature.error = 'Dependencies not satisfied';
          this._releaseResultHandle(this.results[feature.id], feature.id);
          this.results[feature.id] = { error: feature.error };
          continue;
        }

        // H3/H4 full: input-fingerprint short-circuit. Skip re-execution (and
        // therefore skip handle churn, CBREP rebuild, tessellation) when the
        // feature's own serialized parameters AND every dependency's irHash
        // are byte-identical to the previous successful execution. The
        // edited feature itself falls through because its serialize() output
        // will differ from `_lastInputFingerprint` by construction — so the
        // short-circuit only ever benefits downstream features whose inputs
        // didn't actually change. Features without an irHash on all their
        // deps opt out automatically (fingerprint contains `null`, never
        // matches cleanly).
        const fingerprint = this._computeInputFingerprint(feature);
        const existing = this.results[feature.id];
        if (
          fingerprint != null &&
          feature._lastInputFingerprint === fingerprint &&
          existing && !existing.error && !existing.suppressed &&
          (existing.type === 'solid' || existing.type === 'sketch')
        ) {
          // Result is still valid — keep its handle, keep its CBREP, keep
          // its irHash. Do NOT stamp it (no revision bump, no dirty-face
          // mark): the body is unchanged, so downstream consumers shouldn't
          // see a dirty signal.
          continue;
        }

        const oldResult = this.results[feature.id];
        const executedResult = feature.execute(context);
        const result = this._normalizeLiveSolidResultFromOcctCheckpoint(feature.id, feature, executedResult);
        feature.result = result;
        feature.error = null;
        this._releaseResultHandle(oldResult, feature.id);
        this._stampSolidResult(feature.id, result);
        this.results[feature.id] = result;
        feature._lastInputFingerprint = fingerprint;
      } catch (error) {
        feature.error = error.message;
        this._releaseResultHandle(this.results[feature.id], feature.id);
        this.results[feature.id] = { error: error.message };
        console.error(`Error executing feature ${feature.name}:`, error);
      }
    }
    
    this.isRecalculating = false;
    
    // If recalculation was requested during execution, do it now
    if (this.needsRecalculation) {
      this.needsRecalculation = false;
      this.executeAll();
    }
  }

  /**
   * Compute a stable fingerprint of a feature's input state:
   * serialized parameters + dependency irHashes. Returns a string, or null
   * when any dependency lacks an irHash (in which case callers must NOT
   * short-circuit — we cannot prove inputs are unchanged).
   *
   * This is the primitive that drives H3/H4 handle-churn avoidance: when a
   * feature's fingerprint matches the one captured on its last successful
   * execute, its result is byte-for-byte reproducible and re-execution is
   * skipped.
   *
   * @param {import('./Feature.js').Feature} feature
   * @returns {string|null}
   */
  _computeInputFingerprint(feature) {
    if (!feature || typeof feature.serialize !== 'function') return null;
    let params;
    try {
      params = feature.serialize();
    } catch { return null; }
    // Strip metadata fields that don't affect output: `modified` and
    // `created` are user-visible timestamps, not inputs to execute().
    // Leaving them in would make every markModified() call a cache miss
    // even when the edit was a no-op (e.g. setParam(x) where x is the
    // current value).
    if (params && typeof params === 'object') {
      params = { ...params };
      delete params.modified;
      delete params.created;
    }
    const depHashes = [];
    const deps = Array.isArray(feature.dependencies) ? feature.dependencies : [];
    for (const depId of deps) {
      const depResult = this.results[depId];
      if (!depResult || depResult.error || depResult.suppressed) return null;
      const h = depResult.irHash;
      // Sketches are pure-data inputs without irHash; their serialized form
      // is already captured on the feature itself via dependencies, but we
      // still need *something* stable to incorporate. Fall back to the
      // dependency's revision id, which is bumped on every stamp.
      const marker = h != null ? String(h) : (depResult.exactBodyRevisionId != null
        ? `rev:${depResult.exactBodyRevisionId}`
        : null);
      if (marker == null) return null;
      depHashes.push(`${depId}:${marker}`);
    }
    try {
      return JSON.stringify({ p: params, d: depHashes });
    } catch {
      return null;
    }
  }

  /**
   * Mark a feature as modified and trigger recalculation.
   * @param {string|Feature} featureOrId - Feature or feature ID that changed
   */
  markModified(featureOrId) {
    const featureId = typeof featureOrId === 'string' ? featureOrId : featureOrId.id;
    const feature = this.featureMap.get(featureId);
    
    if (feature) {
      feature.modified = new Date();
      // H3/H4: the markModified contract means "force this feature to
      // re-execute on the next recalculateFrom." Clear the stored
      // fingerprint so the short-circuit cannot accidentally skip this
      // feature (possible when `feature.modified = new Date()` lands in the
      // same millisecond as the previous stamp, yielding an identical
      // serialize() payload). Downstream features still get the short-
      // circuit benefit when their own inputs are unchanged.
      feature._lastInputFingerprint = null;
      this.recalculateFrom(featureId);
    }
  }

  // -----------------------------------------------------------------------
  // Utility methods
  // -----------------------------------------------------------------------

  /**
   * Clear all features from the tree.
   */
  clear() {
    // Release all WASM handles and residency entries
    for (const fid of Object.keys(this.results)) {
      this._releaseResultHandle(this.results[fid], fid);
    }
    if (this._residencyManager) this._residencyManager.clear();
    this.features = [];
    this.featureMap.clear();
    this.results = {};
    this._dirtyFaces.clearAll();
  }

  // -----------------------------------------------------------------------
  // C3: dirty-face tracking accessors
  // -----------------------------------------------------------------------

  /**
   * Mark a specific face ID on a feature result as dirty. Intended for
   * feature.execute() implementations that know they only mutated a subset
   * of faces (e.g. an edge-specific chamfer). Callers should invoke this
   * BEFORE returning the result so `_stampSolidResult` can preserve the
   * discrete set by setting `result._dirtyOverride = true`.
   */
  markFaceDirty(featureId, faceId) {
    this._dirtyFaces.markFaceDirty(featureId, faceId);
  }

  /** Bulk variant of markFaceDirty. */
  markFacesDirty(featureId, faceIds) {
    this._dirtyFaces.markFacesDirty(featureId, faceIds);
  }

  /** True when the feature's entire body is flagged dirty (the default). */
  isAllFacesDirty(featureId) {
    return this._dirtyFaces.isAllDirty(featureId);
  }

  /** Snapshot of discrete dirty face IDs. Empty when `isAllFacesDirty`. */
  getDirtyFaceIds(featureId) {
    return this._dirtyFaces.getDirtyFaceIds(featureId);
  }

  /** Called by consumers (tessellation cache, selector remap) after they
   * have processed the invalidation for a given feature. */
  clearDirtyFaces(featureId) {
    this._dirtyFaces.clear(featureId);
  }

  /**
   * Get the final geometry result (last non-suppressed feature result).
   * @returns {Object|null} The final result or null
   */
  getFinalResult() {
    for (let i = this.features.length - 1; i >= 0; i--) {
      const feature = this.features[i];
      if (!feature.suppressed && this.results[feature.id] && !this.results[feature.id].error) {
        return this.results[feature.id];
      }
    }
    return null;
  }

  /**
   * Get the last solid result in the feature tree.
   * Skips sketch features and returns the most recent solid geometry result.
   * @returns {Object|null} The last solid result or null
   */
  getLastSolidResult() {
    for (let i = this.features.length - 1; i >= 0; i--) {
      const feature = this.features[i];
      if (!feature.suppressed && this.results[feature.id] && !this.results[feature.id].error) {
        const result = this.results[feature.id];
        if (result.type === 'solid') {
          return result;
        }
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize the feature tree to JSON.
   */
  serialize() {
    const checkpoints = this._serializeCheckpoints();
    const data = {
      features: this.features.map(f => f.serialize()),
    };
    if (checkpoints) {
      data.checkpoints = checkpoints;
    }
    return data;
  }

  /**
   * Collect per-feature OCCT checkpoints for every solid result that can be
   * replayed through the OCCT restore path.
   * @returns {Object|null} { [featureId]: { occt? } } or null when empty
   */
  _serializeCheckpoints() {
    const out = {};
    let count = 0;
    for (const feature of this.features) {
      const result = this.results[feature.id];
      if (!result || result.type !== 'solid') continue;

      if (this._getResultOcctHandle(result) > 0 && !this._hasOcctCheckpoint({ occt: result.occtCheckpoint })) {
        this._ensureSolidResultOcctCheckpoint(result);
      }

      const entry = {};
      if (this._hasOcctCheckpoint({ occt: result.occtCheckpoint })) {
        entry.occt = result.occtCheckpoint;
      }
      const mesh = this._serializeOcctDisplayMeshSnapshot(result.geometry);
      if (mesh) {
        entry.mesh = mesh;
      }
      if (!entry.occt) continue;
      out[feature.id] = entry;
      count++;
    }
    return count > 0 ? out : null;
  }

  /**
   * Deserialize a feature tree from JSON.
   * Note: Features must be deserialized by their specific subclasses.
   */
  static deserialize(data, featureFactory, options = {}) {
    const tree = new FeatureTree();

    if (Object.prototype.hasOwnProperty.call(options, 'handleRegistry')) {
      tree.setHandleRegistry(options.handleRegistry ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(options, 'residencyManager')) {
      tree.setResidencyManager(options.residencyManager ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(options, 'fastRestoreDeps')) {
      tree.setFastRestoreDeps(options.fastRestoreDeps ?? null);
    }

    if (!data || !data.features) return tree;

    // Deserialize features in order
    for (const featureData of data.features) {
      const feature = featureFactory(featureData);
      if (feature) {
        tree.features.push(feature);
        tree.featureMap.set(feature.id, feature);
      }
    }

    // Try OCCT checkpoint fast-restore before replay. On any failure this is
    // a silent no-op and we fall through to executeAll() below.
    if (data.checkpoints &&
        tree.tryFastRestoreFromCheckpoints(data.checkpoints, tree._fastRestoreDeps)) {
      return tree;
    }

    // Execute all features to rebuild results
    tree.executeAll();

    // After replay, attach any serialized OCCT checkpoints that still match
    // the replayed topology so future restores can stay on the OCCT path.
    tree._applySerializedCheckpoints(data.checkpoints);

    return tree;
  }

  /**
   * Attach serialized OCCT checkpoints onto their matching live results.
   * Safe to call with null/undefined (no-op).
   * @param {Object|null|undefined} checkpoints
   */
  _applySerializedCheckpoints(checkpoints) {
    if (!checkpoints || typeof checkpoints !== 'object') return;
    for (const feature of this.features) {
      const entry = checkpoints[feature.id];
      if (!entry) continue;
      const result = this.results[feature.id];
      if (!result || result.type !== 'solid') continue;

      if (this._hasOcctCheckpoint(entry)) {
        const checkpointMeta = this._getOcctCheckpointMeta(entry.occt);
        const liveTopologyHash = result.occtTopologyHash || result._occtModeling?.topology?.topologyHash || result.geometry?._occtModeling?.topology?.topologyHash || null;
        if (!liveTopologyHash || !checkpointMeta.topologyHash || liveTopologyHash === checkpointMeta.topologyHash) {
          this._rememberOcctCheckpoint(result, entry.occt);
        }
      }
    }
  }
}
