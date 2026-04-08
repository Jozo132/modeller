import { exportSTLAscii, exportSTLBinary } from '../js/stl/export.js';

// Single triangle: vertices at (0,0,0), (1,0,0), (0,1,0) with normal (0,0,1)
const tri = new Float32Array([
  0, 0, 0,  0, 0, 1,
  1, 0, 0,  0, 0, 1,
  0, 1, 0,  0, 0, 1,
]);

// ASCII test
const ascii = exportSTLAscii(tri, 3, 'test');
console.log('=== ASCII STL ===');
console.log(ascii);

// Binary test
const bin = exportSTLBinary(tri, 3);
console.log('\n=== Binary STL ===');
console.log('Size:', bin.byteLength, 'bytes (expected:', 80 + 4 + 50, '= 134)');
const view = new DataView(bin);
console.log('Triangle count:', view.getUint32(80, true));
console.log('Normal:', view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true));
console.log('V0:', view.getFloat32(96, true), view.getFloat32(100, true), view.getFloat32(104, true));
console.log('V1:', view.getFloat32(108, true), view.getFloat32(112, true), view.getFloat32(116, true));
console.log('V2:', view.getFloat32(120, true), view.getFloat32(124, true), view.getFloat32(128, true));

// Two triangles (a quad)
const quad = new Float32Array([
  0, 0, 0,  0, 0, 1,
  1, 0, 0,  0, 0, 1,
  0, 1, 0,  0, 0, 1,
  1, 0, 0,  0, 0, 1,
  1, 1, 0,  0, 0, 1,
  0, 1, 0,  0, 0, 1,
]);
const quadBin = exportSTLBinary(quad, 6);
console.log('\nQuad binary size:', quadBin.byteLength, '(expected:', 80 + 4 + 100, '= 184)');
const qv = new DataView(quadBin);
console.log('Quad triangle count:', qv.getUint32(80, true));

// Edge cases
console.log('\nEmpty:', exportSTLAscii(null, 0));
console.log('OK');
