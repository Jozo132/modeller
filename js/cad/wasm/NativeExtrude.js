// js/cad/wasm/NativeExtrude.js — direct WASM-resident extrude bridge
//
// This path passes flat sketch/profile data into the kernel's extrude staging
// buffer. It does not serialize a JS TopoBody into WASM; topology, analytic
// surfaces, shell construction, validation, and tessellation all run on the
// resident native handle.

import { globalTessConfig } from '../TessellationConfig.js';

let _wasm = null;
let _wasmMem = null;
let _initPromise = null;

function _num(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'value' in value) return Number(value.value);
  return Number(value);
}

async function _ensureWasm() {
  if (_wasm) return true;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const mod = await import('../../../build/release.js');
      _wasm = mod;
      _wasmMem = mod.memory;
      return typeof mod.nativeExtrudeBuildFromStaging === 'function'
        && typeof mod.nativeExtrudeStagingPtr === 'function';
    } catch {
      return false;
    }
  })();
  return _initPromise;
}

_ensureWasm().catch(() => {});

export async function ensureNativeExtrudeReady() {
  return _ensureWasm();
}

export function isNativeExtrudeReady() {
  return !!(_wasm
    && typeof _wasm.nativeExtrudeBuildFromStaging === 'function'
    && typeof _wasm.nativeExtrudeStagingPtr === 'function');
}

export function tryBuildNativeExtrude({ loops, plane, extrusionVector, refDir, topoBody = null, sourceFeatureId = null, opts = {} }) {
  const w = _wasm;
  const mem = _wasmMem;
  if (!w || !mem || !isNativeExtrudeReady()) return null;
  if (!Array.isArray(loops) || loops.length === 0) return null;

  const payload = _flattenLoops(loops);
  if (!payload) return null;

  const capacity = w.nativeExtrudeStagingCapacity() >>> 0;
  if (payload.length > capacity) return null;

  const stagingPtr = w.nativeExtrudeStagingPtr() >>> 0;
  new Float64Array(mem.buffer, stagingPtr, payload.length).set(payload);

  const handle = w.handleAlloc();
  if (!handle) return null;

  const rc = w.nativeExtrudeBuildFromStaging(
    handle,
    loops.length,
    extrusionVector.x, extrusionVector.y, extrusionVector.z,
    plane.origin.x, plane.origin.y, plane.origin.z,
    plane.normal.x, plane.normal.y, plane.normal.z,
    refDir.x, refDir.y, refDir.z,
  );

  if (rc !== 0) {
    w.handleRelease(handle);
    return null;
  }

  if (typeof w.nativeShellValidateHandle === 'function') {
    const shellIssues = w.nativeShellValidateHandle(handle) >>> 0;
    if (shellIssues !== 0) {
      w.handleRelease(handle);
      return null;
    }
  }

  const edgeSegments = opts.edgeSegments ?? globalTessConfig.edgeSegments;
  const surfaceSegments = opts.surfaceSegments ?? globalTessConfig.surfaceSegments;
  const mesh = _tessellateHandleToGeometry(w, mem, handle, edgeSegments, surfaceSegments, sourceFeatureId);
  if (!mesh) {
    w.handleRelease(handle);
    return null;
  }

  if (topoBody) mesh.topoBody = topoBody;
  mesh.wasmHandleId = handle;
  mesh.wasmHandleResident = true;
  mesh.nativeExtrude = true;
  return mesh;
}

function _flattenLoops(loops) {
  const out = [];
  for (const loop of loops) {
    const points = loop?.points || [];
    const edges = loop?.edges || [];
    if (points.length < 3) return null;
    out.push(points.length, edges.length, loop.isOuter === false ? 0 : 1);
    for (const point of points) out.push(point.x, point.y, point.z);
    for (const edge of edges) {
      out.push(
        edge.type === 'arc' ? 1 : 0,
        edge.startIdx,
        edge.endIdx,
        edge.center?.x ?? 0,
        edge.center?.y ?? 0,
        edge.center?.z ?? 0,
        edge.radius ?? 0,
        edge.sweep ?? 0,
      );
    }
  }
  return new Float64Array(out);
}

function _tessellateHandleToGeometry(w, mem, handle, edgeSegments, surfaceSegments, sourceFeatureId) {
  const nTris = w.tessBuildHandleFaces(handle, edgeSegments, surfaceSegments);
  if (nTris < 0) return null;
  if (nTris === 0) return { vertices: [], faces: [], edges: [] };

  const nVerts = w.getTessOutVertCount() >>> 0;
  const buffer = mem.buffer;
  const verts = new Float64Array(buffer, w.getTessOutVertsPtr() >>> 0, nVerts * 3).slice();
  const norms = new Float64Array(buffer, w.getTessOutNormalsPtr() >>> 0, nVerts * 3).slice();
  const indices = new Uint32Array(buffer, w.getTessOutIndicesPtr() >>> 0, nTris * 3).slice();
  const faceMap = new Uint32Array(buffer, w.getTessOutFaceMapPtr() >>> 0, nTris).slice();

  const vertices = [];
  for (let i = 0; i < nVerts; i++) vertices.push(_readVec3(verts, i));

  const faces = [];
  for (let t = 0; t < nTris; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const nx = (norms[i0 * 3] + norms[i1 * 3] + norms[i2 * 3]) / 3;
    const ny = (norms[i0 * 3 + 1] + norms[i1 * 3 + 1] + norms[i2 * 3 + 1]) / 3;
    const nz = (norms[i0 * 3 + 2] + norms[i1 * 3 + 2] + norms[i2 * 3 + 2]) / 3;
    const nl = Math.hypot(nx, ny, nz) || 1;
    faces.push({
      vertices: [_readVec3(verts, i0), _readVec3(verts, i1), _readVec3(verts, i2)],
      normal: _cleanVec3({ x: nx / nl, y: ny / nl, z: nz / nl }),
      vertexNormals: [_readVec3(norms, i0), _readVec3(norms, i1), _readVec3(norms, i2)],
      faceGroup: faceMap[t],
      topoFaceId: faceMap[t],
      faceType: 'native-extrude',
      isCurved: false,
      surfaceInfo: null,
      shared: sourceFeatureId ? { sourceFeatureId } : null,
    });
  }

  return { vertices, faces, edges: [] };
}

function _readVec3(buffer, index) {
  const off = index * 3;
  return _cleanVec3({ x: buffer[off], y: buffer[off + 1], z: buffer[off + 2] });
}

function _cleanVec3(vector) {
  return {
    x: Math.abs(vector.x) < 1e-12 ? 0 : vector.x,
    y: Math.abs(vector.y) < 1e-12 ? 0 : vector.y,
    z: Math.abs(vector.z) < 1e-12 ? 0 : vector.z,
  };
}

export function nativeExtrudeStatus() {
  const w = _wasm;
  if (!w) return { ready: false };
  return {
    ready: isNativeExtrudeReady(),
    ok: _num(w.NATIVE_EXTRUDE_OK, 0),
    lastError: typeof w.nativeExtrudeGetLastError === 'function' ? w.nativeExtrudeGetLastError() : null,
    lastIssueEdge: typeof w.nativeExtrudeGetLastIssueEdge === 'function' ? w.nativeExtrudeGetLastIssueEdge() : null,
  };
}
