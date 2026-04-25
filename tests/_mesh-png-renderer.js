/**
 * tests/_mesh-png-renderer.js
 *
 * Minimal dependency-free PNG renderer for tessellated meshes.  Used by
 * tests/test-tess-dihedral-sweep.js (and friends) to dump a small isometric
 * preview of every test mesh — useful for visually verifying what each
 * combo actually produced.
 *
 * Triangle fill colour: |n|·0.45+0.35 with a soft directional shading
 * pass — the same scheme as the WebGL "normal-color" debug shader in
 * js/webgl-executor.js (Program 3).
 *
 * Edge colours:
 *   - white  : interior edge shared by exactly two triangles (manifold)
 *   - pink   : boundary edge (exactly 1 incident triangle — a hole)
 *   - red    : non-manifold edge (≥3 incident triangles)
 *
 * Background: neutral grey #808080.
 *
 * No external dependencies — uses only `fs`, `path`, `zlib`.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// ---------------------------------------------------------------------------
// Tiny PNG writer (RGB8, no palette, no alpha)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = Buffer.alloc(len + 12);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crcBuf = Buffer.alloc(4 + len);
  crcBuf.write(type, 0, 4, 'ascii');
  data.copy(crcBuf, 4);
  out.writeUInt32BE(crc32(crcBuf), 8 + len);
  return out;
}

function writePNG(filePath, width, height, rgb /* Uint8Array w*h*3 */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);     // bit depth
  ihdr.writeUInt8(2, 9);     // color type = RGB
  ihdr.writeUInt8(0, 10);    // compression
  ihdr.writeUInt8(0, 11);    // filter
  ihdr.writeUInt8(0, 12);    // interlace

  // Build raw scanlines with filter byte 0 (none) per row
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);

  fs.writeFileSync(filePath, Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const PREC = 6;
// Match MeshValidator.detectBoundaryEdges keying exactly so the PNG's
// pink/red highlights agree with the audit's boundaryCount.  In particular
// the `(+c.toFixed(PREC) || 0)` step normalises -0 → 0.
const _fmt = (c) => (+c.toFixed(PREC) || 0).toFixed(PREC);
const _vk = (v) => `${_fmt(v.x)},${_fmt(v.y)},${_fmt(v.z)}`;
const _ek = (a, b) => {
  const ka = _vk(a), kb = _vk(b);
  return ka < kb ? `${ka}::${kb}` : `${kb}::${ka}`;
};

/** Expand face fans into a flat triangle list with per-tri normal. */
function flattenTriangles(faces) {
  const tris = [];
  for (const face of faces) {
    const v = face.vertices;
    if (!v || v.length < 3) continue;
    const n = face.normal || { x: 0, y: 0, z: 1 };
    for (let i = 1; i < v.length - 1; i++) {
      tris.push({ a: v[0], b: v[i], c: v[i + 1], normal: n });
    }
  }
  return tris;
}

/** Count incidences per edge across the triangle list. */
function buildEdgeIncidence(tris) {
  const counts = new Map();
  for (const t of tris) {
    for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const k = _ek(a, b);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Camera / projection
// ---------------------------------------------------------------------------

/**
 * Standard isometric: rotate -45° around Y, then ~35.264° around X.
 * Returns a function that projects (x,y,z) to (px,py,depth) where px,py
 * are in world units (caller scales/translates to pixels) and depth is
 * along the camera -Z (larger = closer to viewer).
 */
function makeIsoProjector() {
  const ay = -Math.PI / 4;          // -45°
  const ax = Math.atan(1 / Math.SQRT2); // ~35.264°
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cx = Math.cos(ax), sx = Math.sin(ax);
  return (p) => {
    // rotate around Y
    const x1 =  cy * p.x + sy * p.z;
    const y1 =  p.y;
    const z1 = -sy * p.x + cy * p.z;
    // rotate around X
    const x2 = x1;
    const y2 = cx * y1 - sx * z1;
    const z2 = sx * y1 + cx * z1;
    return { x: x2, y: y2, z: z2 };
  };
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function fillTriangle(fb, zb, w, h, p0, p1, p2, color /* [r,g,b] 0..1 */) {
  // Bounding box
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;

  // Edge function setup
  const x0 = p0.x, y0 = p0.y;
  const x1 = p1.x, y1 = p1.y;
  const x2 = p2.x, y2 = p2.y;
  const denom = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(denom) < 1e-12) return; // degenerate
  const invDenom = 1 / denom;

  const r = Math.round(clamp01(color[0]) * 255);
  const g = Math.round(clamp01(color[1]) * 255);
  const b = Math.round(clamp01(color[2]) * 255);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const fx = px + 0.5, fy = py + 0.5;
      const w0 = ((x1 - fx) * (y2 - fy) - (x2 - fx) * (y1 - fy)) * invDenom;
      const w1 = ((x2 - fx) * (y0 - fy) - (x0 - fx) * (y2 - fy)) * invDenom;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const z = w0 * p0.z + w1 * p1.z + w2 * p2.z;
      const idxZ = py * w + px;
      if (z <= zb[idxZ]) continue;
      zb[idxZ] = z;
      const idx = idxZ * 3;
      fb[idx]     = r;
      fb[idx + 1] = g;
      fb[idx + 2] = b;
    }
  }
}

function drawLine(fb, zb, w, h, p0, p1, color, depthBias = 1e-3) {
  const r = Math.round(clamp01(color[0]) * 255);
  const g = Math.round(clamp01(color[1]) * 255);
  const b = Math.round(clamp01(color[2]) * 255);

  let x0 = Math.round(p0.x), y0 = Math.round(p0.y);
  const x1 = Math.round(p1.x), y1 = Math.round(p1.y);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const len = Math.max(1, Math.hypot(x1 - x0, y1 - y0));

  for (;;) {
    if (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h) {
      // Interpolate depth along the line for the depth test
      const t = Math.hypot(x0 - p0.x, y0 - p0.y) / len;
      const z = p0.z * (1 - t) + p1.z * t + depthBias;
      const idxZ = y0 * w + x0;
      if (z >= zb[idxZ]) {
        zb[idxZ] = z;
        const idx = idxZ * 3;
        fb[idx] = r; fb[idx + 1] = g; fb[idx + 2] = b;
      }
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const BG = [0x80 / 255, 0x80 / 255, 0x80 / 255]; // grey

const COLOR_INTERIOR = [1.0, 1.0, 1.0];          // white
const COLOR_BOUNDARY = [1.0, 0.4, 0.6];          // pink
const COLOR_NONMANIFOLD = [1.0, 0.0, 0.0];       // red

/**
 * Render geometry to a PNG at filePath.
 *
 * @param {object} geometry  — { faces: [{ vertices, normal }, ...] }
 * @param {string} filePath  — output path; parent dirs created as needed
 * @param {object} [opts]
 * @param {number} [opts.width=512]
 * @param {number} [opts.height=512]
 */
export function renderMeshToPNG(geometry, filePath, opts = {}) {
  const W = opts.width  || 512;
  const H = opts.height || 512;

  const tris = flattenTriangles(geometry?.faces || []);
  if (tris.length === 0) {
    // Still produce an empty grey image so the file exists.
    const fb = new Uint8Array(W * H * 3);
    for (let i = 0; i < fb.length; i += 3) {
      fb[i] = 0x80; fb[i + 1] = 0x80; fb[i + 2] = 0x80;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writePNG(filePath, W, H, fb);
    return;
  }

  const project = makeIsoProjector();

  // First pass — project all vertices, find bbox in screen space
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  const projTris = new Array(tris.length);
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    const a = project(t.a), b = project(t.b), c = project(t.c);
    if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
    if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
    if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
    if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y;
    if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
    if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    if (a.z < minZ) minZ = a.z; if (a.z > maxZ) maxZ = a.z;
    if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
    if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
    projTris[ti] = { a, b, c, normal: t.normal, src: t };
  }

  const margin = 16;
  const wWorld = Math.max(1e-6, maxX - minX);
  const hWorld = Math.max(1e-6, maxY - minY);
  const scale = Math.min((W - 2 * margin) / wWorld, (H - 2 * margin) / hWorld);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const ox = W / 2;
  const oy = H / 2;

  const toScreen = (p) => ({
    // Screen X grows right, screen Y grows down — flip Y
    x: ox + (p.x - cx) * scale,
    y: oy - (p.y - cy) * scale,
    z: p.z,
  });

  // Framebuffer
  const fb = new Uint8Array(W * H * 3);
  for (let i = 0; i < fb.length; i += 3) {
    fb[i]     = Math.round(BG[0] * 255);
    fb[i + 1] = Math.round(BG[1] * 255);
    fb[i + 2] = Math.round(BG[2] * 255);
  }
  // Depth buffer; larger z = closer.  Init to -Infinity.
  const zb = new Float32Array(W * H);
  zb.fill(-Infinity);

  // Light direction matching the WebGL Program 3 shader
  const lightDir = (() => {
    const lx = 0.3, ly = 0.5, lz = 0.8;
    const m = Math.hypot(lx, ly, lz);
    return { x: lx / m, y: ly / m, z: lz / m };
  })();

  // Pass 1 — fill triangles with normal-shaded color
  for (const pt of projTris) {
    const a = toScreen(pt.a), b = toScreen(pt.b), c = toScreen(pt.c);
    const n = pt.normal;
    const nm = Math.hypot(n.x, n.y, n.z) || 1;
    const nx = n.x / nm, ny = n.y / nm, nz = n.z / nm;
    const base = [
      Math.abs(nx) * 0.45 + 0.35,
      Math.abs(ny) * 0.45 + 0.35,
      Math.abs(nz) * 0.45 + 0.35,
    ];
    const ndotl = Math.max(0, nx * lightDir.x + ny * lightDir.y + nz * lightDir.z);
    const shade = 0.55 + ndotl * 0.45; // ambient + diffuse
    const col = [base[0] * shade, base[1] * shade, base[2] * shade];
    fillTriangle(fb, zb, W, H, a, b, c, col);
  }

  // Pass 2 — draw edges with classification
  const edgeCounts = buildEdgeIncidence(tris);
  const drawn = new Set();
  for (let ti = 0; ti < tris.length; ti++) {
    const pt = projTris[ti];
    const src = pt.src;
    const edges = [
      [src.a, src.b, pt.a, pt.b],
      [src.b, src.c, pt.b, pt.c],
      [src.c, src.a, pt.c, pt.a],
    ];
    for (const [va, vb, pa, pb] of edges) {
      const k = _ek(va, vb);
      if (drawn.has(k)) continue;
      drawn.add(k);
      const cnt = edgeCounts.get(k) || 0;
      const color = cnt === 1 ? COLOR_BOUNDARY
                  : cnt >= 3 ? COLOR_NONMANIFOLD
                  : COLOR_INTERIOR;
      const sa = toScreen(pa), sb = toScreen(pb);
      drawLine(fb, zb, W, H, sa, sb, color);
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writePNG(filePath, W, H, fb);
}

/**
 * Sanitise an arbitrary label into a filename-safe slug.
 */
export function slugifyLabel(s) {
  return String(s)
    .replace(/[°→]/g, '-')
    .replace(/[^a-zA-Z0-9._+-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
}
