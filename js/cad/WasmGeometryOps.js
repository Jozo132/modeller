// js/cad/WasmGeometryOps.js — Synchronous wrappers around preloaded WASM geometry ops.

import { loadReleaseWasmModule } from '../load-release-wasm.js';

let _wasm = null;
let _wasmMem = null;
let _wasmLoadPromise = null;

export async function preloadWasmGeometryOps() {
  if (_wasm) return true;
  if (!_wasmLoadPromise) {
    _wasmLoadPromise = (async () => {
      try {
        const mod = await loadReleaseWasmModule();
        _wasm = mod;
        _wasmMem = mod.memory;
        return true;
      } catch (_) {
        _wasm = null;
        _wasmMem = null;
        return false;
      }
    })();
  }
  return _wasmLoadPromise;
}

void preloadWasmGeometryOps();

export function sampleCylinderPlaneArcWasmReady({
  cylCenter,
  axisDir,
  radius,
  ex,
  ey,
  planePoint,
  planeNormal,
  startPt,
  endPt,
  segments = 12,
}) {
  if (!_wasm || !_wasmMem) return null;
  if (typeof _wasm.cylinderPlaneArcSample !== 'function'
    || typeof _wasm.getCylinderPlaneArcSamplePtr !== 'function') {
    return null;
  }
  const segCount = Math.max(1, Math.min(256, Math.floor(segments || 12)));
  const count = _wasm.cylinderPlaneArcSample(
    cylCenter.x, cylCenter.y, cylCenter.z,
    axisDir.x, axisDir.y, axisDir.z,
    radius,
    ex.x, ex.y, ex.z,
    ey.x, ey.y, ey.z,
    planePoint.x, planePoint.y, planePoint.z,
    planeNormal.x, planeNormal.y, planeNormal.z,
    startPt.x, startPt.y, startPt.z,
    endPt.x, endPt.y, endPt.z,
    segCount,
    1e-9,
  );
  if (!count || count < 2) return null;
  const out = new Float64Array(_wasmMem.buffer, _wasm.getCylinderPlaneArcSamplePtr(), count * 3);
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({ x: out[i * 3], y: out[i * 3 + 1], z: out[i * 3 + 2] });
  }
  return points;
}
