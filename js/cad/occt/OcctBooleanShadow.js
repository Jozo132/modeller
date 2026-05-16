import { getFlag } from '../../featureFlags.js';
import { exportSTEPDetailed } from '../StepExport.js';
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
    resultGrade: result?.resultGrade ?? null,
    bodyFaceCount: countBodyFaces(result?.body),
    meshVertexCount: Array.isArray(result?.mesh?.vertices) ? result.mesh.vertices.length : 0,
    meshFaceCount: Array.isArray(result?.mesh?.faces) ? result.mesh.faces.length : 0,
    boundingBox: computeBounds(result?.mesh?.vertices),
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

function summarizeStepExport(stepExport) {
  if (!stepExport || typeof stepExport !== 'object') return null;
  return {
    entityCount: stepExport.timings?.entityCount ?? 0,
    outputBytes: stepExport.timings?.outputBytes ?? 0,
    faceCount: stepExport.timings?.faceCount ?? 0,
    edgeCount: stepExport.timings?.edgeCount ?? 0,
    vertexCount: stepExport.timings?.vertexCount ?? 0,
  };
}

function normalizeShadowError(error) {
  const message = error?.message ?? String(error);
  return {
    message,
    numericCode: /^\d+$/.test(message) ? Number(message) : null,
  };
}

function summarizeStepImport(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    readStatus: result.readStatus ?? null,
    transferStatus: result.transferStatus ?? null,
    rootCount: result.rootCount ?? 0,
    transferredRootCount: result.transferredRootCount ?? 0,
    shapeHandle: result.shapeHandle ?? 0,
    isValid: result.isValid === true,
    wasValidBeforeHealing: result.wasValidBeforeHealing === true,
    healed: result.healed === true,
    messageList: Array.isArray(result.messageList)
      ? result.messageList.map((message) => ({
        phase: message?.phase ?? null,
        severity: message?.severity ?? null,
        text: message?.text ?? '',
        entityNumber: message?.entityNumber,
      }))
      : [],
  };
}

function formatStepImportFailure(label, result) {
  const firstFailure = Array.isArray(result?.messageList)
    ? result.messageList.find((message) => message?.severity === 'fail' && message.text)
    : null;
  if (firstFailure?.text) return `OCCT STEP import failed for ${label}: ${firstFailure.text}`;
  const firstWarning = Array.isArray(result?.messageList)
    ? result.messageList.find((message) => message?.severity === 'warning' && message.text)
    : null;
  if (firstWarning?.text) return `OCCT STEP import warning for ${label}: ${firstWarning.text}`;
  return `OCCT STEP import failed for ${label} (${result?.readStatus ?? 'unknown'}/${result?.transferStatus ?? 'unknown'})`;
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

function shadowImportOptions(options = {}) {
  const occt = options.occt && typeof options.occt === 'object' ? options.occt : {};
  return {
    heal: occt.importHeal ?? options.occtImportHeal ?? true,
    sew: occt.importSew ?? options.occtImportSew ?? true,
    fixSameParameter: occt.importFixSameParameter ?? options.occtImportFixSameParameter ?? true,
    fixSolid: occt.importFixSolid ?? options.occtImportFixSolid ?? true,
    sewingTolerance: occt.importSewingTolerance ?? options.occtImportSewingTolerance ?? 1e-6,
  };
}

function resolveBooleanMethod(operation) {
  switch (operation) {
    case 'union': return 'booleanUnion';
    case 'subtract': return 'booleanSubtract';
    case 'intersect': return 'booleanIntersect';
    default: throw new Error(`Unsupported OCCT boolean shadow operation: ${operation}`);
  }
}

export function isOcctBooleanShadowEnabled(options = {}) {
  if (options.occtBooleanShadow === false) return false;
  if (options.occtBooleanShadow === true) return true;
  if (options.occtShadow === true) return true;
  return getFlag('CAD_USE_OCCT_BOOLEAN_SHADOW');
}

export async function ensureOcctBooleanShadowReady(options = {}) {
  if (!isOcctBooleanShadowEnabled(options) && options.force !== true) return false;
  try {
    await loadOcctKernelModule(shadowLoaderOptions(options));
    return true;
  } catch {
    return false;
  }
}

export function buildOcctBooleanShadowSync(bodyA, bodyB, operation, primaryResult, options = {}) {
  if (!isOcctBooleanShadowEnabled(options)) return null;

  const loaded = getCachedOcctKernelModule(shadowLoaderOptions(options));
  if (!loaded?.module) {
    return {
      enabled: true,
      ready: false,
      ok: false,
      operation,
      skippedReason: 'occt-not-ready',
    };
  }

  const tessellationOptions = shadowTessellationOptions(options);
  const importOptions = shadowImportOptions(options);
  const timings = {};
  const startedAt = now();
  let adapter = null;
  let stage = 'adapter-create';
  let stepA = null;
  let stepB = null;
  let importA = null;
  let importB = null;
  try {
    adapter = OcctKernelAdapter.createSync({ loaded });

    stage = 'export-a';
    const exportAStartedAt = now();
    stepA = exportSTEPDetailed(bodyA, { filename: `boolean-${operation}-operand-a` });
    timings.exportAms = now() - exportAStartedAt;
    stage = 'export-b';
    const exportBStartedAt = now();
    stepB = exportSTEPDetailed(bodyB, { filename: `boolean-${operation}-operand-b` });
    timings.exportBms = now() - exportBStartedAt;

    stage = 'import-a';
    const importAStartedAt = now();
    importA = adapter.importStepDetailed(stepA.stepString, importOptions);
    if (!(importA.shapeHandle > 0)) throw new Error(formatStepImportFailure('operand-a', importA));
    const handleA = importA.shapeHandle;
    timings.importAms = now() - importAStartedAt;
    stage = 'import-b';
    const importBStartedAt = now();
    importB = adapter.importStepDetailed(stepB.stepString, importOptions);
    if (!(importB.shapeHandle > 0)) throw new Error(formatStepImportFailure('operand-b', importB));
    const handleB = importB.shapeHandle;
    timings.importBms = now() - importBStartedAt;

    const booleanMethod = resolveBooleanMethod(operation);
    stage = booleanMethod;
    const opStartedAt = now();
    const resultHandle = adapter[booleanMethod](handleA, handleB);
    timings.operationMs = now() - opStartedAt;

    stage = 'topology';
    const topologyStartedAt = now();
    const topology = adapter.getTopology(resultHandle);
    const valid = adapter.checkValidity(resultHandle);
    timings.topologyMs = now() - topologyStartedAt;

    stage = 'tessellate';
    const tessellateStartedAt = now();
    const mesh = adapter.tessellate(resultHandle, { ...tessellationOptions, topology });
    timings.tessellateMs = now() - tessellateStartedAt;
    timings.totalMs = now() - startedAt;

    const primary = summarizePrimaryResult(primaryResult);
    const occt = summarizeOcctResult(topology, mesh);
    return {
      enabled: true,
      ready: true,
      ok: true,
      operation,
      valid,
      topology,
      status: trimStatus(adapter.status),
      timings,
      imports: {
        options: importOptions,
        operandA: summarizeStepImport(importA),
        operandB: summarizeStepImport(importB),
      },
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
      operation,
      error: normalizeShadowError(error),
      stage,
      exports: {
        operandA: summarizeStepExport(stepA),
        operandB: summarizeStepExport(stepB),
      },
      imports: {
        options: importOptions,
        operandA: summarizeStepImport(importA),
        operandB: summarizeStepImport(importB),
      },
      timings,
    };
  } finally {
    adapter?.dispose();
  }
}