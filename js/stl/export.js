// js/stl/export.js — STL mesh export (ASCII and binary)
import { info, error } from '../logger.js';

/**
 * Export triangle mesh data as an ASCII STL string.
 * @param {Float32Array} triangles - Interleaved [x,y,z,nx,ny,nz, ...] per vertex, 3 vertices per triangle
 * @param {number} vertexCount - Total number of vertices (triangleCount * 3)
 * @param {string} [name='part'] - Solid name for the STL header
 * @returns {string} ASCII STL content
 */
export function exportSTLAscii(triangles, vertexCount, name = 'part') {
  if (!triangles || vertexCount < 3) return '';
  const triCount = (vertexCount / 3) | 0;
  const lines = [`solid ${name}`];
  for (let t = 0; t < triCount; t++) {
    const base = t * 18; // 3 verts × 6 floats
    // Average face normal from vertex normals
    const nx = (triangles[base + 3] + triangles[base + 9] + triangles[base + 15]) / 3;
    const ny = (triangles[base + 4] + triangles[base + 10] + triangles[base + 16]) / 3;
    const nz = (triangles[base + 5] + triangles[base + 11] + triangles[base + 17]) / 3;
    lines.push(`  facet normal ${nx} ${ny} ${nz}`);
    lines.push('    outer loop');
    for (let v = 0; v < 3; v++) {
      const vb = base + v * 6;
      lines.push(`      vertex ${triangles[vb]} ${triangles[vb + 1]} ${triangles[vb + 2]}`);
    }
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

/**
 * Export triangle mesh data as a binary STL ArrayBuffer.
 * Binary STL is much smaller and faster for large meshes.
 * @param {Float32Array} triangles - Interleaved [x,y,z,nx,ny,nz, ...] per vertex
 * @param {number} vertexCount - Total number of vertices (triangleCount * 3)
 * @returns {ArrayBuffer} Binary STL data
 */
export function exportSTLBinary(triangles, vertexCount) {
  const triCount = (vertexCount / 3) | 0;
  // Binary STL: 80-byte header + 4-byte triangle count + 50 bytes per triangle
  const bufSize = 80 + 4 + triCount * 50;
  const buf = new ArrayBuffer(bufSize);
  const view = new DataView(buf);
  // Header (80 bytes) — fill with zeros (already default)
  const header = 'STL exported from CAD Modeller';
  for (let i = 0; i < header.length && i < 80; i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  // Triangle count
  view.setUint32(80, triCount, true);
  // Triangles
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const base = t * 18;
    // Face normal (average of vertex normals)
    const nx = (triangles[base + 3] + triangles[base + 9] + triangles[base + 15]) / 3;
    const ny = (triangles[base + 4] + triangles[base + 10] + triangles[base + 16]) / 3;
    const nz = (triangles[base + 5] + triangles[base + 11] + triangles[base + 17]) / 3;
    view.setFloat32(off, nx, true); off += 4;
    view.setFloat32(off, ny, true); off += 4;
    view.setFloat32(off, nz, true); off += 4;
    // 3 vertices
    for (let v = 0; v < 3; v++) {
      const vb = base + v * 6;
      view.setFloat32(off, triangles[vb], true); off += 4;
      view.setFloat32(off, triangles[vb + 1], true); off += 4;
      view.setFloat32(off, triangles[vb + 2], true); off += 4;
    }
    // Attribute byte count (unused, set to 0)
    view.setUint16(off, 0, true); off += 2;
  }
  return buf;
}

/**
 * Download an STL file from mesh triangle data.
 * @param {Float32Array} triangles - Interleaved vertex data
 * @param {number} vertexCount - Total vertex count
 * @param {Object} [opts]
 * @param {string} [opts.filename='part.stl']
 * @param {boolean} [opts.binary=true] - Use binary STL format (smaller)
 * @param {string} [opts.name='part'] - Solid name (ASCII mode)
 */
export function downloadSTL(triangles, vertexCount, opts = {}) {
  const { filename = 'part.stl', binary = true, name = 'part' } = opts;
  if (!triangles || vertexCount < 3) {
    error('STL export: no triangle data');
    return;
  }
  try {
    let blob;
    if (binary) {
      const buf = exportSTLBinary(triangles, vertexCount);
      blob = new Blob([buf], { type: 'application/octet-stream' });
    } else {
      const str = exportSTLAscii(triangles, vertexCount, name);
      blob = new Blob([str], { type: 'text/plain' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    info('STL download triggered', { filename, binary, triangles: (vertexCount / 3) | 0 });
  } catch (err) {
    error('STL download failed:', err);
  }
}
