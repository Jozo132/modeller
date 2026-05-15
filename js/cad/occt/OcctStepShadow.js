import { getFlag } from '../../featureFlags.js';
import { OcctKernelAdapter } from './OcctKernelAdapter.js';
import { getCachedOcctKernelModule, loadOcctKernelModule, resolveOcctKernelEnv } from './OcctKernelLoader.js';

const DEFAULT_LINEAR_DEFLECTION = 0.1;
const DEFAULT_ANGULAR_DEFLECTION = 0.5;

const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Date.now();

function countBodyFaces(body) {
  return body && typeof body.faces === 'function' ? body.faces().length : 0;
}

function computeBounds(vertices) {
  if (!Array.isArray(vertices) || vertices.length === 0) return null;
  let xMin = Infinity;
  let yMin = Infinity;
  let zMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  let zMax = -Infinity;
  for (const vertex of vertices) {
    if (!vertex) continue;
    if (vertex.x < xMin) xMin = vertex.x;
    if (vertex.y < yMin) yMin = vertex.y;
    if (vertex.z < zMin) zMin = vertex.z;
    if (vertex.x > xMax) xMax = vertex.x;
    if (vertex.y > yMax) yMax = vertex.y;
    if (vertex.z > zMax) zMax = vertex.z;
  }
  if (!Number.isFinite(xMin)) return null;
  return { xMin, yMin, zMin, xMax, yMax, zMax };
}

function compareBounds(primaryBounds, occtBounds) {
  if (!primaryBounds || !occtBounds) return null;
  const delta = {
    xMin: primaryBounds.xMin - occtBounds.xMin,
    yMin: primaryBounds.yMin - occtBounds.yMin,
    zMin: primaryBounds.zMin - occtBounds.zMin,
    xMax: primaryBounds.xMax - occtBounds.xMax,
    yMax: primaryBounds.yMax - occtBounds.yMax,
    zMax: primaryBounds.zMax - occtBounds.zMax,
  };
  return {
    ...delta,
    maxAbsDelta: Math.max(...Object.values(delta).map((value) => Math.abs(value))),
  };
}

function summarizePrimaryResult(result) {
  return {
    bodyFaceCount: countBodyFaces(result?.body),
    meshVertexCount: Array.isArray(result?.vertices) ? result.vertices.length : 0,
    meshFaceCount: Array.isArray(result?.faces) ? result.faces.length : 0,
    boundingBox: computeBounds(result?.vertices),
  };
}

function summarizeOcctResult(topology, mesh) {
  return {
    topologyFaceCount: topology?.faceCount ?? 0,
    topologyEdgeCount: topology?.edgeCount ?? 0,
    topologyVertexCount: topology?.vertexCount ?? 0,
    topologyBoundingBox: topology?.boundingBox ?? null,
    meshVertexCount: Array.isArray(mesh?.vertices) ? mesh.vertices.length : 0,
    meshFaceCount: Array.isArray(mesh?.faces) ? mesh.faces.length : 0,
    meshEdgeCount: Array.isArray(mesh?.edges) ? mesh.edges.length : 0,
    meshBoundingBox: computeBounds(mesh?.vertices),
  };
}

function trimStatus(status) {
  if (!status) return null;
  return {
    available: !!status.available,
    ready: !!status.ready,
    memoryBytes: status.memoryBytes ?? 0,
    methodCount: Array.isArray(status.methodNames) ? status.methodNames.length : 0,
  };
}

function shadowLoaderOptions(options = {}) {
  const occt = options.occt && typeof options.occt === 'object' ? options.occt : {};
  const env = resolveOcctKernelEnv();
  return {
    distPath: occt.distPath ?? options.occtDistPath ?? env.distPath,
    distDir: occt.distDir ?? options.occtDistDir ?? env.distPath,
    jsPath: occt.jsPath ?? options.occtJsPath ?? env.jsPath,
    wasmPath: occt.wasmPath ?? options.occtWasmPath ?? env.wasmPath,
  };
}

function shadowTessellationOptions(options = {}) {
  const occt = options.occt && typeof options.occt === 'object' ? options.occt : {};
  return {
    linearDeflection: occt.linearDeflection ?? options.occtLinearDeflection ?? DEFAULT_LINEAR_DEFLECTION,
    angularDeflection: occt.angularDeflection ?? options.occtAngularDeflection ?? DEFAULT_ANGULAR_DEFLECTION,
    includeMesh: occt.includeMesh === true || options.occtIncludeMesh === true,
  };
}

export function isOcctStepShadowEnabled(options = {}) {
  if (options.occtShadow === false) return false;
  if (options.occtShadow === true) return true;
  return getFlag('CAD_USE_OCCT_STEP_SHADOW');
}

export async function ensureOcctStepShadowReady(options = {}) {
  if (!isOcctStepShadowEnabled(options) && options.force !== true) return false;
  try {
    await loadOcctKernelModule(shadowLoaderOptions(options));
    return true;
  } catch {
    return false;
  }
}

export function buildOcctStepShadowSync(stepString, primaryResult, options = {}) {
  if (!isOcctStepShadowEnabled(options)) return null;

  const loaded = getCachedOcctKernelModule(shadowLoaderOptions(options));
  if (!loaded?.module) {
    return {
      enabled: true,
      ready: false,
      ok: false,
      skippedReason: 'occt-not-ready',
    };
  }

  const tessellationOptions = shadowTessellationOptions(options);
  const timings = {};
  const startedAt = now();
  let adapter = null;
  let handle = 0;
  try {
    adapter = OcctKernelAdapter.createSync({ loaded });

    const importStartedAt = now();
    handle = adapter.importStep(stepString);
    timings.importMs = now() - importStartedAt;

    const topologyStartedAt = now();
    const topology = adapter.getTopology(handle);
    const valid = adapter.checkValidity(handle);
    timings.topologyMs = now() - topologyStartedAt;

    const tessellateStartedAt = now();
    const mesh = adapter.tessellate(handle, tessellationOptions);
    timings.tessellateMs = now() - tessellateStartedAt;
    timings.totalMs = now() - startedAt;

    const primary = summarizePrimaryResult(primaryResult);
    const occt = summarizeOcctResult(topology, mesh);
    return {
      enabled: true,
      ready: true,
      ok: true,
      valid,
      topology,
      status: trimStatus(adapter.status),
      timings,
      summary: {
        primary,
        occt,
        comparison: {
          bodyFaceDelta: primary.bodyFaceCount - occt.topologyFaceCount,
          meshFaceDelta: primary.meshFaceCount - occt.meshFaceCount,
          meshVertexDelta: primary.meshVertexCount - occt.meshVertexCount,
          boundingBoxDelta: compareBounds(primary.boundingBox, occt.meshBoundingBox || occt.topologyBoundingBox),
        },
      },
      mesh: tessellationOptions.includeMesh ? mesh : undefined,
    };
  } catch (error) {
    timings.totalMs = now() - startedAt;
    return {
      enabled: true,
      ready: true,
      ok: false,
      error: {
        message: error?.message ?? String(error),
      },
      timings,
    };
  } finally {
    if (adapter) {
      if (handle > 0) adapter.disposeShape(handle);
      adapter.dispose();
    }
  }
}