import { loadOcctKernelModule } from '../cad/occt/index.js';
import {
  cloneOcctCheckpointMeshSnapshot,
  createOcctSketchModelingCheckpoint,
  disposeOcctSketchModelingShape,
  restoreOcctSketchModelingCheckpoint,
  tryBuildOcctChamferMetadataSync,
  tryBuildOcctFilletMetadataSync,
} from '../cad/occt/OcctSketchModeling.js';
import { calculateMeshVolume, calculateBoundingBox } from '../cad/toolkit/MeshAnalysis.js';
import { ChamferFeature } from '../cad/ChamferFeature.js';
import { FilletFeature, resolveOcctEdgeRefsFromSelectionContext } from '../cad/FilletFeature.js';

function seedSelectionCompatGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return;
  if (!Array.isArray(geometry._selectionCompatEdges) || geometry._selectionCompatEdges.length === 0) {
    geometry._selectionCompatEdges = Array.isArray(geometry.edges) ? geometry.edges : [];
  }
  if (!Array.isArray(geometry._selectionCompatPaths) || geometry._selectionCompatPaths.length === 0) {
    geometry._selectionCompatPaths = Array.isArray(geometry.paths) ? geometry.paths : [];
  }
  if (!Array.isArray(geometry._selectionCompatOcctFeatureEdges) || geometry._selectionCompatOcctFeatureEdges.length === 0) {
    geometry._selectionCompatOcctFeatureEdges = Array.isArray(geometry._occtFeatureEdges)
      ? geometry._occtFeatureEdges
      : (Array.isArray(geometry.edges) ? geometry.edges : []);
  }
  if (!Array.isArray(geometry._selectionCompatOcctFeaturePaths) || geometry._selectionCompatOcctFeaturePaths.length === 0) {
    geometry._selectionCompatOcctFeaturePaths = Array.isArray(geometry._occtFeaturePaths)
      ? geometry._occtFeaturePaths
      : (Array.isArray(geometry.paths) ? geometry.paths : []);
  }
}

function formatFilletFailureDetails(failureInfo = {}, edgeKeys = [], workerEdgeRefs = [], edgeRefs = []) {
  const parts = [
    `selected edges: ${edgeKeys.length}`,
    `worker refs: ${workerEdgeRefs.length}`,
    `fallback refs: ${edgeRefs.length}`,
  ];
  if (Number.isInteger(failureInfo.resolvedStableHashes)) {
    parts.push(`resolved stable refs: ${failureInfo.resolvedStableHashes}`);
  }
  if (failureInfo.nativeError?.code || failureInfo.nativeError?.message) {
    const code = failureInfo.nativeError.code ? `[${failureInfo.nativeError.code}] ` : '';
    parts.push(`native error: ${code}${failureInfo.nativeError.message}`);
  }
  if (failureInfo.analysis && typeof failureInfo.analysis === 'object') {
    const validity = failureInfo.analysis.valid;
    if (validity !== null && validity !== undefined) {
      parts.push(`shape valid: ${validity}`);
    }
    if (Number.isInteger(failureInfo.analysis.edgeCount)) {
      parts.push(`shape edges: ${failureInfo.analysis.edgeCount}`);
    }
  }
  if (failureInfo.revision?.topologyHash) {
    parts.push(`topology: ${failureInfo.revision.topologyHash}`);
  }
  if (Array.isArray(failureInfo.effectiveEdgeRefs) && failureInfo.effectiveEdgeRefs.length > 0) {
    parts.push(`effective refs: ${JSON.stringify(failureInfo.effectiveEdgeRefs.slice(0, 4))}`);
  }
  return parts.join(', ');
}

function formatChamferFailureDetails(failureInfo = {}, edgeKeys = [], workerEdgeRefs = [], edgeRefs = []) {
  const parts = [
    `selected edges: ${edgeKeys.length}`,
    `worker refs: ${workerEdgeRefs.length}`,
    `fallback refs: ${edgeRefs.length}`,
  ];
  if (Number.isInteger(failureInfo.resolvedStableHashes)) {
    parts.push(`resolved stable refs: ${failureInfo.resolvedStableHashes}`);
  }
  if (failureInfo.nativeError?.code || failureInfo.nativeError?.message) {
    const code = failureInfo.nativeError.code ? `[${failureInfo.nativeError.code}] ` : '';
    parts.push(`native error: ${code}${failureInfo.nativeError.message}`);
  }
  if (failureInfo.analysis && typeof failureInfo.analysis === 'object') {
    const validity = failureInfo.analysis.valid;
    if (validity !== null && validity !== undefined) {
      parts.push(`shape valid: ${validity}`);
    }
    if (Number.isInteger(failureInfo.analysis.edgeCount)) {
      parts.push(`shape edges: ${failureInfo.analysis.edgeCount}`);
    }
  }
  if (failureInfo.revision?.topologyHash) {
    parts.push(`topology: ${failureInfo.revision.topologyHash}`);
  }
  if (Array.isArray(failureInfo.effectiveEdgeRefs) && failureInfo.effectiveEdgeRefs.length > 0) {
    parts.push(`effective refs: ${JSON.stringify(failureInfo.effectiveEdgeRefs.slice(0, 4))}`);
  }
  return parts.join(', ');
}

export async function handleOcctBlendWorkerMessage(data) {
  const { op, _dispatchId } = data || {};

  try {
    if (op !== 'occt-fillet' && op !== 'occt-chamfer') {
      return { type: 'error', message: `Unknown OCCT blend op: ${op}`, _dispatchId };
    }

    await loadOcctKernelModule();

    const {
      checkpoint,
      edgeRefs = [],
      edgeKeys = [],
      meshSnapshot = null,
      radius = 0,
      distance = 0,
      spec = null,
      sourceTopology = null,
    } = data;

    const restored = restoreOcctSketchModelingCheckpoint(checkpoint, null, cloneOcctCheckpointMeshSnapshot(meshSnapshot));
    const inputHandle = restored?.geometry?.occtShapeHandle || 0;
    if (!(inputHandle > 0)) {
      return {
        type: 'error',
        message: `Failed to restore OCCT ${op === 'occt-chamfer' ? 'chamfer' : 'fillet'} input checkpoint`,
        _dispatchId,
      };
    }

    let resultGeometry = null;
    let resultCheckpoint = null;
    try {
      const workerSelectionContext = {
        geometry: restored.geometry,
        body: restored.geometry?.topoBody || null,
      };
      const workerEdgeRefs = op === 'occt-chamfer'
        ? new ChamferFeature('Worker Chamfer', distance)._resolveSelectedOcctEdgeRefs(workerSelectionContext, edgeKeys)
        : resolveOcctEdgeRefsFromSelectionContext(workerSelectionContext, edgeKeys);
      const resolvedEdgeRefs = workerEdgeRefs.length > 0 ? workerEdgeRefs : edgeRefs;
      if (!Array.isArray(resolvedEdgeRefs) || resolvedEdgeRefs.length === 0) {
        return {
          type: 'error',
          message: `OCCT worker could not resolve selected ${op === 'occt-chamfer' ? 'chamfer' : 'fillet'} edge refs after checkpoint restore (selected edges: ${edgeKeys.length}, fallback refs: ${edgeRefs.length})`,
          _dispatchId,
        };
      }
      const feature = op === 'occt-chamfer'
        ? new ChamferFeature('Worker Chamfer', distance)
        : new FilletFeature('Worker Fillet', radius);
      const resolvedSpec = workerEdgeRefs.length > 0
        ? feature.buildOcctSpec(workerEdgeRefs)
        : spec;
      const failureInfo = {};

      resultGeometry = op === 'occt-chamfer'
        ? tryBuildOcctChamferMetadataSync({
          handle: inputHandle,
          edgeRefs: resolvedEdgeRefs,
          distance,
          spec: resolvedSpec,
          sourceTopology: restored.geometry?._occtModeling?.topology || sourceTopology,
          topoBody: null,
          failureInfo,
        })
        : tryBuildOcctFilletMetadataSync({
          handle: inputHandle,
          edgeRefs: resolvedEdgeRefs,
          radius,
          spec: resolvedSpec,
          sourceTopology: restored.geometry?._occtModeling?.topology || sourceTopology,
          topoBody: null,
          failureInfo,
        });
      if (!resultGeometry?.faces?.length) {
        return {
          type: 'error',
          message: op === 'occt-chamfer'
            ? `OCCT worker chamfer produced no geometry (${formatChamferFailureDetails(failureInfo, edgeKeys, workerEdgeRefs, edgeRefs)})`
            : `OCCT worker fillet produced no geometry (${formatFilletFailureDetails(failureInfo, edgeKeys, workerEdgeRefs, edgeRefs)})`,
          _dispatchId,
        };
      }

      const outputHandle = resultGeometry.occtShapeHandle || 0;
      if (!(outputHandle > 0)) {
        return {
          type: 'error',
          message: `OCCT worker ${op === 'occt-chamfer' ? 'chamfer' : 'fillet'} produced no resident handle`,
          _dispatchId,
        };
      }

      resultCheckpoint = createOcctSketchModelingCheckpoint(outputHandle);
      resultGeometry.topoBody = null;
      resultGeometry.occtCheckpoint = resultCheckpoint;
      seedSelectionCompatGeometry(resultGeometry);

      const volume = calculateMeshVolume(resultGeometry);
      const boundingBox = calculateBoundingBox(resultGeometry);

      return {
        type: 'result',
        result: {
          type: 'solid',
          geometry: {
            ...resultGeometry,
            occtShapeHandle: 0,
            occtShapeResident: false,
          },
          solid: {
            geometry: {
              ...resultGeometry,
              occtShapeHandle: 0,
              occtShapeResident: false,
            },
            body: null,
            occtCheckpoint: resultCheckpoint,
          },
          body: null,
          volume,
          boundingBox,
          occtShapeHandle: 0,
          occtShapeResident: false,
          _occtModeling: resultGeometry._occtModeling || null,
          occtCheckpoint: resultCheckpoint,
          _restoredFromCheckpoint: true,
        },
        _dispatchId,
      };
    } finally {
      const outputHandle = resultGeometry?.occtShapeHandle || 0;
      if (outputHandle > 0) {
        disposeOcctSketchModelingShape(outputHandle);
      }
      if (inputHandle > 0 && inputHandle !== outputHandle) {
        disposeOcctSketchModelingShape(inputHandle);
      }
    }
  } catch (error) {
    return {
      type: 'error',
      message: error?.message || String(error),
      stack: error?.stack || '',
      _dispatchId,
    };
  }
}

if (typeof self !== 'undefined') {
  self.onmessage = async function (e) {
    self.postMessage(await handleOcctBlendWorkerMessage(e.data));
  };
}