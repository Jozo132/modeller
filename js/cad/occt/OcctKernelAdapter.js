// js/cad/occt/OcctKernelAdapter.js -- small facade over the optional OCCT WASM build.

import { getCachedOcctKernelModule, getOcctKernelStatus, loadOcctKernelModule } from './OcctKernelLoader.js';

const DEFAULT_LINEAR_DEFLECTION = 0.1;
const DEFAULT_ANGULAR_DEFLECTION = 0.5;

function cleanNumber(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function readVec3(flat, index) {
  const offset = index * 3;
  return {
    x: cleanNumber(Number(flat[offset] ?? 0)),
    y: cleanNumber(Number(flat[offset + 1] ?? 0)),
    z: cleanNumber(Number(flat[offset + 2] ?? 0)),
  };
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function triangleNormal(a, b, c) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  return normalize({
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  });
}

function averageNormal(normals, i0, i1, i2) {
  if (!Array.isArray(normals) || normals.length < Math.max(i0, i1, i2) * 3 + 3) return null;
  return normalize({
    x: Number(normals[i0 * 3] ?? 0) + Number(normals[i1 * 3] ?? 0) + Number(normals[i2 * 3] ?? 0),
    y: Number(normals[i0 * 3 + 1] ?? 0) + Number(normals[i1 * 3 + 1] ?? 0) + Number(normals[i2 * 3 + 1] ?? 0),
    z: Number(normals[i0 * 3 + 2] ?? 0) + Number(normals[i1 * 3 + 2] ?? 0) + Number(normals[i2 * 3 + 2] ?? 0),
  });
}

function parseJson(value, label) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`OCCT ${label} returned invalid JSON: ${error.message}`);
  }
}

function normalizeStepImportMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const text = typeof message.text === 'string'
    ? message.text
    : String(message.text ?? '');
  return {
    phase: typeof message.phase === 'string' ? message.phase : 'unknown',
    severity: typeof message.severity === 'string' ? message.severity : 'info',
    text,
    entityNumber: Number.isInteger(message.entityNumber) ? message.entityNumber : undefined,
  };
}

function normalizeStepImportResult(result) {
  const messageList = Array.isArray(result?.messageList)
    ? result.messageList.map(normalizeStepImportMessage).filter(Boolean)
    : [];
  const shapeHandle = Number.isInteger(result?.shapeHandle) && result.shapeHandle > 0
    ? result.shapeHandle
    : Number.isInteger(result?.shapeId) && result.shapeId > 0
      ? result.shapeId
      : Number.isInteger(result?.shape?.id) && result.shape.id > 0
        ? result.shape.id
        : 0;
  return {
    readStatus: result?.readStatus ?? null,
    transferStatus: result?.transferStatus ?? null,
    rootCount: Number.isFinite(result?.rootCount) ? Number(result.rootCount) : 0,
    transferredRootCount: Number.isFinite(result?.transferredRootCount)
      ? Number(result.transferredRootCount)
      : 0,
    messageList,
    shapeHandle,
    isValid: result?.isValid === true,
    wasValidBeforeHealing: result?.wasValidBeforeHealing === true,
    healed: result?.healed === true,
  };
}

function formatStepImportFailure(result) {
  const firstFailure = Array.isArray(result?.messageList)
    ? result.messageList.find((message) => message?.severity === 'fail' && message.text)
    : null;
  if (firstFailure?.text) return firstFailure.text;
  const firstWarning = Array.isArray(result?.messageList)
    ? result.messageList.find((message) => message?.severity === 'warning' && message.text)
    : null;
  if (firstWarning?.text) return firstWarning.text;
  const readStatus = result?.readStatus ?? 'unknown-read-status';
  const transferStatus = result?.transferStatus ?? 'unknown-transfer-status';
  return `OCCT STEP import failed (${readStatus}/${transferStatus})`;
}

function parseEdgeSegments(edgeSegments) {
  if (!Array.isArray(edgeSegments) || edgeSegments.length < 6) return [];
  const edges = [];
  for (let offset = 0; offset + 5 < edgeSegments.length; offset += 6) {
    edges.push({
      start: {
        x: cleanNumber(Number(edgeSegments[offset] ?? 0)),
        y: cleanNumber(Number(edgeSegments[offset + 1] ?? 0)),
        z: cleanNumber(Number(edgeSegments[offset + 2] ?? 0)),
      },
      end: {
        x: cleanNumber(Number(edgeSegments[offset + 3] ?? 0)),
        y: cleanNumber(Number(edgeSegments[offset + 4] ?? 0)),
        z: cleanNumber(Number(edgeSegments[offset + 5] ?? 0)),
      },
      source: 'occt',
    });
  }
  return edges;
}

export function occtTessellationToMesh(tessellation, opts = {}) {
  const data = parseJson(tessellation, 'tessellate') || {};
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const normals = Array.isArray(data.normals) ? data.normals : [];
  const indices = Array.isArray(data.indices) ? data.indices : [];
  const vertexCount = Math.floor(positions.length / 3);
  const vertices = new Array(vertexCount);

  for (let index = 0; index < vertexCount; index++) {
    vertices[index] = readVec3(positions, index);
  }

  const faces = [];
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const i0 = Number(indices[offset] ?? 0);
    const i1 = Number(indices[offset + 1] ?? 0);
    const i2 = Number(indices[offset + 2] ?? 0);
    if (!vertices[i0] || !vertices[i1] || !vertices[i2]) continue;
    const faceVertices = [vertices[i0], vertices[i1], vertices[i2]];
    const normal = averageNormal(normals, i0, i1, i2) || triangleNormal(faceVertices[0], faceVertices[1], faceVertices[2]);
    const triangleIndex = faces.length;
    faces.push({
      vertices: faceVertices,
      normal,
      vertexNormals: normals.length >= vertexCount * 3
        ? [readVec3(normals, i0), readVec3(normals, i1), readVec3(normals, i2)]
        : undefined,
      faceGroup: opts.faceGroupOffset != null ? opts.faceGroupOffset + triangleIndex : triangleIndex,
      topoFaceId: opts.topoFaceIdOffset != null ? opts.topoFaceIdOffset + triangleIndex : triangleIndex,
      faceType: 'occt-triangle',
      source: 'occt',
    });
  }

  return {
    vertices,
    faces,
    edges: parseEdgeSegments(data.edgeSegments),
    _tessellator: 'occt',
    _occt: {
      positionCount: positions.length,
      normalCount: normals.length,
      indexCount: indices.length,
      edgeSegmentCount: Array.isArray(data.edgeSegments) ? data.edgeSegments.length / 6 : 0,
      hasStableFaceMap: false,
    },
  };
}

export class OcctKernelAdapter {
  constructor(options = {}) {
    this.options = { ...options };
    this.module = options.module || null;
    this.kernel = options.kernel || null;
    this.paths = null;
    this._ownsKernel = !options.kernel;
    this._ownedShapes = new Set();
  }

  static async create(options = {}) {
    const adapter = new OcctKernelAdapter(options);
    await adapter.init();
    return adapter;
  }

  static createSync(options = {}) {
    const loaded = options.loaded || getCachedOcctKernelModule(options);
    const module = options.module || loaded?.module;
    if (!module || typeof module.OcctKernel !== 'function') {
      throw new Error('OCCT module is not ready for synchronous adapter creation');
    }

    const adapter = new OcctKernelAdapter({ ...options, module });
    adapter.paths = options.paths || loaded?.paths || null;
    if (!adapter.kernel) {
      adapter.kernel = new module.OcctKernel();
      adapter._ownsKernel = true;
    }
    return adapter;
  }

  async init() {
    if (!this.module) {
      const loaded = await loadOcctKernelModule(this.options);
      this.module = loaded.module;
      this.paths = loaded.paths;
    }
    if (!this.kernel) {
      this.kernel = new this.module.OcctKernel();
      this._ownsKernel = true;
    }
    return this;
  }

  get ready() {
    return !!this.kernel;
  }

  get status() {
    return {
      ...getOcctKernelStatus(this.module),
      ready: this.ready,
      ownedShapeCount: this._ownedShapes.size,
      paths: this.paths,
    };
  }

  requireReady() {
    if (!this.kernel) throw new Error('OCCT adapter is not initialized');
    return this.kernel;
  }

  rememberShape(handle) {
    if (Number.isInteger(handle) && handle > 0) this._ownedShapes.add(handle);
    return handle;
  }

  createBox(dx, dy, dz) {
    return this.rememberShape(this.requireReady().createBox(dx, dy, dz));
  }

  createCylinder(radius, height) {
    return this.rememberShape(this.requireReady().createCylinder(radius, height));
  }

  createSphere(radius) {
    return this.rememberShape(this.requireReady().createSphere(radius));
  }

  extrudeProfile(profileJson, distance) {
    const payload = typeof profileJson === 'string' ? profileJson : JSON.stringify(profileJson);
    return this.rememberShape(this.requireReady().extrudeProfile(payload, distance));
  }

  revolveProfile(profileJson, angleRadians) {
    const payload = typeof profileJson === 'string' ? profileJson : JSON.stringify(profileJson);
    const angle = Number(angleRadians);
    if (!Number.isFinite(angle)) {
      throw new Error('OCCT revolveProfile requires a finite angle in radians');
    }
    return this.rememberShape(this.requireReady().revolveProfile(payload, angle * 180 / Math.PI));
  }

  booleanUnion(firstHandle, secondHandle) {
    return this.rememberShape(this.requireReady().booleanUnion(firstHandle, secondHandle));
  }

  booleanSubtract(firstHandle, secondHandle) {
    return this.rememberShape(this.requireReady().booleanSubtract(firstHandle, secondHandle));
  }

  booleanIntersect(firstHandle, secondHandle) {
    return this.rememberShape(this.requireReady().booleanIntersect(firstHandle, secondHandle));
  }

  filletEdges(shapeHandle, edgeSelectionJson) {
    const payload = typeof edgeSelectionJson === 'string' ? edgeSelectionJson : JSON.stringify(edgeSelectionJson);
    return this.rememberShape(this.requireReady().filletEdges(shapeHandle, payload));
  }

  chamferEdges(shapeHandle, edgeSelectionJson) {
    const payload = typeof edgeSelectionJson === 'string' ? edgeSelectionJson : JSON.stringify(edgeSelectionJson);
    return this.rememberShape(this.requireReady().chamferEdges(shapeHandle, payload));
  }

  importStepDetailed(stepText, opts = {}) {
    const kernel = this.requireReady();
    if (typeof kernel.importStepDetailed !== 'function') {
      const shapeHandle = this.rememberShape(kernel.importStep(stepText));
      const isValid = this.checkValidity(shapeHandle);
      return {
        readStatus: 'legacy-import',
        transferStatus: 'legacy-import',
        rootCount: shapeHandle > 0 ? 1 : 0,
        transferredRootCount: shapeHandle > 0 ? 1 : 0,
        messageList: [],
        shapeHandle,
        isValid,
        wasValidBeforeHealing: isValid,
        healed: false,
      };
    }

    const sewingTolerance = opts.sewingTolerance ?? opts.sewTolerance ?? 1e-6;
    const result = normalizeStepImportResult(parseJson(
      kernel.importStepDetailed(
        stepText,
        opts.heal === true,
        opts.sew === true,
        opts.fixSameParameter === true,
        opts.fixSolid === true,
        sewingTolerance,
      ),
      'importStepDetailed',
    ));
    if (result.shapeHandle > 0) this.rememberShape(result.shapeHandle);
    return result;
  }

  importStep(stepText, opts = undefined) {
    if (opts && typeof opts === 'object' && Object.keys(opts).length > 0) {
      const result = this.importStepDetailed(stepText, opts);
      if (result.shapeHandle > 0) return result.shapeHandle;
      throw new Error(formatStepImportFailure(result));
    }
    return this.rememberShape(this.requireReady().importStep(stepText));
  }

  exportStep(shapeHandle) {
    return this.requireReady().exportStep(shapeHandle);
  }

  checkValidity(shapeHandle) {
    return !!this.requireReady().checkValidity(shapeHandle);
  }

  getTopology(shapeHandle) {
    return parseJson(this.requireReady().getTopology(shapeHandle), 'getTopology');
  }

  tessellateRaw(shapeHandle, opts = {}) {
    const linearDeflection = opts.linearDeflection ?? opts.chordalDeviation ?? DEFAULT_LINEAR_DEFLECTION;
    const angularDeflection = opts.angularDeflection ?? opts.angularTolerance ?? DEFAULT_ANGULAR_DEFLECTION;
    return this.requireReady().tessellate(shapeHandle, linearDeflection, angularDeflection);
  }

  tessellate(shapeHandle, opts = {}) {
    return occtTessellationToMesh(this.tessellateRaw(shapeHandle, opts), opts);
  }

  disposeShape(shapeHandle) {
    if (!shapeHandle || !this.kernel) return;
    this.kernel.disposeShape(shapeHandle);
    this._ownedShapes.delete(shapeHandle);
  }

  disposeAllShapes() {
    for (const handle of Array.from(this._ownedShapes)) {
      this.disposeShape(handle);
    }
  }

  dispose() {
    this.disposeAllShapes();
    if (this._ownsKernel && this.kernel && typeof this.kernel.delete === 'function') {
      this.kernel.delete();
    }
    this.kernel = null;
    this.module = null;
  }
}

export default OcctKernelAdapter;