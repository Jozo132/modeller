// js/workers/tessellation-worker.js — Web Worker for off-main-thread tessellation
//
// Receives a TopoBody (structured-cloned) and tessellation options,
// runs tessellateBody / tessellateForSTL, and returns the resulting mesh
// with typed-array buffers transferred (zero-copy) back to the caller.
//
// Message protocol:
//   Request:  { body, options, mode: 'display'|'stl', _dispatchId }
//   Response: { type: 'result', vertices: Float32Array, indices: Uint32Array,
//               normals: Float32Array, faceCount, _dispatchId }
//   Error:    { type: 'error', message, stack, _dispatchId }

import { tessellateBody, tessellateForSTL } from '../cad/Tessellation.js';
import { telemetry } from '../telemetry.js';

/**
 * Pack a mesh result (vertices + faces with per-face normals) into
 * flat typed arrays suitable for GPU upload and Transferable posting.
 *
 * @param {{ vertices: Array, faces: Array<{vertices: Array<{x,y,z}>, normal?: {x,y,z}}> }} mesh
 * @returns {{ vertices: Float32Array, normals: Float32Array, faceCount: number }}
 */
function packMesh(mesh) {
  // Count total triangles for flat packing
  let triCount = 0;
  const faces = mesh.faces || mesh;
  for (const f of faces) {
    const v = f.vertices;
    if (v.length >= 3) triCount += v.length - 2;
  }

  const vertices = new Float32Array(triCount * 9); // 3 verts × 3 components
  const normals = new Float32Array(triCount * 9);
  let offset = 0;

  for (const f of faces) {
    const verts = f.vertices;
    const n = f.normal || { x: 0, y: 0, z: 1 };

    // Fan triangulation for n-gons
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[0], b = verts[i], c = verts[i + 1];

      vertices[offset]     = a.x; vertices[offset + 1] = a.y; vertices[offset + 2] = a.z;
      vertices[offset + 3] = b.x; vertices[offset + 4] = b.y; vertices[offset + 5] = b.z;
      vertices[offset + 6] = c.x; vertices[offset + 7] = c.y; vertices[offset + 8] = c.z;

      normals[offset]     = n.x; normals[offset + 1] = n.y; normals[offset + 2] = n.z;
      normals[offset + 3] = n.x; normals[offset + 4] = n.y; normals[offset + 5] = n.z;
      normals[offset + 6] = n.x; normals[offset + 7] = n.y; normals[offset + 8] = n.z;

      offset += 9;
    }
  }

  return { vertices, normals, faceCount: faces.length };
}

self.onmessage = function (e) {
  const { body, options = {}, mode = 'display', _dispatchId } = e.data;

  try {
    telemetry.startTimer('tessellation');

    let mesh;
    if (mode === 'stl') {
      mesh = tessellateForSTL(body, options);
    } else {
      mesh = tessellateBody(body, options);
    }

    const duration = telemetry.endTimer('tessellation');
    const packed = packMesh(mesh);

    // Transfer the typed arrays back (zero-copy)
    self.postMessage(
      {
        type: 'result',
        vertices: packed.vertices,
        normals: packed.normals,
        faceCount: packed.faceCount,
        duration,
        _dispatchId,
      },
      [packed.vertices.buffer, packed.normals.buffer],
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err.message || String(err),
      stack: err.stack || '',
      _dispatchId,
    });
  }
};
